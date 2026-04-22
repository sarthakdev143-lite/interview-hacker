import { useEffect, useMemo, useState } from 'react';
import { getServerBaseUrl, loadHistory, uploadResume } from '../lib/backend';
import type {
  AppState,
  PublicSettings,
  SessionHistoryRecord,
  StartSessionRequest,
} from '../types/contracts';

export interface SessionDraft extends StartSessionRequest {
  apiKeyInput: string;
}

const defaultSettings: PublicSettings = {
  language: 'en',
  model: 'llama-3.3-70b-versatile',
  overlayPreset: 'bottom-right',
  overlayOpacity: 0.95,
  historyEnabled: false,
  apiKeyStored: false,
};

const defaultAppState: AppState = {
  serverReady: false,
  serverPort: null,
  sessionStatus: 'booting',
  overlayVisible: true,
  overlayMinimized: false,
  currentSessionId: null,
  health: null,
  error: null,
};

export function useSession() {
  const [appState, setAppState] = useState<AppState>(defaultAppState);
  const [settings, setSettings] = useState<PublicSettings>(defaultSettings);
  const [history, setHistory] = useState<SessionHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [draft, setDraft] = useState<SessionDraft>({
    resumeText: '',
    extraContext: '',
    language: defaultSettings.language,
    model: defaultSettings.model,
    overlayPreset: defaultSettings.overlayPreset,
    overlayOpacity: defaultSettings.overlayOpacity,
    historyEnabled: defaultSettings.historyEnabled,
    apiKeyInput: '',
  });

  useEffect(() => {
    void window.wingman.setOverlayOpacity(draft.overlayOpacity);
  }, [draft.overlayOpacity]);

  useEffect(() => {
    let isActive = true;

    async function boot() {
      try {
        const [nextState, nextSettings] = await Promise.all([
          window.wingman.getAppState(),
          window.wingman.getSettings(),
        ]);

        if (!isActive) {
          return;
        }

        setAppState(nextState);
        setSettings(nextSettings);
        setDraft((current) => ({
          ...current,
          language: nextSettings.language,
          model: nextSettings.model,
          overlayPreset: nextSettings.overlayPreset,
          overlayOpacity: nextSettings.overlayOpacity,
          historyEnabled: nextSettings.historyEnabled,
        }));
      } catch (error) {
        if (!isActive) {
          return;
        }

        setActionError(
          error instanceof Error ? error.message : 'Failed to initialize WingMan.',
        );
      }
    }

    void boot();

    const unsubscribe = window.wingman.onAppState((nextState) => {
      if (!isActive) {
        return;
      }
      setAppState(nextState);
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!appState.serverPort) {
      return;
    }

    let isActive = true;

    async function refreshHistory() {
      setHistoryLoading(true);
      try {
        const response = await loadHistory(appState.serverPort as number);
        if (isActive) {
          setHistory(response.sessions);
        }
      } catch (error) {
        if (isActive) {
          setActionError(
            error instanceof Error
              ? error.message
              : 'Failed to load saved session history.',
          );
        }
      } finally {
        if (isActive) {
          setHistoryLoading(false);
        }
      }
    }

    void refreshHistory();

    return () => {
      isActive = false;
    };
  }, [appState.serverPort, appState.currentSessionId]);

  const serverBaseUrl = useMemo(
    () => getServerBaseUrl(appState.serverPort),
    [appState.serverPort],
  );

  const canStart =
    Boolean(draft.resumeText.trim() || draft.extraContext.trim()) &&
    Boolean(settings.apiKeyStored || draft.apiKeyInput.trim());

  const sessionRunning =
    appState.sessionStatus !== 'idle' &&
    appState.sessionStatus !== 'ready' &&
    appState.sessionStatus !== 'stopped' &&
    appState.sessionStatus !== 'error';

  async function savePreferences() {
    const nextSettings = await window.wingman.saveSettings({
      language: draft.language,
      model: draft.model,
      overlayPreset: draft.overlayPreset,
      overlayOpacity: draft.overlayOpacity,
      historyEnabled: draft.historyEnabled,
    });
    setSettings(nextSettings);
  }

  async function saveApiKey() {
    if (!draft.apiKeyInput.trim()) {
      return;
    }

    setSavingKey(true);
    setActionError(null);
    try {
      await window.wingman.saveApiKey(draft.apiKeyInput.trim());
      setSettings((current) => ({
        ...current,
        apiKeyStored: true,
      }));
      setDraft((current) => ({
        ...current,
        apiKeyInput: '',
      }));
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to save API key.',
      );
    } finally {
      setSavingKey(false);
    }
  }

  async function clearApiKey() {
    try {
      await window.wingman.clearApiKey();
      setSettings((current) => ({
        ...current,
        apiKeyStored: false,
      }));
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to clear API key.',
      );
    }
  }

  async function startSession() {
    setActionError(null);

    try {
      const response = await window.wingman.startSession({
        resumeText: draft.resumeText,
        extraContext: draft.extraContext,
        language: draft.language,
        model: draft.model,
        overlayPreset: draft.overlayPreset,
        overlayOpacity: draft.overlayOpacity,
        historyEnabled: draft.historyEnabled,
        apiKey: draft.apiKeyInput.trim() || undefined,
      });

      setSettings((current) => ({
        ...current,
        language: draft.language,
        model: draft.model,
        overlayPreset: draft.overlayPreset,
        overlayOpacity: draft.overlayOpacity,
        historyEnabled: draft.historyEnabled,
        apiKeyStored: current.apiKeyStored || Boolean(draft.apiKeyInput.trim()),
      }));
      setDraft((current) => ({
        ...current,
        apiKeyInput: '',
      }));
      setAppState((current) => ({
        ...current,
        currentSessionId: response.session_id,
        sessionStatus: response.status,
      }));
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to start the session.',
      );
    }
  }

  async function stopSession() {
    setActionError(null);
    try {
      const response = await window.wingman.stopSession();
      setAppState((current) => ({
        ...current,
        currentSessionId: null,
        sessionStatus: response.status,
      }));
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to stop the session.',
      );
    }
  }

  async function handleResumeUpload(file: File) {
    if (!appState.serverPort) {
      setActionError('The local backend is still starting. Try again in a moment.');
      return;
    }

    setResumeUploading(true);
    setActionError(null);
    try {
      const response = await uploadResume(appState.serverPort, file);
      setDraft((current) => ({
        ...current,
        resumeText: response.resume_text,
      }));
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Resume upload failed.',
      );
    } finally {
      setResumeUploading(false);
    }
  }

  async function toggleOverlay() {
    const next = await window.wingman.toggleOverlay();
    setAppState(next);
  }

  async function minimizeOverlay() {
    const next = await window.wingman.minimizeOverlay();
    setAppState(next);
  }

  async function openHistoryFolder() {
    await window.wingman.openHistoryFolder();
  }

  async function openExternal(url: string) {
    await window.wingman.openExternal(url);
  }

  return {
    appState,
    settings,
    draft,
    setDraft,
    history,
    historyLoading,
    resumeUploading,
    actionError,
    savingKey,
    canStart,
    sessionRunning,
    serverBaseUrl,
    savePreferences,
    saveApiKey,
    clearApiKey,
    startSession,
    stopSession,
    handleResumeUpload,
    toggleOverlay,
    minimizeOverlay,
    openHistoryFolder,
    openExternal,
  };
}
