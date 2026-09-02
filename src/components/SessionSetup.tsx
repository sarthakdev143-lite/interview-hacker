// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

import { useRef } from 'react';
import type { TranscriptLine } from '../hooks/useStream';
import type { SessionDraft } from '../hooks/useSession';
import { CostMeter } from './CostMeter';
import { StatusBar } from './StatusBar';
import { Transcript } from './Transcript';
import type {
  AppState,
  PublicSettings,
  TranscriptionProvider,
  UsageSnapshot,
} from '../types/contracts';

const transcriptionOptions: {
  value: TranscriptionProvider;
  label: string;
  cost: string;
  description: string;
}[] = [
  {
    value: 'groq',
    label: 'Groq Whisper',
    cost: 'Free tier · ~$0.04/hr after',
    description:
      'Uses the Groq key you already have. Audio is segmented on your machine and only speech is uploaded, so pauses cost nothing.',
  },
  {
    value: 'deepgram',
    label: 'Deepgram streaming',
    cost: '~$0.35/hr',
    description:
      'Lower latency with live partial text, but it needs a second key and bills for the whole session, silence included.',
  },
];

// Shown until the account's real catalog loads. Groq retires model IDs, so
// this list is a starting point, never the source of truth.
const FALLBACK_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

const MODEL_NOTES: { match: string; note: string }[] = [
  { match: 'gpt-oss-120b', note: 'Strongest answers. Recommended default.' },
  { match: 'gpt-oss-20b', note: 'Faster and cheaper, slightly shallower.' },
  { match: 'compound', note: 'Groq agentic system with built-in tools.' },
  { match: 'qwen', note: 'Alternative reasoning model.' },
  { match: 'llama', note: 'Meta Llama instruction model.' },
  { match: 'allam', note: 'Arabic-focused model.' },
];

function describeModel(model: string) {
  const note = MODEL_NOTES.find((entry) => model.includes(entry.match));
  return note?.note ?? 'Available on your Groq account.';
}

const overlayPresets = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
] as const;

const languageOptions = ['en', 'es', 'fr', 'de', 'hi', 'pt', 'it', 'ja', 'ko', 'zh'];

interface SessionSetupProps {
  appState: AppState;
  settings: PublicSettings;
  draft: SessionDraft;
  onDraftChange: (
    field: keyof SessionDraft,
    value: string | boolean | number,
  ) => void;
  onSaveApiKey: () => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onSaveDeepgramApiKey: () => Promise<void>;
  onClearDeepgramApiKey: () => Promise<void>;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onSavePreferences: () => Promise<void>;
  onUploadResume: (file: File) => Promise<void>;
  canStart: boolean;
  sessionRunning: boolean;
  resumeUploading: boolean;
  savingKey: boolean;
  savingDeepgramKey: boolean;
  actionError: string | null;
  answer: string;
  transcriptLines: TranscriptLine[];
  usage: UsageSnapshot | null;
  models: string[];
  notice: string;
}

