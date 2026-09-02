// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

import {
  app,
  globalShortcut,
  ipcMain,
  type IpcMainInvokeEvent,
  session,
  shell,
} from 'electron';
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentSecurityPolicy } from './csp';
import { getDevServerOrigin } from './devServer';
import {
  normalizeExternalUrl,
  normalizeSettingsUpdates,
  normalizeStartSessionRequest,
  requireFiniteNumber,
} from './validation';
import {
  PythonServerManager,
  type PythonServerExitInfo,
} from './pythonServer';
import { SecureStore } from './secureStore';
import {
  DEFAULT_ANSWER_MODEL,
  type AppState,
  type OverlayBounds,
  type OverlayPreset,
  type PublicSettings,
  type StartSessionRequest,
} from './types/contracts';
import { hardenWebContents, WindowManager } from './windowManager';

// Must run before requestSingleInstanceLock()/getPath('userData') below —
// both resolve against app.name, which otherwise defaults to package.json's
// "wingman" instead of the "WingMan" folder every other build/session uses.
app.setName('WingMan');

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (windowManager?.dashboardWindow) {
      if (windowManager.dashboardWindow.isMinimized()) {
        windowManager.dashboardWindow.restore();
      }
      windowManager.dashboardWindow.focus();
    }
  });
}

let isShuttingDown = false;

const userDataPath = app.getPath('userData');
const historyPath = path.join(userDataPath, 'history');
const logPath = path.join(userDataPath, 'wingman.log');
const preloadPath = path.join(__dirname, '../preload/preload.js');
const rendererIndexUrl = pathToFileURL(
  path.join(__dirname, '../renderer/index.html'),
).toString();
const secureStore = new SecureStore(userDataPath);
const windowManager = new WindowManager(preloadPath);
let serverStartPromise: Promise<void> | null = null;
let serverRestartTimeout: NodeJS.Timeout | null = null;

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'WindowsGraphicsCapture');
  app.commandLine.appendSwitch('enable-features', 'DirectCompositionVideoOverlays');
}

// Pins the renderer sandbox rather than depending on the Electron default.
app.enableSandbox();

function installSessionSecurity() {
  const defaultSession = session.defaultSession;

  // Only reaches the renderer in dev, where it loads over http. The packaged
  // build loads over file://, which has no response headers — that path is
  // covered by the <meta http-equiv> tag baked into index.html at build time.
  // See src/csp.ts.
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy(getDevServerOrigin())],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  // Electron grants camera, microphone, geolocation and notifications by
  // default when no handler is set. Audio capture happens in the Python
  // sidecar, so the renderer legitimately needs none of them.
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.setDevicePermissionHandler(() => false);
}

let appState: AppState = {
  serverReady: false,
  serverPort: null,
  serverToken: null,
  sessionStatus: 'booting',
  overlayVisible: true,
  overlayMinimized: false,
  currentSessionId: null,
  health: null,
  error: null,
};

