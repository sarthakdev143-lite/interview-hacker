import { useEffect, useRef, useState } from 'react';
import type { TranscriptLine } from '../hooks/useStream';
import type { AppState, SessionStatus } from '../types/contracts';
import { Transcript } from './Transcript';

interface OverlayProps {
  appState: AppState;
  transcriptLines: TranscriptLine[];
  answer: string;
  status: SessionStatus;
  onManualSubmit: (prompt: string) => Promise<void>;
  onStop: () => Promise<void>;
  onMinimize: () => Promise<void>;
}

export function Overlay({
  appState,
  transcriptLines,
  answer,
  status,
  onManualSubmit,
  onStop,
  onMinimize,
}: OverlayProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [manualPrompt, setManualPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  useEffect(() => {
    return window.wingman.onOverlayFocusInput(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  async function handleSubmit() {
    if (!manualPrompt.trim()) {
      return;
    }

    setSubmitting(true);
    setManualError(null);
    try {
      await onManualSubmit(manualPrompt);
      setManualPrompt('');
      await window.wingman.releaseOverlayFocus();
    } catch (error) {
      setManualError(
        error instanceof Error ? error.message : 'Failed to request manual answer.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const lastAnswer =
    answer ||
    (status === 'thinking'
      ? 'Generating answer...'
      : 'Listening for the next interview question...');

  return (
    <div className="flex h-screen items-end justify-end p-5">
      <section className="overlay-shell pointer-events-auto flex h-full max-h-[600px] w-full max-w-[420px] flex-col overflow-hidden rounded-2xl border border-white/10 shadow-halo">
        <header className="drag-region flex items-center justify-between border-b border-white/8 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/8 text-sm font-semibold text-slate-100">
              WM
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-100">WingMan</p>
              <p className="text-xs text-slate-400">
                {appState.sessionStatus === 'error'
                  ? appState.error ?? 'Needs attention'
                  : appState.sessionStatus}
              </p>
            </div>
          </div>
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              status === 'thinking'
                ? 'bg-amber-400'
                : status === 'stopped' || status === 'error'
                  ? 'bg-rose-500'
                  : 'bg-glow'
            } ${status === 'thinking' || status === 'listening' ? 'animate-pulse-soft' : ''}`}
          />
        </header>

        <div className="px-4 py-3">
          <Transcript compact lines={transcriptLines} />
        </div>

        <div className="mx-4 border-t border-white/8" />

        <div className="flex-1 overflow-auto px-4 py-4">
          <div className="rounded-[1.5rem] border border-white/8 bg-slate-950/45 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Answer stream
            </p>
            <div className="mt-4 whitespace-pre-wrap font-mono text-sm leading-7 text-slate-100">
              {lastAnswer}
              {status === 'answering' && (
                <span className="ml-1 inline-block h-5 w-2 animate-blink rounded bg-glow/80 align-middle" />
              )}
            </div>
          </div>

          {manualError && (
            <p className="mt-3 text-sm text-rose-300">{manualError}</p>
          )}
        </div>

        <footer className="border-t border-white/8 px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              className="no-drag flex-1 rounded-full border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-storm/60"
              onChange={(event) => setManualPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="Ask a manual follow-up..."
              ref={inputRef}
              value={manualPrompt}
            />
            <button
              className="no-drag rounded-full bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={submitting || !manualPrompt.trim()}
              onClick={() => {
                void handleSubmit();
              }}
              type="button"
            >
              Send
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              `/` focuses this field from anywhere.
            </p>
            <div className="flex items-center gap-2">
              <button
                className="no-drag rounded-full border border-white/15 px-3 py-2 text-xs uppercase tracking-[0.18em] text-slate-200 transition hover:border-white/30 hover:bg-white/5"
                onClick={() => {
                  void onMinimize();
                }}
                type="button"
              >
                Minimize
              </button>
              <button
                className="no-drag rounded-full border border-rose-400/30 px-3 py-2 text-xs uppercase tracking-[0.18em] text-rose-200 transition hover:bg-rose-500/10"
                onClick={() => {
                  void onStop();
                }}
                type="button"
              >
                Stop
              </button>
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}
