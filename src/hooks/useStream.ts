import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type {
  AnswerEventPayload,
  SessionStatus,
  TranscriptEventPayload,
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
      setAnswer('');
      setStatus('idle');
      return;
    }

    resetAnswerTimeout(answerTimeout);
    setTranscriptLines([]);
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

      if (payload.type === 'transcript' && payload.text) {
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
      setAnswer('');
      setStatus('starting');
      setStreamError(null);
      return;
    }

    if (sessionStatus === 'stopped' || sessionStatus === 'idle' || sessionStatus === 'ready') {
      resetAnswerTimeout(answerTimeout);
      setTranscriptLines([]);
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

    const response = await fetch(`http://127.0.0.1:${serverPort}/answer/manual`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serverToken ? { 'X-Wingman-Token': serverToken } : {}),
      },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
      throw new Error((await response.text()) || 'Manual answer request failed.');
    }
  }

  return {
    transcriptLines,
    answer,
    status,
    streamError,
    submitManualPrompt,
  };
}
