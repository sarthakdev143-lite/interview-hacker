import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { submitManualAnswer } from '../lib/backend';
import type {
  AnswerEventPayload,
  SessionStatus,
  TranscriptEventPayload,
  UsageSnapshot,
} from '../types/contracts';

export interface TranscriptLine {
  text: string;
  isQuestion: boolean;
}

function resetAnswerTimeout(answerTimeout: MutableRefObject<number | null>) {
  if (answerTimeout.current) {
    window.clearTimeout(answerTimeout.current);
    answerTimeout.current = null;
  }
}

export function useStream(
  serverPort: number | null,
  serverToken: string | null,
  sessionId: string | null,
  sessionStatus: SessionStatus,
) {
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [interimLine, setInterimLine] = useState('');
  const [notice, setNotice] = useState('');
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [streamError, setStreamError] = useState<string | null>(null);
  const answerTimeout = useRef<number | null>(null);

  useEffect(() => {
    return () => resetAnswerTimeout(answerTimeout);
  }, []);

  useEffect(() => {
    if (!serverPort) {
      resetAnswerTimeout(answerTimeout);
      setTranscriptLines([]);
      setInterimLine('');
      setAnswer('');
      setStatus('idle');
      return;
    }

    resetAnswerTimeout(answerTimeout);
    setTranscriptLines([]);
    setInterimLine('');
    setAnswer('');
    setStatus(sessionId ? 'listening' : sessionStatus === 'stopped' ? 'stopped' : 'idle');
    setStreamError(null);
    const tokenQuery = serverToken
      ? `?token=${encodeURIComponent(serverToken)}`
      : '';
    const transcriptSource = new EventSource(
      `http://127.0.0.1:${serverPort}/transcript/stream${tokenQuery}`,
    );
    const answerSource = new EventSource(
      `http://127.0.0.1:${serverPort}/answer/stream${tokenQuery}`,
    );

    const clearStreamError = () => {
      setStreamError(null);
    };

    const parsePayload = <T,>(raw: string) => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        setStreamError('Live stream sent an invalid event. Waiting for recovery.');
        return null;
      }
    };

    transcriptSource.onopen = clearStreamError;
    answerSource.onopen = clearStreamError;

    transcriptSource.onmessage = (event) => {
      clearStreamError();
      const payload = parsePayload<TranscriptEventPayload>(event.data);
      if (!payload) {
        return;
      }
      if (payload.type === 'status' && payload.status) {
        setStatus(payload.status);
        return;
      }

      if (payload.type === 'usage' && payload.usage) {
        setUsage(payload.usage);
        return;
      }

      if (payload.type === 'error') {
        setStreamError(payload.message ?? 'Transcription failed.');
        return;
      }

      // Informational, not a failure — e.g. a saved model that Groq retired
      // and the backend swapped out so the session could still start.
      if (payload.type === 'notice') {
        setNotice(payload.message ?? '');
        return;
      }

      if (payload.type === 'transcript' && payload.text) {
        // Streaming providers refine an interim line word by word. Holding it
        // separately keeps those partials from stacking up as history.
        if (payload.interim) {
          setInterimLine(payload.text);
          setStatus('transcribing');
          return;
        }

        setInterimLine('');
        setTranscriptLines((current) => [
          ...current.slice(-11),
          {
            text: payload.text ?? '',
            isQuestion: Boolean(payload.is_question),
          },
        ]);
        if (payload.is_question) {
          resetAnswerTimeout(answerTimeout);
          setAnswer('');
        }
        setStatus(payload.is_question ? 'thinking' : 'transcribing');
      }
    };

    answerSource.onmessage = (event) => {
      clearStreamError();
      const payload = parsePayload<AnswerEventPayload>(event.data);
      if (!payload) {
        return;
      }
      if (payload.type === 'status' && payload.status) {
        if (payload.status === 'thinking') {
          setAnswer('');
        }
        setStatus(payload.status);
        return;
      }

      if (payload.type === 'token') {
        setStatus('answering');
        setAnswer((current) => current + (payload.text ?? ''));
        return;
      }

      if (payload.type === 'done') {
        setStatus('done');
        resetAnswerTimeout(answerTimeout);
        answerTimeout.current = window.setTimeout(() => {
          setStatus('idle');
        }, 30000);
      }
    };

    const handleError = () => {
      setStreamError('Live stream disconnected. Waiting for the backend to recover.');
    };

    transcriptSource.onerror = handleError;
    answerSource.onerror = handleError;

    return () => {
      resetAnswerTimeout(answerTimeout);
      transcriptSource.close();
      answerSource.close();
    };
  }, [serverPort, serverToken, sessionId, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === 'starting') {
      resetAnswerTimeout(answerTimeout);
      setTranscriptLines([]);
      setInterimLine('');
      setUsage(null);
      setNotice('');
      setAnswer('');
      setStatus('starting');
      setStreamError(null);
      return;
    }

    if (sessionStatus === 'stopped' || sessionStatus === 'idle' || sessionStatus === 'ready') {
      resetAnswerTimeout(answerTimeout);
      setTranscriptLines([]);
      setInterimLine('');
      setAnswer('');
      setStatus(sessionStatus);
    }
  }, [sessionStatus]);

  async function submitManualPrompt(prompt: string) {
    if (!serverPort || !prompt.trim()) {
      return;
    }

    setStreamError(null);
    setStatus('thinking');
    setAnswer('');

    await submitManualAnswer(serverPort, serverToken, prompt);
  }

  return {
    transcriptLines,
    interimLine,
    usage,
    notice,
    answer,
    status,
    streamError,
    submitManualPrompt,
  };
}
