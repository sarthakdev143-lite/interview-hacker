export type OverlayPreset =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left';

export type SessionStatus =
  | 'booting'
  | 'ready'
  | 'idle'
  | 'starting'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'answering'
  | 'done'
  | 'stopped'
  | 'error';

export interface StartSessionRequest {
  resumeText: string;
  extraContext: string;
  language: string;
  model: string;
  overlayPreset: OverlayPreset;
  overlayOpacity: number;
  historyEnabled: boolean;
  apiKey?: string;
  deepgramApiKey?: string;
}

export interface PublicSettings {
  language: string;
  model: string;
  overlayPreset: OverlayPreset;
  overlayOpacity: number;
  historyEnabled: boolean;
  apiKeyStored: boolean;
  deepgramApiKeyStored: boolean;
}

export interface HistoryExchange {
  question: string;
  answer: string;
  timestamp: string;
}

export interface SessionHistoryRecord {
  session_id: string;
  date: string;
  duration_seconds: number;
  exchanges: HistoryExchange[];
}

export interface HealthPayload {
  status: 'ok';
  port: number;
  platform: string;
  audio: {
    ready: boolean;
    message: string;
    suggested_device?: string | null;
  };
}

export interface AppState {
  serverReady: boolean;
  serverPort: number | null;
  serverToken: string | null;
  sessionStatus: SessionStatus;
  overlayVisible: boolean;
  overlayMinimized: boolean;
  currentSessionId: string | null;
  health: HealthPayload | null;
  error: string | null;
}

export interface TranscriptEventPayload {
  type: 'transcript' | 'status';
  text?: string;
  is_question?: boolean;
  status?: SessionStatus;
}

export interface AnswerEventPayload {
  type: 'token' | 'done' | 'status';
  text?: string;
  status?: SessionStatus;
}

export interface WingmanApi {
  getAppState: () => Promise<AppState>;
  getSettings: () => Promise<PublicSettings>;
  saveSettings: (
    settings: Partial<Omit<PublicSettings, 'apiKeyStored' | 'deepgramApiKeyStored'>>,
  ) => Promise<PublicSettings>;
  saveApiKey: (apiKey: string) => Promise<{ ok: true }>;
  clearApiKey: () => Promise<{ ok: true }>;
  saveDeepgramApiKey: (apiKey: string) => Promise<{ ok: true }>;
  clearDeepgramApiKey: () => Promise<{ ok: true }>;
  startSession: (
    config: StartSessionRequest,
  ) => Promise<{ session_id: string; status: SessionStatus }>;
  stopSession: () => Promise<{ status: SessionStatus }>;
  toggleOverlay: () => Promise<AppState>;
  minimizeOverlay: () => Promise<AppState>;
  moveOverlay: (bounds: { x: number; y: number }) => Promise<AppState>;
  resizeOverlay: (size: { width: number; height: number }) => Promise<AppState>;
  setOverlayOpacity: (opacity: number) => Promise<AppState>;
  releaseOverlayFocus: () => Promise<{ ok: true }>;
  openHistoryFolder: () => Promise<{ path: string }>;
  openExternal: (url: string) => Promise<{ ok: true }>;
  onAppState: (listener: (state: AppState) => void) => () => void;
  onOverlayFocusInput: (listener: () => void) => () => void;
}