function updateState(patch: Partial<AppState>) {
  appState = {
    ...appState,
    ...patch,
    ...windowManager.getStateMeta(),
  };
  windowManager.sendAppState(appState);
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`.trim();
  }

  return String(error);
}

function isTrustedRendererUrl(rawUrl: string) {
  // getDevServerOrigin() returns null in a packaged build regardless of the
  // environment, so a planted .env cannot widen what IPC will accept.
  const devServerOrigin = getDevServerOrigin();

  try {
    const parsed = new URL(rawUrl);

    if (devServerOrigin) {
      return parsed.origin === devServerOrigin;
    }

    return rawUrl.startsWith(rendererIndexUrl);
  } catch {
    return false;
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
    throw new Error('Rejected IPC call from an untrusted renderer.');
  }
}

// Without a cap, a permanently broken sidecar wrote a stack trace on every
// 1.2s retry — roughly 50 per minute, forever.
const MAX_LOG_BYTES = 2 * 1024 * 1024;

async function rotateLogIfNeeded() {
  try {
    const stats = await fs.stat(logPath);
    if (stats.size < MAX_LOG_BYTES) {
      return;
    }
    await fs.rename(logPath, `${logPath}.1`);
  } catch {
    // Missing file is the normal case on first write; a failed rename should
    // never stop the app from logging.
  }
}

async function logAppError(scope: string, error: unknown) {
  const message = `[${new Date().toISOString()}] ${scope}\n${formatError(error)}\n\n`;
  try {
    await fs.mkdir(userDataPath, { recursive: true });
    await rotateLogIfNeeded();
    await fs.appendFile(logPath, message, 'utf8');
  } catch (logError) {
    console.error('Failed to write WingMan log file.', logError);
  }
}

async function handleUnexpectedPythonExit(info: PythonServerExitInfo) {
  if (info.expected || isShuttingDown) {
    return;
  }

  const codeDetails =
    info.code === null ? 'The process exited unexpectedly.' : `Exit code ${info.code}.`;
  await logAppError('python-exit', codeDetails);
  scheduleServerRestart(
    'Lost connection to the local backend. WingMan is trying to reconnect.',
  );
}

const pythonServer = new PythonServerManager(app.isPackaged, {
  onExit: (info) => {
    void handleUnexpectedPythonExit(info);
  },
});

async function ensureServerReady(nextStatus: AppState['sessionStatus']) {
  if (serverStartPromise) {
    return serverStartPromise;
  }

  serverStartPromise = (async () => {
    const health = await pythonServer.start(historyPath);
    updateState({
      serverReady: true,
      serverPort: health.port,
      serverToken: pythonServer.getAuthToken(),
      sessionStatus: nextStatus,
      currentSessionId: nextStatus === 'idle' ? null : appState.currentSessionId,
      health,
      error: null,
    });
  })().finally(() => {
    serverStartPromise = null;
  });

  return serverStartPromise;
}

async function bootstrapServer() {
  await ensureServerReady('ready');
}

// Retrying every 1.2s forever re-spawned a process and wrote a stack trace ~50
// times a minute against a failure that is not going to resolve on its own
// (a quarantined binary, a missing interpreter). Back off, and stop logging
// every attempt once it is clear the failure is persistent.
const RESTART_BACKOFF_MS = [1_200, 2_000, 5_000, 15_000, 30_000, 60_000];
let serverRestartAttempts = 0;

function resetServerRestartBackoff() {
  serverRestartAttempts = 0;
}

function scheduleServerRestart(message: string) {
  updateState({
    serverReady: false,
    serverPort: null,
    serverToken: null,
    sessionStatus: 'error',
    currentSessionId: null,
    health: null,
    error: message,
  });

  if (serverRestartTimeout || isShuttingDown) {
    return;
  }

  const delay =
    RESTART_BACKOFF_MS[Math.min(serverRestartAttempts, RESTART_BACKOFF_MS.length - 1)];
  serverRestartAttempts += 1;

  serverRestartTimeout = setTimeout(() => {
    serverRestartTimeout = null;
    void ensureServerReady('idle')
      .then(resetServerRestartBackoff)
      .catch(async (error) => {
        // Only the first few failures are worth a stack trace; after that the
        // cause is established and the log is just growing.
        if (serverRestartAttempts <= RESTART_BACKOFF_MS.length) {
          await logAppError('python-restart', error);
        }
        scheduleServerRestart(
          'The local backend is still unavailable. WingMan will keep retrying.',
        );
      });
  }, delay);
}

function registerShortcut(
  label: string,
  accelerators: string[],
  handler: () => void,
) {
  const registered = accelerators.filter((accelerator) => {
    try {
      return globalShortcut.register(accelerator, handler);
    } catch (error) {
      void logAppError(
        'shortcut-register',
        `${label}: ${accelerator}\n${formatError(error)}`,
      );
      return false;
    }
  });

  if (registered.length === 0) {
    void logAppError(
      'shortcut-register',
      `Unable to register ${label}. Tried: ${accelerators.join(', ')}`,
    );
  }

  return registered;
}

function toggleOverlayVisibility() {
  windowManager.toggleOverlayVisibility();
  // Empty patch on purpose: updateState() re-reads live window metadata via
  // WindowManager.getStateMeta() and rebroadcasts it.
  updateState({});
}

function registerShortcuts() {
  registerShortcut(
    'toggle overlay',
    ['CommandOrControl+Shift+H', 'CommandOrControl+Alt+H'],
    toggleOverlayVisibility,
  );

  registerShortcut(
    'minimize overlay',
    ['CommandOrControl+Shift+M', 'CommandOrControl+Alt+M'],
    () => {
      windowManager.toggleOverlayMinimize();
      updateState({});
    },
  );

  registerShortcut('focus manual input', ['CommandOrControl+Shift+Space'], () => {
    windowManager.focusOverlayInput();
  });
}

interface ModelCatalogCache {
  fetchedAt: number;
  catalog: { models: string[]; recommended: string };
}

let modelCatalogCache: ModelCatalogCache | null = null;
let modelCatalogInFlight: Promise<ModelCatalogCache['catalog']> | null = null;
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * Both windows run the same renderer hook, so an uncached call meant several
 * round trips to Groq every launch for a list that changes maybe monthly.
 */
async function listModels() {
  const cached = modelCatalogCache;
  if (cached && Date.now() - cached.fetchedAt < MODEL_CATALOG_TTL_MS) {
    return cached.catalog;
  }

  if (modelCatalogInFlight) {
    return modelCatalogInFlight;
  }

  modelCatalogInFlight = (async () => {
    const apiKey =
      (await secureStore.getApiKey()) || process.env.GROQ_API_KEY?.trim() || '';
    if (!apiKey) {
      return { models: [], recommended: DEFAULT_ANSWER_MODEL };
    }

    await ensureServerReady(appState.sessionStatus);
    const catalog = await pythonServer.request<{
      models: string[];
      recommended: string;
    }>('/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    });

    // Only a real answer is worth caching; an empty list usually means the key
    // was missing or the lookup failed, and should be retried.
    if (catalog.models.length > 0) {
      modelCatalogCache = { fetchedAt: Date.now(), catalog };
    }
    return catalog;
  })().finally(() => {
    modelCatalogInFlight = null;
  });

  return modelCatalogInFlight;
}

async function startSession(rawConfig: StartSessionRequest) {
  const config = normalizeStartSessionRequest(rawConfig);
  await ensureServerReady('idle');
  const apiKey =
    config.apiKey?.trim() ||
    (await secureStore.getApiKey()) ||
    process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('A Groq API key is required before starting a session.');
  }

  const provider = config.transcriptionProvider;

  const deepgramApiKey =
    config.deepgramApiKey?.trim() ||
    (await secureStore.getDeepgramApiKey()) ||
    '';
  // Only the opt-in Deepgram provider needs a second key; the default Groq
  // provider transcribes with the key that already generates answers.
  if (provider === 'deepgram' && !deepgramApiKey) {
    throw new Error(
      'A Deepgram API key is required for the Deepgram provider. Switch to Groq transcription to run on a single key.',
    );
  }

  if (config.apiKey?.trim()) {
    await secureStore.saveApiKey(config.apiKey.trim());
  }
  if (config.deepgramApiKey?.trim()) {
    await secureStore.saveDeepgramApiKey(config.deepgramApiKey.trim());
  }

  const response = await pythonServer.request<{
    session_id: string;
    status: AppState['sessionStatus'];
  }>('/session/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resume_text: config.resumeText,
      extra_context: config.extraContext,
      language: config.language,
      model: config.model,
      history_enabled: config.historyEnabled,
      transcription_provider: provider,
      api_key: apiKey,
      deepgram_api_key: deepgramApiKey,
    }),
  });

  windowManager.positionOverlay(config.overlayPreset);
  windowManager.setOverlayOpacity(config.overlayOpacity);
  await secureStore.updateSettings({
    language: config.language,
    model: config.model,
    overlayPreset: config.overlayPreset,
    overlayOpacity: config.overlayOpacity,
    historyEnabled: config.historyEnabled,
    transcriptionProvider: provider,
  });

  updateState({
    sessionStatus: response.status,
    currentSessionId: response.session_id,
    error: null,
  });

  return response;
}

async function stopSession() {
  if (!pythonServer.isRunning()) {
    updateState({
      sessionStatus: 'stopped',
      currentSessionId: null,
      error: null,
    });
    return { status: 'stopped' as AppState['sessionStatus'] };
  }

  const response = await pythonServer.request<{ status: AppState['sessionStatus'] }>(
    '/session/stop',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );

  updateState({
    sessionStatus: response.status,
    currentSessionId: null,
    error: null,
  });

  return response;
}

function installIpcHandlers() {
  ipcMain.handle('app:get-state', async (event) => {
    assertTrustedSender(event);
    return appState;
  });
  ipcMain.handle('app:get-settings', async (event) => {
    assertTrustedSender(event);
    return secureStore.getSettings();
  });
  ipcMain.handle(
    'app:save-settings',
    async (
      event,
      updates: Partial<Omit<PublicSettings, 'apiKeyStored' | 'deepgramApiKeyStored'>>,
    ) => {
      assertTrustedSender(event);
      const normalizedUpdates = normalizeSettingsUpdates(updates);
      const nextSettings = await secureStore.updateSettings(normalizedUpdates);
      if (normalizedUpdates.overlayPreset !== undefined) {
        windowManager.positionOverlay(nextSettings.overlayPreset as OverlayPreset);
      }
      if (normalizedUpdates.overlayOpacity !== undefined) {
        windowManager.setOverlayOpacity(nextSettings.overlayOpacity);
      }
      return nextSettings;
    },
  );
  ipcMain.handle('app:save-api-key', async (event, apiKey: string) => {
    assertTrustedSender(event);
    await secureStore.saveApiKey(apiKey);
    modelCatalogCache = null;
    return { ok: true };
  });
  ipcMain.handle('app:clear-api-key', async (event) => {
    assertTrustedSender(event);
    await secureStore.clearApiKey();
    modelCatalogCache = null;
    return { ok: true };
  });
  ipcMain.handle('app:save-deepgram-api-key', async (event, apiKey: string) => {
    assertTrustedSender(event);
    await secureStore.saveDeepgramApiKey(apiKey);
    return { ok: true };
  });
  ipcMain.handle('app:clear-deepgram-api-key', async (event) => {
    assertTrustedSender(event);
    await secureStore.clearDeepgramApiKey();
    return { ok: true };
  });
  ipcMain.handle('session:start', async (event, config: StartSessionRequest) => {
    assertTrustedSender(event);
    updateState({ sessionStatus: 'starting', error: null });
    try {
      const response = await startSession(config);
      return response;
    } catch (error) {
      updateState({
        sessionStatus: 'error',
        error: error instanceof Error ? error.message : 'Failed to start session.',
      });
      throw error;
    }
  });
  ipcMain.handle('session:stop', async (event) => {
    assertTrustedSender(event);
    return stopSession();
  });
  ipcMain.handle('overlay:toggle', async (event) => {
    assertTrustedSender(event);
    windowManager.toggleOverlayVisibility();
    updateState({});
    return appState;
  });
  ipcMain.handle('overlay:minimize', async (event) => {
    assertTrustedSender(event);
    windowManager.toggleOverlayMinimize();
    updateState({});
    return appState;
  });
  ipcMain.handle('overlay:move', async (event, bounds: { x: number; y: number }) => {
    assertTrustedSender(event);
    windowManager.moveOverlay(
      Math.round(requireFiniteNumber(bounds?.x, 'x')),
      Math.round(requireFiniteNumber(bounds?.y, 'y')),
    );
    updateState({});
    return appState;
  });
  ipcMain.handle('overlay:set-bounds', async (event, bounds: OverlayBounds) => {
    assertTrustedSender(event);
    windowManager.setOverlayBounds({
      x: Math.round(requireFiniteNumber(bounds?.x, 'x')),
      y: Math.round(requireFiniteNumber(bounds?.y, 'y')),
      width: Math.round(requireFiniteNumber(bounds?.width, 'width')),
      height: Math.round(requireFiniteNumber(bounds?.height, 'height')),
    });
    updateState({});
    return appState;
  });
  ipcMain.handle(
    'overlay:resize',
    async (event, size: { width: number; height: number }) => {
      assertTrustedSender(event);
      windowManager.resizeOverlay(
        Math.round(requireFiniteNumber(size?.width, 'width')),
        Math.round(requireFiniteNumber(size?.height, 'height')),
      );
      updateState({});
      return appState;
    },
  );
  ipcMain.handle('overlay:set-opacity', async (event, opacity: number) => {
    assertTrustedSender(event);
    windowManager.setOverlayOpacity(requireFiniteNumber(opacity, 'opacity'));
    updateState({});
    return appState;
  });
  ipcMain.handle('overlay:release-focus', async (event) => {
    assertTrustedSender(event);
    windowManager.releaseOverlayFocus();
    return { ok: true };
  });
  ipcMain.handle('history:open-folder', async (event) => {
    assertTrustedSender(event);
    await shell.openPath(historyPath);
    return { path: historyPath };
  });
  ipcMain.handle('app:list-models', async (event) => {
    assertTrustedSender(event);
    return listModels();
  });
  ipcMain.handle('app:open-external', async (event, url: string) => {
    assertTrustedSender(event);
    await shell.openExternal(normalizeExternalUrl(url));
    return { ok: true };
  });
}

async function createApp() {
  installSessionSecurity();
  installIpcHandlers();
  registerShortcuts();

  // Windows first, sidecar second.
  //
  // This used to await bootstrapServer() before creating any window, so a
  // sidecar that failed to start on the *first* launch — the Defender
  // quarantine case the error dialog itself warns about — skipped window
  // creation entirely and quit permanently, even though the app retries
  // forever for the identical failure mid-session. Now the UI comes up, shows
  // the error, and scheduleServerRestart() drives the same retry loop.
  const settings = await secureStore.getSettings();
  await windowManager.createWindows(
    settings.overlayPreset as OverlayPreset,
    settings.overlayOpacity,
  );

  try {
    await bootstrapServer();
    updateState({ sessionStatus: 'idle' });
  } catch (error) {
    await logAppError('startup-server', error);
    scheduleServerRestart(
      `${describeStartupFailure(error)} WingMan will keep retrying.`,
    );
  }
}

function describeStartupFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return `The local backend could not start: ${message}`;
}

async function shutdownAndQuit(exitCode = 0) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  if (serverRestartTimeout) {
    clearTimeout(serverRestartTimeout);
    serverRestartTimeout = null;
  }

  // Before the shutdown await, not after: pythonServer.shutdown() can block for
  // seconds, and leaving the global accelerators live that whole time means a
  // stray hotkey drives a half-torn-down app.
  globalShortcut.unregisterAll();

  try {
    await pythonServer.shutdown();
  } finally {
    app.exit(exitCode);
  }
}

// Catches every webContents, including ones created outside WindowManager (the
// startup error window, and anything added later), so navigation lockdown can
// never be forgotten at a new call site.
app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents, isTrustedRendererUrl);
});

app.whenReady().then(async () => {
  try {
    await createApp();
  } catch (error) {
    console.error('[wingman] Fatal startup error:', error);
    await logAppError('startup', error);

    const message = error instanceof Error ? error.message : String(error);

    try {
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(
        logPath,
        `[${new Date().toISOString()}] Fatal error:\n${formatError(error)}\n`,
        'utf8',
      );
    } catch {
      // Ignore log write failures in the startup error path.
    }

    const { BrowserWindow } = await import('electron');
    const errWin = new BrowserWindow({
      width: 580,
      height: 280,
      show: true,
      resizable: false,
      title: 'WingMan - Error',
      backgroundColor: '#05070c',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const escapedMessage = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const escapedLogPath = logPath
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:2rem;background:#05070c;font-family:system-ui,sans-serif;color:#f8fafc"><div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem"><span style="font-size:2rem">Error</span><h2 style="margin:0;color:#fca5a5;font-size:1.25rem">WingMan failed to start</h2></div><p style="margin:0 0 1rem;color:#cbd5e1;font-size:0.875rem">${escapedMessage}</p><p style="margin:0;color:#64748b;font-size:0.8rem">Logs: ${escapedLogPath}</p><p style="margin:0.75rem 0 0;color:#64748b;font-size:0.8rem">Check that wingman-server.exe is not blocked by Windows Defender or antivirus.</p></body></html>`;

    await errWin.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );

    errWin.on('closed', () => {
      void shutdownAndQuit(1);
    });
  }
});

