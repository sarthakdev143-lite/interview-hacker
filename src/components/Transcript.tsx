// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

import type { TranscriptLine } from '../hooks/useStream';

interface TranscriptProps {
  lines: TranscriptLine[];
  interimLine?: string;
  compact?: boolean;
}

export function Transcript({
  lines,
  interimLine = '',
  compact = false,
}: TranscriptProps) {
  if (lines.length === 0 && !interimLine) {
    return (
      <div
        className={`rounded-[1.5rem] border border-dashed border-white/10 bg-slate-950/35 text-slate-500 ${
          compact ? 'px-3 py-2 text-xs' : 'px-4 py-4 text-sm'
        }`}
      >
        Live transcript will appear here once loopback audio is being captured.
      </div>
    );
  }

  const visibleLines = compact ? lines.slice(-3) : lines.slice(-6);

  return (
    <div
      className={`rounded-[1.5rem] border border-white/10 bg-slate-950/45 ${
        compact ? 'px-3 py-3' : 'px-4 py-4'
      }`}
    >
      <div className="space-y-3">
        {visibleLines.map((line, index) => (
          <div
            className={`rounded-[1rem] border px-3 py-2 ${
              line.isQuestion
                ? 'border-cyan-300/20 bg-cyan-400/8 text-slate-100'
                : 'border-white/5 bg-white/[0.025] text-slate-300'
            }`}
            key={`${line.text}-${index}`}
          >
            <p className={`${compact ? 'text-xs' : 'text-sm'} leading-relaxed`}>
              {line.text}
            </p>
          </div>
        ))}

        {interimLine && (
          <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/[0.015] px-3 py-2">
            <p
              className={`${compact ? 'text-xs' : 'text-sm'} leading-relaxed text-slate-500`}
            >
              {interimLine}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
