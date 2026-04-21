import { useEffect, useRef, useState } from 'react';
import type {
  AnswerEventPayload,
  SessionStatus,
  TranscriptEventPayload,
} from '../types/contracts';

export interface TranscriptLine {
  text: string;
  isQuestion: boolean;
}

export function useStream(serverPort: number | null) {
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [streamError, setStreamError] = useState<string | null>(null);
  const answerTimeout = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (answerTimeout.current) {
        window.clearTimeout(answerTimeout.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!serverPort) {
      return;
    }

    setStreamError(null);
    const transcriptSource = new EventSource(
      `http://127.0.0.1:${serverPort}/transcript/stream`,
    );
    const answerSource = new EventSource(
      `http://127.0.0.1:${serverPort}/answer/stream`,
    );

    const clearStreamError = () => {
      setStreamError(null);
    };

    transcriptSource.onopen = clearStreamError;
    answerSource.onopen = clearStreamError;

    transcriptSource.onmessage = (event) => {
      clearStreamError();
      const payload = JSON.parse(event.data) as TranscriptEventPayload;
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
        setStatus(payload.is_question ? 'thinking' : 'transcribing');
      }
    };

    answerSource.onmessage = (event) => {
      clearStreamError();
      const payload = JSON.parse(event.data) as AnswerEventPayload;
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
        if (answerTimeout.current) {
          window.clearTimeout(answerTimeout.current);
        }
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
      transcriptSource.close();
      answerSource.close();
    };
  }, [serverPort]);

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
