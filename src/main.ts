// Copyright (c) 2026 Sarthak Parulekar
// Licensed under MIT + Commons Clause — commercial use prohibited.

import {
  app,
  globalShortcut,
  ipcMain,
  type IpcMainInvokeEvent,
  shell,
} from 'electron';
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PythonServerManager,
  type PythonServerExitInfo,
} from './pythonServer';
import { SecureStore } from './secureStore';
import type {
  AppState,
  OverlayBounds,
  OverlayPreset,
  PublicSettings,
  StartSessionRequest,
} from './types/contracts';
import { WindowManager } from './windowManager';

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

function normalizeExternalUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid external URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs can be opened externally.');
  }

  return parsed.toString();
}

function isTrustedRendererUrl(rawUrl: string) {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  try {
    const parsed = new URL(rawUrl);

    if (devServerUrl) {
      return parsed.origin === new URL(devServerUrl).origin;
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

function requireFiniteNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function normalizeSettingsUpdates(
  updates: Partial<Omit<PublicSettings, 'apiKeyStored' | 'deepgramApiKeyStored'>>,
) {
  const normalized: Partial<Omit<PublicSettings, 'apiKeyStored' | 'deepgramApiKeyStored'>> = {};
  if (updates.language !== undefined) {
    normalized.language = String(updates.language).trim() || 'en';
  }
  if (updates.model !== undefined) {
    normalized.model = String(updates.model).trim() || 'llama-3.3-70b-versatile';
  }
  if (updates.overlayPreset !== undefined) {
    const preset = updates.overlayPreset as OverlayPreset;
    if (!['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(preset)) {
      throw new Error('Invalid overlay preset.');
    }
    normalized.overlayPreset = preset;
  }
  if (updates.overlayOpacity !== undefined) {
    normalized.overlayOpacity = Math.max(
      0.25,
      Math.min(requireFiniteNumber(updates.overlayOpacity, 'overlayOpacity'), 1),
    );
  }
  if (updates.historyEnabled !== undefined) {
    normalized.historyEnabled = Boolean(updates.historyEnabled);
  }
  return normalized;
}

async function logAppError(scope: string, error: unknown) {
  const message = `[${new Date().toISOString()}] ${scope}\n${formatError(error)}\n\n`;
  try {
    await fs.mkdir(userDataPath, { recursive: true });
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

  serverRestartTimeout = setTimeout(() => {
    serverRestartTimeout = null;
    void ensureServerReady('idle').catch(async (error) => {
      await logAppError('python-restart', error);
      scheduleServerRestart(
        'The local backend is still unavailable. WingMan will keep retrying.',
      );
    });
  }, 1200);
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
  updateState({
  });
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

async function startSession(config: StartSessionRequest) {
  await ensureServerReady('idle');
  const apiKey =
    config.apiKey?.trim() ||
    (await secureStore.getApiKey()) ||
    process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('A Groq API key is required before starting a session.');
  }

  const deepgramApiKey =
    config.deepgramApiKey?.trim() ||
    (await secureStore.getDeepgramApiKey()) ||
    '';
  if (!deepgramApiKey) {
    throw new Error('A Deepgram API key is required before starting a session.');
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
    return { ok: true };
  });
  ipcMain.handle('app:clear-api-key', async (event) => {
    assertTrustedSender(event);
    await secureStore.clearApiKey();
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
  ipcMain.handle('app:open-external', async (event, url: string) => {
    assertTrustedSender(event);
    await shell.openExternal(normalizeExternalUrl(url));
    return { ok: true };
  });
}

async function createApp() {
  app.setName('WingMan');
  installIpcHandlers();
  registerShortcuts();

  await bootstrapServer();

  const settings = await secureStore.getSettings();
  await windowManager.createWindows(
    settings.overlayPreset as OverlayPreset,
    settings.overlayOpacity,
  );
  updateState({
    sessionStatus: 'idle',
  });
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
  try {
    await pythonServer.shutdown();
  } finally {
    globalShortcut.unregisterAll();
    app.exit(exitCode);
  }
}

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
      webPreferences: { nodeIntegration: false },
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

process.on('uncaughtException', (error) => {
  console.error(error);
  void logAppError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  console.error(reason);
  void logAppError('unhandledRejection', reason);
});

app.on('activate', async () => {
  if (!windowManager.dashboardWindow && appState.serverReady) {
    const settings = await secureStore.getSettings();
    await windowManager.createWindows(
      settings.overlayPreset as OverlayPreset,
      settings.overlayOpacity,
    );
    updateState({});
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
