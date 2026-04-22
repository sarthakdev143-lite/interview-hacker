import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppState,
  PublicSettings,
  StartSessionRequest,
  WingmanApi,
} from './types/contracts';

const api: WingmanApi = {
  getAppState: () => ipcRenderer.invoke('app:get-state'),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  saveSettings: (settings: Partial<Omit<PublicSettings, 'apiKeyStored'>>) =>
    ipcRenderer.invoke('app:save-settings', settings),
  saveApiKey: (apiKey: string) => ipcRenderer.invoke('app:save-api-key', apiKey),
  clearApiKey: () => ipcRenderer.invoke('app:clear-api-key'),
  startSession: (config: StartSessionRequest) =>
    ipcRenderer.invoke('session:start', config),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  minimizeOverlay: () => ipcRenderer.invoke('overlay:minimize'),
  moveOverlay: (bounds: { x: number; y: number }) =>
    ipcRenderer.invoke('overlay:move', bounds),
  resizeOverlay: (size: { width: number; height: number }) =>
    ipcRenderer.invoke('overlay:resize', size),
  setOverlayOpacity: (opacity: number) =>
    ipcRenderer.invoke('overlay:set-opacity', opacity),
  releaseOverlayFocus: () => ipcRenderer.invoke('overlay:release-focus'),
  openHistoryFolder: () => ipcRenderer.invoke('history:open-folder'),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  onAppState: (listener: (state: AppState) => void) => {
    const wrapped = (_event: unknown, state: AppState) => listener(state);
    ipcRenderer.on('app:state', wrapped);
    return () => {
      ipcRenderer.removeListener('app:state', wrapped);
    };
  },
  onOverlayFocusInput: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on('overlay:focus-input', wrapped);
    return () => {
      ipcRenderer.removeListener('overlay:focus-input', wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('wingman', api);
