import { useEffect, useMemo, useState } from 'react';
import { getServerBaseUrl, loadHistory, uploadResume } from '../lib/backend';
import {
  DEFAULT_ANSWER_MODEL,
  type AppState,
  type PublicSettings,
  type SessionHistoryRecord,
  type StartSessionRequest,
} from '../types/contracts';

export interface SessionDraft extends StartSessionRequest {
  apiKeyInput: string;
  deepgramApiKeyInput: string;
}

const defaultSettings: PublicSettings = {
  language: 'en',
  model: DEFAULT_ANSWER_MODEL,
  overlayPreset: 'bottom-right',
  overlayOpacity: 0.95,
  historyEnabled: false,
  transcriptionProvider: 'groq',
  apiKeyStored: false,
  deepgramApiKeyStored: false,
};

const defaultAppState: AppState = {
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

export function useSession() {
  const [appState, setAppState] = useState<AppState>(defaultAppState);
  const [settings, setSettings] = useState<PublicSettings>(defaultSettings);
  const [history, setHistory] = useState<SessionHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [savingDeepgramKey, setSavingDeepgramKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [draft, setDraft] = useState<SessionDraft>({
    resumeText: '',
    extraContext: '',
    language: defaultSettings.language,
    model: defaultSettings.model,
    overlayPreset: defaultSettings.overlayPreset,
    overlayOpacity: defaultSettings.overlayOpacity,
    historyEnabled: defaultSettings.historyEnabled,
    transcriptionProvider: defaultSettings.transcriptionProvider,
    apiKeyInput: '',
    deepgramApiKeyInput: '',
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
          transcriptionProvider: nextSettings.transcriptionProvider,
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
      setHistoryLoading(false);
      return;
    }

    let isActive = true;

    async function refreshHistory() {
      setHistoryLoading(true);
      try {
        const response = await loadHistory(
          appState.serverPort as number,
          appState.serverToken,
        );
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
  }, [appState.serverPort, appState.serverToken, appState.currentSessionId]);

  // The account's real model list. Groq retires IDs, so a stale saved model
  // must not be the only thing on offer.
  useEffect(() => {
    if (!appState.serverReady) {
      return;
    }

    let isActive = true;

    async function refreshModels() {
      try {
        const catalog = await window.wingman.listModels();
        if (!isActive || catalog.models.length === 0) {
          return;
        }

        setModels(catalog.models);
        setDraft((current) =>
          catalog.models.includes(current.model)
            ? current
            : { ...current, model: catalog.recommended },
        );
      } catch {
        // A missing catalog just leaves the saved model in place.
      }
    }

    void refreshModels();

    return () => {
      isActive = false;
    };
  }, [appState.serverReady, settings.apiKeyStored]);

  const serverBaseUrl = useMemo(
    () => getServerBaseUrl(appState.serverPort),
    [appState.serverPort],
  );

  // The Groq provider transcribes with the answer key, so a second key is only
  // a precondition when the user opted into Deepgram.
  const deepgramKeyReady =
    draft.transcriptionProvider !== 'deepgram' ||
    Boolean(settings.deepgramApiKeyStored || draft.deepgramApiKeyInput.trim());

  const canStart =
    Boolean(draft.resumeText.trim() || draft.extraContext.trim()) &&
    Boolean(settings.apiKeyStored || draft.apiKeyInput.trim()) &&
    deepgramKeyReady;

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
      transcriptionProvider: draft.transcriptionProvider,
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
      setSettings(await window.wingman.getSettings());
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to clear API key.',
      );
    }
  }

  async function saveDeepgramApiKey() {
    if (!draft.deepgramApiKeyInput.trim()) {
      return;
    }

    setSavingDeepgramKey(true);
    setActionError(null);
    try {
      await window.wingman.saveDeepgramApiKey(draft.deepgramApiKeyInput.trim());
      setSettings((current) => ({
        ...current,
        deepgramApiKeyStored: true,
      }));
      setDraft((current) => ({
        ...current,
        deepgramApiKeyInput: '',
      }));
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to save API key.',
      );
    } finally {
      setSavingDeepgramKey(false);
    }
  }

  async function clearDeepgramApiKey() {
    try {
      await window.wingman.clearDeepgramApiKey();
      setSettings(await window.wingman.getSettings());
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
        transcriptionProvider: draft.transcriptionProvider,
        apiKey: draft.apiKeyInput.trim() || undefined,
        deepgramApiKey: draft.deepgramApiKeyInput.trim() || undefined,
      });

      setSettings((current) => ({
        ...current,
        language: draft.language,
        model: draft.model,
        overlayPreset: draft.overlayPreset,
        overlayOpacity: draft.overlayOpacity,
        historyEnabled: draft.historyEnabled,
        transcriptionProvider: draft.transcriptionProvider,
        apiKeyStored: current.apiKeyStored || Boolean(draft.apiKeyInput.trim()),
        deepgramApiKeyStored:
          current.deepgramApiKeyStored || Boolean(draft.deepgramApiKeyInput.trim()),
      }));
      setDraft((current) => ({
        ...current,
        apiKeyInput: '',
        deepgramApiKeyInput: '',
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
      const response = await uploadResume(
        appState.serverPort,
        appState.serverToken,
        file,
      );
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
    models,
    history,
    historyLoading,
    resumeUploading,
    actionError,
    savingKey,
    savingDeepgramKey,
    canStart,
    sessionRunning,
    serverBaseUrl,
    savePreferences,
    saveApiKey,
    clearApiKey,
    saveDeepgramApiKey,
    clearDeepgramApiKey,
    startSession,
    stopSession,
    handleResumeUpload,
    toggleOverlay,
    minimizeOverlay,
    openHistoryFolder,
    openExternal,
  };
}
