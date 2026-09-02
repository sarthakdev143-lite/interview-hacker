export type OverlayPreset =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left';

/**
 * The runtime counterpart to `OverlayPreset`, for validating a value that
 * arrived from the renderer. main.ts previously repeated this list as an inline
 * literal, which is free to drift from the type above without TypeScript
 * noticing — the same class of duplication that broke the model IDs.
 */
export const OVERLAY_PRESETS: OverlayPreset[] = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
];

/**
 * `groq` segments audio locally and only uploads speech, so it reuses the Groq
 * key and costs nothing on the free tier. `deepgram` is lower latency but
 * needs a second paid key and bills for connection time.
 */
export type TranscriptionProvider = 'groq' | 'deepgram';

export const TRANSCRIPTION_PROVIDERS: TranscriptionProvider[] = ['groq', 'deepgram'];

/**
 * Groq retires model IDs periodically, so this is only the starting point.
 * The picker is repopulated from the account's live model list at runtime.
 */
export const DEFAULT_ANSWER_MODEL = 'openai/gpt-oss-120b';

export interface ModelCatalog {
  models: string[];
  recommended: string;
}

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
  transcriptionProvider: TranscriptionProvider;
  apiKey?: string;
  deepgramApiKey?: string;
}

export interface PublicSettings {
  language: string;
  model: string;
  overlayPreset: OverlayPreset;
  overlayOpacity: number;
  historyEnabled: boolean;
  transcriptionProvider: TranscriptionProvider;
  apiKeyStored: boolean;
  deepgramApiKeyStored: boolean;
}

/** Running spend for the active session, measured by the Python backend. */
export interface UsageSnapshot {
  provider: string;
  audio_seconds: number;
  stt_requests: number;
  stt_usd: number;
  llm_requests: number;
  input_tokens: number;
  output_tokens: number;
  llm_usd: number;
  estimated_usd: number;
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
  capture_warning: boolean;
  transcription_providers?: string[];
  default_transcription_provider?: string;
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

export interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TranscriptEventPayload {
  type: 'transcript' | 'status' | 'usage' | 'error' | 'notice';
  text?: string;
  is_question?: boolean;
  interim?: boolean;
  status?: SessionStatus;
  usage?: UsageSnapshot;
  message?: string;
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
  setOverlayBounds: (bounds: OverlayBounds) => Promise<AppState>;
  moveOverlay: (bounds: { x: number; y: number }) => Promise<AppState>;
  resizeOverlay: (size: { width: number; height: number }) => Promise<AppState>;
  setOverlayOpacity: (opacity: number) => Promise<AppState>;
  releaseOverlayFocus: () => Promise<{ ok: true }>;
  openHistoryFolder: () => Promise<{ path: string }>;
  openExternal: (url: string) => Promise<{ ok: true }>;
  listModels: () => Promise<ModelCatalog>;
  onAppState: (listener: (state: AppState) => void) => () => void;
  onOverlayFocusInput: (listener: () => void) => () => void;
}
