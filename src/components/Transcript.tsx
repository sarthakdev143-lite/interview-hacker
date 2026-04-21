import type { TranscriptLine } from '../hooks/useStream';

interface TranscriptProps {
  lines: TranscriptLine[];
  compact?: boolean;
}

export function Transcript({ lines, compact = false }: TranscriptProps) {
  if (lines.length === 0) {
    return (
      <div
        className={`rounded-3xl border border-dashed border-white/10 bg-white/[0.03] text-slate-500 ${
          compact ? 'px-3 py-2 text-xs' : 'px-4 py-4 text-sm'
        }`}
      >
        Live transcript will appear here as system audio is captured.
      </div>
    );
  }

  const visibleLines = compact ? lines.slice(-2) : lines.slice(-6);

  return (
    <div
      className={`rounded-3xl border border-white/10 bg-slate-950/50 ${
        compact ? 'px-3 py-2' : 'px-4 py-4'
      }`}
    >
      <div className="space-y-2">
        {visibleLines.map((line, index) => (
          <p
            key={`${line.text}-${index}`}
            className={`leading-relaxed ${
              line.isQuestion ? 'text-slate-100' : 'text-slate-400'
            } ${compact ? 'text-xs' : 'text-sm'}`}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
}