// Electron's default for an uncaught exception is a dialog and exit. Replacing
// it with a silent log meant the app kept running in an undefined state with no
// signal to the user at all. Surface it, and let them decide.
process.on('uncaughtException', (error) => {
  console.error(error);
  void logAppError('uncaughtException', error);

  if (isShuttingDown) {
    return;
  }

  updateState({
    error: `WingMan hit an unexpected error: ${
      error instanceof Error ? error.message : String(error)
    }. Details are in ${logPath}.`,
  });
});

process.on('unhandledRejection', (reason) => {
  console.error(reason);
  void logAppError('unhandledRejection', reason);
});

// createWindows() overwrites dashboardWindow/overlayWindow unconditionally, so
// two rapid activations would leak the first pair.
let activateInFlight = false;

app.on('activate', async () => {
  if (activateInFlight || windowManager.dashboardWindow || !appState.serverReady) {
    return;
  }

  activateInFlight = true;
  try {
    const settings = await secureStore.getSettings();
    await windowManager.createWindows(
      settings.overlayPreset as OverlayPreset,
      settings.overlayOpacity,
    );
    updateState({});
  } catch (error) {
    await logAppError('activate', error);
  } finally {
    activateInFlight = false;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void shutdownAndQuit();
  }
});

app.on('before-quit', (event) => {
  if (isShuttingDown) {
    return;
  }

  event.preventDefault();
  void shutdownAndQuit();
});
