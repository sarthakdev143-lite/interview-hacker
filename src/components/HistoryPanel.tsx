import { useState } from 'react';
import { formatDate, formatDuration } from '../lib/format';
import type { SessionHistoryRecord } from '../types/contracts';

interface HistoryPanelProps {
  history: SessionHistoryRecord[];
  loading: boolean;
  onOpenFolder: () => Promise<void>;
}

export function HistoryPanel({
  history,
  loading,
  onOpenFolder,
}: HistoryPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 text-sm text-slate-400">
        Loading session history...
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-8 text-center">
        <p className="text-lg font-semibold text-slate-100">No saved sessions yet</p>
        <p className="mt-2 text-sm text-slate-400">
          Enable session history in Settings, finish an interview session, and WingMan
          will store question-answer exchanges here.
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-slate-100">Session history</h2>
          <p className="text-sm text-slate-400">
            Expand a session to review the saved interview exchanges.
          </p>
        </div>
        <button
          className="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
          onClick={() => {
            void onOpenFolder();
          }}
          type="button"
        >
          Open folder
        </button>
      </div>

      {history.map((session) => {
        const expanded = expandedId === session.session_id;
        return (
          <article
            className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5 shadow-halo"
            key={session.session_id}
          >
            <button
              className="flex w-full items-start justify-between gap-6 text-left"
              onClick={() =>
                setExpandedId(expanded ? null : session.session_id)
              }
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
                <p className="mt-1 text-xs uppercase tracking-[0.24em] text-slate-500">
                  {expanded ? 'Collapse' : 'Expand'}
                </p>
              </div>
            </button>

            {expanded && (
              <div className="mt-5 space-y-4 border-t border-white/10 pt-5">
                {session.exchanges.map((exchange) => (
                  <div
                    className="rounded-3xl border border-white/8 bg-slate-950/50 p-4"
                    key={`${exchange.timestamp}-${exchange.question}`}
                  >
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
                      {formatDate(exchange.timestamp)}
                    </p>
                    <p className="mt-3 text-sm font-semibold text-slate-100">
                      {exchange.question}
                    </p>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
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
