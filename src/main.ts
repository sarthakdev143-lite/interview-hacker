import {
  app,
  globalShortcut,
  ipcMain,
  shell,
} from 'electron';
import path from 'node:path';
import { PythonServerManager } from './pythonServer';
import { SecureStore } from './secureStore';
import type {
  AppState,
  OverlayPreset,
  PublicSettings,
  StartSessionRequest,
} from './types/contracts';
import { WindowManager } from './windowManager';

let isShuttingDown = false;

const userDataPath = app.getPath('userData');
const historyPath = path.join(userDataPath, 'history');
const preloadPath = path.join(__dirname, '../preload/preload.js');
const secureStore = new SecureStore(userDataPath);
const pythonServer = new PythonServerManager(app.isPackaged);
const windowManager = new WindowManager(preloadPath);

let appState: AppState = {
  serverReady: false,
  serverPort: null,
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

async function bootstrapServer() {
  const health = await pythonServer.start(historyPath);
  updateState({
    serverReady: true,
    serverPort: health.port,
    sessionStatus: 'ready',
    health,
    error: null,
  });
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    windowManager.toggleOverlayVisibility();
    updateState({});
  });

  globalShortcut.register('CommandOrControl+Shift+M', () => {
    windowManager.toggleOverlayMinimize();
    updateState({});
  });

  globalShortcut.register('/', () => {
    windowManager.focusOverlayInput();
  });
}

async function startSession(config: StartSessionRequest) {
  const apiKey = config.apiKey?.trim() || (await secureStore.getApiKey());
  if (!apiKey) {
    throw new Error('A Groq API key is required before starting a session.');
  }

  if (config.apiKey?.trim()) {
    await secureStore.saveApiKey(config.apiKey.trim());
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
    }),
  });

  windowManager.positionOverlay(config.overlayPreset);
  await secureStore.updateSettings({
    language: config.language,
    model: config.model,
    overlayPreset: config.overlayPreset,
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
  ipcMain.handle('app:get-state', async () => appState);
  ipcMain.handle('app:get-settings', async () => secureStore.getSettings());
  ipcMain.handle(
    'app:save-settings',
    async (_, updates: Partial<Omit<PublicSettings, 'apiKeyStored'>>) =>
      secureStore.updateSettings(updates),
  );
  ipcMain.handle('app:save-api-key', async (_, apiKey: string) => {
    await secureStore.saveApiKey(apiKey);
    return { ok: true };
  });
  ipcMain.handle('app:clear-api-key', async () => {
    await secureStore.clearApiKey();
    return { ok: true };
  });
  ipcMain.handle('session:start', async (_, config: StartSessionRequest) => {
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
  ipcMain.handle('session:stop', async () => stopSession());
  ipcMain.handle('overlay:toggle', async () => {
    windowManager.toggleOverlayVisibility();
    updateState({});
    return appState;
  });
  ipcMain.handle('overlay:minimize', async () => {
    windowManager.toggleOverlayMinimize();
    updateState({});
    return appState;
  });
  ipcMain.handle('overlay:move', async (_, bounds: { x: number; y: number }) => {
    windowManager.moveOverlay(bounds.x, bounds.y);
    updateState({});
    return appState;
  });
  ipcMain.handle(
    'overlay:resize',
    async (_, size: { width: number; height: number }) => {
      windowManager.resizeOverlay(size.width, size.height);
      updateState({});
      return appState;
    },
  );
  ipcMain.handle('overlay:release-focus', async () => {
    windowManager.releaseOverlayFocus();
    return { ok: true };
  });
  ipcMain.handle('history:open-folder', async () => {
    await shell.openPath(historyPath);
    return { path: historyPath };
  });
  ipcMain.handle('app:open-external', async (_, url: string) => {
    await shell.openExternal(url);
    return { ok: true };
  });
}

async function createApp() {
  app.setName('WingMan');
  installIpcHandlers();
  registerShortcuts();

  await bootstrapServer();

  const settings = await secureStore.getSettings();
  await windowManager.createWindows(settings.overlayPreset as OverlayPreset);
  updateState({
    sessionStatus: 'idle',
  });
}

async function shutdownAndQuit() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  try {
    await pythonServer.shutdown();
  } finally {
    globalShortcut.unregisterAll();
    app.exit();
  }
}

app.whenReady().then(async () => {
  try {
    await createApp();
  } catch (error) {
    console.error(error);
    updateState({
      sessionStatus: 'error',
      error: error instanceof Error ? error.message : 'Failed to bootstrap WingMan.',
    });
    await shutdownAndQuit();
  }
});

app.on('activate', async () => {
  if (!windowManager.dashboardWindow && appState.serverReady) {
    const settings = await secureStore.getSettings();
    await windowManager.createWindows(settings.overlayPreset as OverlayPreset);
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
