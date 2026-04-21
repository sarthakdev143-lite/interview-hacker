import type { HealthPayload, SessionStatus } from '../types/contracts';

const statusMeta: Record<
  SessionStatus,
  { label: string; tone: string; pulse: boolean }
> = {
  booting: { label: 'Booting backend', tone: 'bg-storm', pulse: true },
  ready: { label: 'Ready to listen', tone: 'bg-storm', pulse: false },
  idle: { label: 'Listening', tone: 'bg-glow', pulse: true },
  starting: { label: 'Starting session', tone: 'bg-ember', pulse: true },
  listening: { label: 'Listening', tone: 'bg-glow', pulse: true },
  transcribing: { label: 'Transcribing', tone: 'bg-storm', pulse: true },
  thinking: { label: 'Generating answer', tone: 'bg-amber-400', pulse: true },
  answering: { label: 'Streaming answer', tone: 'bg-glow', pulse: true },
  done: { label: 'Answer ready', tone: 'bg-glow', pulse: false },
  stopped: { label: 'Session stopped', tone: 'bg-rose-500', pulse: false },
  error: { label: 'Needs attention', tone: 'bg-rose-500', pulse: false },
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
      className={`rounded-3xl border border-white/10 bg-white/5 ${
        compact ? 'px-3 py-2' : 'px-4 py-3'
      }`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className={`h-2.5 w-2.5 rounded-full ${meta.tone} ${
              meta.pulse ? 'animate-pulse-soft' : ''
            }`}
          />
          <div>
            <p className="text-sm font-semibold text-slate-100">{meta.label}</p>
            <p className="text-xs text-slate-400">
              {health?.audio.ready
                ? 'Loopback audio available'
                : health?.audio.message ?? 'Preparing local backend'}
            </p>
          </div>
        </div>
        {!compact && (
          <span className="rounded-full border border-white/10 px-2 py-1 text-[11px] uppercase tracking-[0.24em] text-slate-400">
            WingMan
          </span>
        )}
      </div>
    </div>
  );
}
