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
