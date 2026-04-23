import type { HealthPayload, SessionStatus } from '../types/contracts';

const statusMeta: Record<
  SessionStatus,
  { label: string; tone: string; pulse: boolean; accent: string }
> = {
  booting: { label: 'Booting backend', tone: 'bg-cyan-400', pulse: true, accent: 'text-cyan-200' },
  ready: { label: 'Ready to listen', tone: 'bg-cyan-400', pulse: false, accent: 'text-cyan-200' },
  idle: { label: 'Ready', tone: 'bg-cyan-400', pulse: false, accent: 'text-cyan-200' },
  starting: { label: 'Starting session', tone: 'bg-amber-400', pulse: true, accent: 'text-amber-200' },
  listening: { label: 'Listening', tone: 'bg-emerald-400', pulse: true, accent: 'text-emerald-200' },
  transcribing: { label: 'Transcribing', tone: 'bg-cyan-400', pulse: true, accent: 'text-cyan-200' },
  thinking: { label: 'Generating answer', tone: 'bg-amber-400', pulse: true, accent: 'text-amber-200' },
  answering: { label: 'Streaming answer', tone: 'bg-emerald-400', pulse: true, accent: 'text-emerald-200' },
  done: { label: 'Answer ready', tone: 'bg-emerald-400', pulse: false, accent: 'text-emerald-200' },
  stopped: { label: 'Session stopped', tone: 'bg-rose-500', pulse: false, accent: 'text-rose-200' },
  error: { label: 'Needs attention', tone: 'bg-rose-500', pulse: false, accent: 'text-rose-200' },
};

interface StatusBarProps {
  status: SessionStatus;
  health: HealthPayload | null;
  compact?: boolean;
}

export function StatusBar({ status, health, compact = false }: StatusBarProps) {
  const meta = statusMeta[status];

  return (
    <div
      className={`panel-surface rounded-[1.5rem] ${compact ? 'px-3 py-3' : 'px-4 py-4'}`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className={`h-2.5 w-2.5 rounded-full ${meta.tone} ${
              meta.pulse ? 'animate-pulse-soft' : ''
            }`}
          />
          <div>
            <p className={`text-sm font-semibold ${meta.accent}`}>{meta.label}</p>
            <p className="text-xs text-slate-400">
              {health?.audio.ready
                ? 'Loopback audio available'
                : health?.audio.message ?? 'Preparing local backend'}
            </p>
          </div>
        </div>
        {!compact && (
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-slate-400">
            Live
          </span>
        )}
      </div>
    </div>
  );
}
