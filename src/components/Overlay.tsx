import { useEffect, useRef, useState } from 'react';
import type { TranscriptLine } from '../hooks/useStream';
import type { AppState, OverlayBounds, SessionStatus } from '../types/contracts';
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

type ResizeDirection =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

const MIN_WIDTH = 360;
const MIN_HEIGHT = 360;
const MAX_WIDTH = 1100;
const MAX_HEIGHT = 1200;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
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
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [manualPrompt, setManualPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [activeResize, setActiveResize] = useState<ResizeDirection | null>(null);

  useEffect(() => {
    return window.wingman.onOverlayFocusInput(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
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

  function beginResize(direction: ResizeDirection, event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();
    setActiveResize(direction);

    const handleEl = event.currentTarget;
    const pointerId = event.pointerId;
    const startPointerX = event.screenX;
    const startPointerY = event.screenY;
    const startWidth = window.outerWidth;
    const startHeight = window.outerHeight;
    const startX = window.screenX;
    const startY = window.screenY;
    let frameId: number | null = null;
    let pendingBounds: OverlayBounds | null = null;
    let finished = false;

    const getNextBounds = (moveEvent: PointerEvent): OverlayBounds => {
      const deltaX = moveEvent.screenX - startPointerX;
      const deltaY = moveEvent.screenY - startPointerY;

      let nextWidth = startWidth;
      let nextHeight = startHeight;
      let nextX = startX;
      let nextY = startY;

      if (direction.includes('right')) {
        nextWidth = clamp(startWidth + deltaX, MIN_WIDTH, MAX_WIDTH);
      }
      if (direction.includes('left')) {
        nextWidth = clamp(startWidth - deltaX, MIN_WIDTH, MAX_WIDTH);
        nextX = startX + (startWidth - nextWidth);
      }
      if (direction.includes('bottom')) {
        nextHeight = clamp(startHeight + deltaY, MIN_HEIGHT, MAX_HEIGHT);
      }
      if (direction.includes('top')) {
        nextHeight = clamp(startHeight - deltaY, MIN_HEIGHT, MAX_HEIGHT);
        nextY = startY + (startHeight - nextHeight);
      }

      return {
        x: Math.round(nextX),
        y: Math.round(nextY),
        width: Math.round(nextWidth),
        height: Math.round(nextHeight),
      };
    };

    const pushBounds = (bounds: OverlayBounds) => {
      pendingBounds = bounds;
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        if (!pendingBounds) {
          return;
        }

        const nextBounds = pendingBounds;
        pendingBounds = null;
        void window.wingman.setOverlayBounds(nextBounds);
      });
    };

    const flushBounds = (bounds?: OverlayBounds) => {
      if (bounds) {
        pendingBounds = bounds;
      }

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }

      const nextBounds = pendingBounds;
      pendingBounds = null;
      if (nextBounds) {
        void window.wingman.setOverlayBounds(nextBounds);
      }
    };

    const handleMove = (moveEvent: PointerEvent) => {
      pushBounds(getNextBounds(moveEvent));
    };

    const finishResize = (moveEvent?: PointerEvent) => {
      if (finished) {
        return;
      }

      finished = true;
      setActiveResize(null);
      flushBounds(moveEvent ? getNextBounds(moveEvent) : undefined);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
      handleEl.removeEventListener('lostpointercapture', handleLostPointerCapture);

      if (handleEl.hasPointerCapture(pointerId)) {
        try {
          handleEl.releasePointerCapture(pointerId);
        } catch {
          // Ignore capture release failures when Chromium already released it.
        }
      }

      if (resizeCleanupRef.current === finishResize) {
        resizeCleanupRef.current = null;
      }
    };

    const handleUp = (upEvent: PointerEvent) => {
      finishResize(upEvent);
    };

    const handleCancel = () => {
      finishResize();
    };

    const handleLostPointerCapture = () => {
      finishResize();
    };

    // Frameless Electron windows stop emitting raw move events once the cursor
    // leaves the window unless the active handle captures the pointer first.
    handleEl.setPointerCapture(pointerId);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    handleEl.addEventListener('lostpointercapture', handleLostPointerCapture);
    resizeCleanupRef.current = finishResize;
  }

  const lastAnswer =
    answer ||
    (status === 'thinking'
      ? 'Generating answer...'
      : 'Listening for the next interview question...');

  const indicatorClass =
    status === 'thinking'
      ? 'bg-amber-400'
      : status === 'stopped' || status === 'error'
        ? 'bg-rose-500'
        : 'bg-emerald-400';

  return (
    <div className="flex h-screen items-end justify-end p-4">
      <section className="overlay-shell pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-[1.75rem]">
        {[
          'top',
          'right',
          'bottom',
          'left',
          'top-left',
          'top-right',
          'bottom-left',
          'bottom-right',
        ].map((direction) => (
          <div
            className={`overlay-resize-handle ${
              direction.includes('-') ? `corner ${direction}` : direction
            } ${activeResize === direction ? 'is-active' : ''}`}
            key={direction}
            onPointerDown={(event) => beginResize(direction as ResizeDirection, event)}
          />
        ))}

        <header
          className="drag-region relative z-10 border-b border-white/10 px-4 py-4"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-[1rem] border border-white/10 bg-cyan-300/10 text-sm font-semibold text-cyan-100">
                WM
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-100">WingMan Overlay</p>
                <p className="text-xs text-slate-400">
                  {appState.sessionStatus === 'error'
                    ? appState.error ?? 'Needs attention'
                    : appState.sessionStatus}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-slate-400">
                Drag me
              </div>
              <span
                className={`h-2.5 w-2.5 rounded-full ${indicatorClass} ${
                  status === 'thinking' || status === 'listening' ? 'animate-pulse-soft' : ''
                }`}
              />
            </div>
          </div>
        </header>

        <div className="relative z-10 flex flex-1 flex-col overflow-hidden px-4 pb-4 pt-3">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
            <div className="rounded-[1.35rem] border border-white/10 bg-slate-950/40 p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
                  Transcript
                </p>
                <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-200/55">
                  Live
                </p>
              </div>
              <Transcript compact lines={transcriptLines} />
            </div>

            <div className="rounded-[1.35rem] border border-white/10 bg-slate-950/48 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
                    Answer stream
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    Latest interview-safe response
                  </p>
                </div>
                <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-slate-400">
                  Resizable
                </div>
              </div>
              <div className="mt-4 max-h-[360px] overflow-auto whitespace-pre-wrap text-sm leading-7 text-slate-100">
                {lastAnswer}
                {status === 'answering' && (
                  <span className="ml-1 inline-block h-5 w-2 animate-blink rounded bg-cyan-300/80 align-middle" />
                )}
              </div>
            </div>
          </div>

          {manualError && <p className="mt-3 text-sm text-rose-300">{manualError}</p>}

          <footer className="mt-3 rounded-[1.35rem] border border-white/10 bg-slate-950/46 p-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
              <input
                className="no-drag flex-1 rounded-[1rem] border border-white/10 bg-slate-950/75 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/45"
                onChange={(event) => setManualPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    inputRef.current?.blur();
                    void window.wingman.releaseOverlayFocus();
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleSubmit();
                  }
                }}
                placeholder="Ask for a follow-up answer..."
                ref={inputRef}
                value={manualPrompt}
              />
              <div className="flex items-center gap-2">
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
                <button
                  className="no-drag rounded-full border border-white/15 px-4 py-3 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
                  onClick={() => {
                    void onMinimize();
                  }}
                  type="button"
                >
                  Minimize
                </button>
                <button
                  className="no-drag rounded-full border border-rose-400/30 px-4 py-3 text-sm text-rose-200 transition hover:bg-rose-500/10"
                  onClick={() => {
                    void onStop();
                  }}
                  type="button"
                >
                  Stop
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>`Ctrl+Shift+Space` focuses the input field.</span>
              <span>Resize from any edge or corner.</span>
            </div>
          </footer>
        </div>
      </section>
    </div>
  );
}
