import { useState } from 'react';
import { formatDate, formatDuration } from '../lib/format';
import type { SessionHistoryRecord } from '../types/contracts';

/** Sentinel for the "delete everything" button's busy state. */
const ALL = '__all__';

interface HistoryPanelProps {
  history: SessionHistoryRecord[];
  loading: boolean;
  onOpenFolder: () => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onClearAll: () => Promise<void>;
}

export function HistoryPanel({
  history,
  loading,
  onOpenFolder,
  onDeleteSession,
  onClearAll,
}: HistoryPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Deleting a transcript is irreversible, so it takes a second click rather
  // than a modal that would be dismissed on reflex.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="panel-surface rounded-[1.75rem] p-6 text-sm text-slate-400">
        Loading session history...
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="panel-surface rounded-[1.75rem] p-8 text-center">
        <p className="text-lg font-semibold text-slate-100">No saved sessions yet</p>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Enable session history, finish an interview run, and WingMan will store the
          transcript-driven exchanges here.
        </p>
        <button
          className="mt-6 rounded-full border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
          onClick={() => {
            void onOpenFolder();
          }}
          type="button"
        >
          Open history folder
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/55">
            Archive
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-100">Session history</h2>
          <p className="mt-2 text-sm text-slate-400">
            Expand a run to inspect the preserved questions and generated answers.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
            onClick={() => {
              void onOpenFolder();
            }}
            type="button"
          >
            Open folder
          </button>
          <button
            className={`rounded-full border px-4 py-2 text-sm transition ${
              confirmingClearAll
                ? 'border-rose-400/60 bg-rose-500/15 text-rose-100'
                : 'border-white/15 text-slate-300 hover:border-rose-400/40 hover:text-rose-200'
            }`}
            disabled={busyId === ALL}
            onClick={() => {
              if (!confirmingClearAll) {
                setConfirmingClearAll(true);
                return;
              }
              setBusyId(ALL);
              void onClearAll().finally(() => {
                setBusyId(null);
                setConfirmingClearAll(false);
              });
            }}
            onBlur={() => setConfirmingClearAll(false)}
            type="button"
          >
            {busyId === ALL
              ? 'Deleting...'
              : confirmingClearAll
                ? 'Delete everything?'
                : 'Delete all'}
          </button>
        </div>
      </div>

      {history.map((session) => {
        const expanded = expandedId === session.session_id;
        const confirming = confirmingId === session.session_id;
        return (
          <article
            className="panel-surface rounded-[1.75rem] p-5"
            key={session.session_id}
          >
            <button
              className="flex w-full items-start justify-between gap-6 text-left"
              onClick={() => setExpandedId(expanded ? null : session.session_id)}
              type="button"
            >
              <div>
                <p className="text-base font-semibold text-slate-100">
                  {formatDate(session.date)}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  {session.exchanges.length} exchange
                  {session.exchanges.length === 1 ? '' : 's'} saved
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-300">
                  Duration {formatDuration(session.duration_seconds)}
                </p>
                <p className="mt-1 text-xs uppercase tracking-[0.24em] text-cyan-200/55">
                  {expanded ? 'Collapse' : 'Expand'}
                </p>
              </div>
            </button>

            <div className="mt-3 flex justify-end">
              <button
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  confirming
                    ? 'border-rose-400/60 bg-rose-500/15 text-rose-100'
                    : 'border-white/10 text-slate-400 hover:border-rose-400/40 hover:text-rose-200'
                }`}
                disabled={busyId === session.session_id}
                onBlur={() => setConfirmingId(null)}
                onClick={() => {
                  if (!confirming) {
                    setConfirmingId(session.session_id);
                    return;
                  }
                  setBusyId(session.session_id);
                  void onDeleteSession(session.session_id).finally(() => {
                    setBusyId(null);
                    setConfirmingId(null);
                  });
                }}
                type="button"
              >
                {busyId === session.session_id
                  ? 'Deleting...'
                  : confirming
                    ? 'Confirm delete'
                    : 'Delete'}
              </button>
            </div>

            {expanded && (
              <div className="mt-5 space-y-4 border-t border-white/10 pt-5">
                {session.exchanges.map((exchange) => (
                  <div
                    className="rounded-[1.35rem] border border-white/8 bg-slate-950/45 p-4"
                    key={`${exchange.timestamp}-${exchange.question}`}
                  >
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
                      {formatDate(exchange.timestamp)}
                    </p>
                    <p className="mt-3 text-sm font-semibold text-slate-100">
                      {exchange.question}
                    </p>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-300">
                      {exchange.answer}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
