import type { UsageSnapshot } from '../types/contracts';

function formatUsd(value: number) {
  if (value <= 0) {
    return '$0.00';
  }

  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }

  return `$${value.toFixed(2)}`;
}

function formatMinutes(seconds: number) {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

interface CostMeterProps {
  usage: UsageSnapshot | null;
  compact?: boolean;
}

export function CostMeter({ usage, compact = false }: CostMeterProps) {
  const audioSeconds = usage?.audio_seconds ?? 0;
  const total = usage?.estimated_usd ?? 0;
  const isDeepgram = usage?.provider === 'deepgram';

  if (compact) {
    return (
      <span className="text-[11px] tabular-nums text-slate-500">
        {formatUsd(total)} · {formatMinutes(audioSeconds)}
      </span>
    );
  }

  return (
    <div className="rounded-[1.4rem] border border-white/10 bg-slate-950/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
          Session cost
        </p>
        <p className="text-lg font-semibold tabular-nums text-emerald-200">
          {formatUsd(total)}
        </p>
      </div>

      <dl className="mt-4 space-y-2 text-xs text-slate-400">
        <div className="flex justify-between gap-3">
          <dt>{isDeepgram ? 'Audio streamed' : 'Speech transcribed'}</dt>
          <dd className="tabular-nums text-slate-300">
            {formatMinutes(audioSeconds)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Transcription</dt>
          <dd className="tabular-nums text-slate-300">
            {formatUsd(usage?.stt_usd ?? 0)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Answers ({usage?.llm_requests ?? 0})</dt>
          <dd className="tabular-nums text-slate-300">
            {formatUsd(usage?.llm_usd ?? 0)}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-xs leading-5 text-slate-500">
        {isDeepgram
          ? 'Deepgram bills for connection time, so silence counts. Switch to Groq transcription to pay for speech only.'
          : 'Only detected speech is uploaded, so silence is free. Groq’s free tier normally covers a full interview at no charge.'}
      </p>
    </div>
  );
}