export function SessionSetup({
  appState,
  settings,
  draft,
  onDraftChange,
  onSaveApiKey,
  onClearApiKey,
  onSaveDeepgramApiKey,
  onClearDeepgramApiKey,
  onStart,
  onStop,
  onSavePreferences,
  onUploadResume,
  canStart,
  sessionRunning,
  resumeUploading,
  savingKey,
  savingDeepgramKey,
  actionError,
  answer,
  transcriptLines,
  usage,
  models,
  notice,
}: SessionSetupProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const needsDeepgramKey = draft.transcriptionProvider === 'deepgram';
  const modelOptions = models.length > 0 ? models : FALLBACK_MODELS;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_380px]">
      <section className="space-y-6">
        <div className="panel-surface rounded-[1.9rem] p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/55">
                Session setup
              </p>
              <h1 className="mt-3 text-3xl font-semibold leading-tight text-white">
                Shape the context before WingMan starts listening.
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                Build a stronger prompt stack, keep the overlay readable, and start the
                session only when the interview context is genuinely complete.
              </p>
            </div>
            <button
              className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100 transition hover:border-cyan-300/35 hover:bg-cyan-400/15"
              onClick={() => {
                void onSavePreferences();
              }}
              type="button"
            >
              Save defaults
            </button>
          </div>

          <div className="mt-6">
            <StatusBar health={appState.health} status={appState.sessionStatus} />
          </div>
        </div>

        <div className="panel-surface rounded-[1.9rem] p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-100">Resume upload</h2>
              <p className="mt-2 text-sm text-slate-400">
                Drop a PDF resume and WingMan will extract it through PyMuPDF for
                better answer grounding.
              </p>
            </div>
            <button
              className="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              Choose PDF
            </button>
          </div>

          <input
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void onUploadResume(file);
              }
            }}
            ref={fileInputRef}
            type="file"
          />

          <button
            className="mt-5 flex h-44 w-full flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-cyan-300/20 bg-gradient-to-br from-cyan-400/8 to-emerald-400/6 text-center transition hover:border-cyan-300/40 hover:from-cyan-400/12 hover:to-emerald-400/10"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files?.[0];
              if (file) {
                void onUploadResume(file);
              }
            }}
            type="button"
          >
            <span className="text-base font-medium text-slate-100">
              {resumeUploading ? 'Extracting resume text...' : 'Drop a PDF or click to upload'}
            </span>
            <span className="mt-2 text-xs uppercase tracking-[0.24em] text-cyan-100/55">
              Resume parser ready
            </span>
          </button>

          <textarea
            className="mt-5 h-56 w-full rounded-[1.35rem] border border-white/10 bg-slate-950/55 px-4 py-4 text-sm leading-7 text-slate-200 outline-none transition focus:border-cyan-300/45 focus:ring-2 focus:ring-cyan-300/15"
            onChange={(event) => onDraftChange('resumeText', event.target.value)}
            placeholder="Extracted resume text will appear here..."
            value={draft.resumeText}
          />
        </div>

        <div className="panel-surface rounded-[1.9rem] p-6">
          <h2 className="text-xl font-semibold text-slate-100">Extra context</h2>
          <p className="mt-2 text-sm text-slate-400">
            Add the job description, panel expectations, or constraints you want the
            generated answer to respect.
          </p>
          <textarea
            className="mt-5 h-60 w-full rounded-[1.35rem] border border-white/10 bg-slate-950/55 px-4 py-4 text-sm leading-7 text-slate-200 outline-none transition focus:border-cyan-300/45 focus:ring-2 focus:ring-cyan-300/15"
            onChange={(event) => onDraftChange('extraContext', event.target.value)}
            placeholder="Job description, interviewer notes, target role expectations..."
            value={draft.extraContext}
          />
        </div>

        <div className="panel-surface rounded-[1.9rem] p-6">
          <h2 className="text-xl font-semibold text-slate-100">Preferences</h2>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-500">
                Interview language
              </span>
              <select
                className="w-full rounded-[1.2rem] border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-cyan-300/45"
                onChange={(event) => onDraftChange('language', event.target.value)}
                value={draft.language}
              >
                {languageOptions.map((language) => (
                  <option key={language} value={language}>
                    {language.toUpperCase()}
                  </option>
                ))}
              </select>
              <p className="text-sm text-slate-400">
                Speech is transcribed in this language, and non-English audio is
                translated to English internally before question detection.
              </p>
            </label>

            <label className="space-y-2">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-500">
                Overlay anchor
              </span>
              <select
                className="w-full rounded-[1.2rem] border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-cyan-300/45"
                onChange={(event) => onDraftChange('overlayPreset', event.target.value)}
                value={draft.overlayPreset}
              >
                {overlayPresets.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-4 block rounded-[1.35rem] border border-white/10 bg-slate-950/45 px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-semibold text-slate-100">Overlay transparency</span>
              <span className="text-sm text-slate-400">
                {Math.round(draft.overlayOpacity * 100)}%
              </span>
            </div>
            <input
              className="mt-4 w-full accent-cyan-300"
              max="1"
              min="0.25"
              onChange={(event) =>
                onDraftChange('overlayOpacity', Number(event.target.value))
              }
              step="0.05"
              type="range"
              value={draft.overlayOpacity}
            />
            <p className="mt-3 text-sm text-slate-400">
              Lower values make the floating overlay less conspicuous during calls.
            </p>
          </label>

          <div className="mt-4 space-y-3">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Answer model
            </p>
            {modelOptions.map((option) => (
              <button
                className={`w-full rounded-[1.35rem] border px-4 py-4 text-left transition ${
                  draft.model === option
                    ? 'border-cyan-300/35 bg-cyan-400/10'
                    : 'border-white/10 bg-slate-950/45 hover:border-white/20 hover:bg-white/[0.03]'
                }`}
                key={option}
                onClick={() => onDraftChange('model', option)}
                type="button"
              >
                <p className="text-sm font-semibold text-slate-100">{option}</p>
                <p className="mt-1 text-sm text-slate-400">{describeModel(option)}</p>
              </button>
            ))}
            {models.length === 0 && (
              <p className="text-xs leading-5 text-slate-500">
                Save a Groq API key to load the models your account can use.
              </p>
            )}
          </div>

          <label className="mt-5 flex items-center justify-between gap-4 rounded-[1.35rem] border border-white/10 bg-slate-950/45 px-4 py-4">
            <div>
              <p className="text-sm font-semibold text-slate-100">Session history</p>
              <p className="mt-1 text-sm text-slate-400">
                Persist question-answer exchanges after each run.
              </p>
            </div>
            <input
              checked={draft.historyEnabled}
              className="h-4 w-4 rounded border-white/20 bg-slate-950 text-cyan-300 focus:ring-cyan-300/20"
              onChange={(event) => onDraftChange('historyEnabled', event.target.checked)}
              type="checkbox"
            />
          </label>
        </div>

        <div className="panel-surface rounded-[1.9rem] p-6">
          <h2 className="text-xl font-semibold text-slate-100">Transcription engine</h2>
          <p className="mt-2 text-sm text-slate-400">
            Groq keeps WingMan on a single free key. Deepgram trades cost for
            lower latency.
          </p>

          <div className="mt-5 space-y-3">
            {transcriptionOptions.map((option) => (
              <button
                className={`w-full rounded-[1.35rem] border px-4 py-4 text-left transition ${
                  draft.transcriptionProvider === option.value
                    ? 'border-cyan-300/35 bg-cyan-400/10'
                    : 'border-white/10 bg-slate-950/45 hover:border-white/20 hover:bg-white/[0.03]'
                }`}
                key={option.value}
                onClick={() => onDraftChange('transcriptionProvider', option.value)}
                type="button"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-100">{option.label}</p>
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[11px] tracking-wide ${
                      option.value === 'groq'
                        ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-200'
                        : 'border-white/10 bg-white/[0.03] text-slate-400'
                    }`}
                  >
                    {option.cost}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  {option.description}
                </p>
              </button>
            ))}
          </div>
        </div>

        <div className="panel-surface rounded-[1.9rem] p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-100">Groq API key</h2>
              <p className="mt-2 text-sm text-slate-400">
                The same key powers transcription and answer generation.
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs uppercase tracking-[0.24em] text-slate-400">
              {settings.apiKeyStored ? 'Stored' : 'Missing'}
            </span>
          </div>

          <div className="mt-5 flex flex-col gap-3 md:flex-row">
            <input
              className="flex-1 rounded-[1.2rem] border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-cyan-300/45 focus:ring-2 focus:ring-cyan-300/15"
              onChange={(event) => onDraftChange('apiKeyInput', event.target.value)}
              placeholder={
                settings.apiKeyStored
                  ? 'Replace the active API key'
                  : 'Paste your GROQ_API_KEY'
              }
              type="password"
              value={draft.apiKeyInput}
            />
            <button
              className="rounded-full bg-slate-100 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!draft.apiKeyInput.trim() || savingKey}
              onClick={() => {
                void onSaveApiKey();
              }}
              type="button"
            >
              {savingKey ? 'Saving...' : 'Save key'}
            </button>
            <button
              className="rounded-full border border-white/15 px-4 py-3 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
              onClick={() => {
                void onClearApiKey();
              }}
              type="button"
            >
              Clear
            </button>
          </div>
        </div>

        {needsDeepgramKey && (
        <div className="panel-surface rounded-[1.9rem] p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-100">Deepgram API key</h2>
              <p className="mt-2 text-sm text-slate-400">
                Required only by the Deepgram engine. Switch back to Groq
                Whisper to run WingMan on one key.
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs uppercase tracking-[0.24em] text-slate-400">
              {settings.deepgramApiKeyStored ? 'Stored' : 'Missing'}
            </span>
          </div>

          <div className="mt-5 flex flex-col gap-3 md:flex-row">
            <input
              className="flex-1 rounded-[1.2rem] border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-cyan-300/45 focus:ring-2 focus:ring-cyan-300/15"
              onChange={(event) =>
                onDraftChange('deepgramApiKeyInput', event.target.value)
              }
              placeholder={
                settings.deepgramApiKeyStored
                  ? 'Replace the active API key'
                  : 'Paste your DEEPGRAM_API_KEY'
              }
              type="password"
              value={draft.deepgramApiKeyInput}
            />
            <button
              className="rounded-full bg-slate-100 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!draft.deepgramApiKeyInput.trim() || savingDeepgramKey}
              onClick={() => {
                void onSaveDeepgramApiKey();
              }}
              type="button"
            >
              {savingDeepgramKey ? 'Saving...' : 'Save key'}
            </button>
            <button
              className="rounded-full border border-white/15 px-4 py-3 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
              onClick={() => {
                void onClearDeepgramApiKey();
              }}
              type="button"
            >
              Clear
            </button>
          </div>
        </div>
        )}

        {notice && (
          <div className="rounded-[1.5rem] border border-amber-400/25 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
            {notice}
          </div>
        )}

        {actionError && (
          <div className="rounded-[1.5rem] border border-rose-500/30 bg-rose-500/10 px-4 py-4 text-sm text-rose-200">
            {actionError}
          </div>
        )}
      </section>

      <aside className="space-y-6">
        <div className="panel-surface-strong rounded-[1.9rem] p-5">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-200/55">
            Live preview
          </p>
          <h3 className="mt-3 text-lg font-semibold text-slate-100">Overlay snapshot</h3>
          <p className="mt-2 text-sm text-slate-400">
            This is the compact surface your floating panel should roughly feel like.
          </p>
          <div className="mt-5">
            <Transcript compact lines={transcriptLines} />
          </div>
          <div className="mt-4 rounded-[1.4rem] border border-white/10 bg-slate-950/60 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Latest answer
            </p>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-200">
              {answer || 'Answers stream here as soon as WingMan detects a question.'}
            </p>
          </div>
        </div>

        <div className="panel-surface rounded-[1.9rem] p-5">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-200/55">
            Spend
          </p>
          <div className="mt-4">
            <CostMeter usage={usage} />
          </div>
        </div>

        <div className="panel-surface rounded-[1.9rem] p-5">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-200/55">
            Session control
          </p>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            Start once the API key and at least one context source are provided.
          </p>
          <div className="mt-5 flex flex-col gap-3">
            <button
              className="rounded-full bg-gradient-to-r from-cyan-300 via-sky-300 to-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 shadow-halo transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canStart || !appState.serverReady || sessionRunning}
              onClick={() => {
                void onStart();
              }}
              type="button"
            >
              Start session
            </button>
            <button
              className="rounded-full border border-white/15 px-4 py-3 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!sessionRunning}
              onClick={() => {
                void onStop();
              }}
              type="button"
            >
              Stop session
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
