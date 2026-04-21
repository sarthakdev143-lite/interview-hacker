import { useRef } from 'react';
import type { TranscriptLine } from '../hooks/useStream';
import type { SessionDraft } from '../hooks/useSession';
import { StatusBar } from './StatusBar';
import { Transcript } from './Transcript';
import type { AppState, PublicSettings } from '../types/contracts';

const modelOptions = [
  {
    label: 'llama-3.3-70b-versatile',
    description: 'Balanced default - best for most interview answers',
  },
  {
    label: 'meta-llama/llama-4-scout-17b-16e-instruct',
    description: 'Faster and lighter for lower latency',
  },
  {
    label: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    description: 'Most capable - best for complex technical questions',
  },
];

const overlayPresets = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
] as const;

const languageOptions = [
  'en',
  'es',
  'fr',
  'de',
  'hi',
  'pt',
  'it',
  'ja',
  'ko',
  'zh',
];

interface SessionSetupProps {
  appState: AppState;
  settings: PublicSettings;
  draft: SessionDraft;
  onDraftChange: (
    field: keyof SessionDraft,
    value: string | boolean,
  ) => void;
  onSaveApiKey: () => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onSavePreferences: () => Promise<void>;
  onUploadResume: (file: File) => Promise<void>;
  canStart: boolean;
  sessionRunning: boolean;
  resumeUploading: boolean;
  savingKey: boolean;
  actionError: string | null;
  answer: string;
  transcriptLines: TranscriptLine[];
}

export function SessionSetup({
  appState,
  settings,
  draft,
  onDraftChange,
  onSaveApiKey,
  onClearApiKey,
  onStart,
  onStop,
  onSavePreferences,
  onUploadResume,
  canStart,
  sessionRunning,
  resumeUploading,
  savingKey,
  actionError,
  answer,
  transcriptLines,
}: SessionSetupProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
      <section className="space-y-6">
        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-slate-500">
                Session setup
              </p>
              <h1 className="mt-3 text-3xl font-semibold text-slate-50">
                Shape the interview context before WingMan starts listening
              </h1>
            </div>
            <button
              className="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
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

        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-100">Resume upload</h2>
              <p className="mt-2 text-sm text-slate-400">
                Drop a PDF resume here and WingMan will extract the text with PyMuPDF.
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
            className="mt-5 flex h-40 w-full flex-col items-center justify-center rounded-[1.75rem] border border-dashed border-white/12 bg-slate-950/40 text-center transition hover:border-storm/50 hover:bg-slate-900/70"
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
            <span className="text-sm font-medium text-slate-100">
              {resumeUploading ? 'Extracting resume text...' : 'Drop a PDF or click to upload'}
            </span>
            <span className="mt-2 text-xs uppercase tracking-[0.24em] text-slate-500">
              PyMuPDF parser
            </span>
          </button>

          <textarea
            className="mt-5 h-52 w-full rounded-[1.5rem] border border-white/10 bg-slate-950/60 px-4 py-4 text-sm leading-relaxed text-slate-200 outline-none transition focus:border-storm/60 focus:ring-2 focus:ring-storm/20"
            onChange={(event) => onDraftChange('resumeText', event.target.value)}
            placeholder="Extracted resume text will appear here..."
            value={draft.resumeText}
          />
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
          <h2 className="text-xl font-semibold text-slate-100">Extra context</h2>
          <p className="mt-2 text-sm text-slate-400">
            Paste the job description, company notes, or any custom guidance you want
            the answers to follow.
          </p>
          <textarea
            className="mt-5 h-56 w-full rounded-[1.5rem] border border-white/10 bg-slate-950/60 px-4 py-4 text-sm leading-relaxed text-slate-200 outline-none transition focus:border-storm/60 focus:ring-2 focus:ring-storm/20"
            onChange={(event) => onDraftChange('extraContext', event.target.value)}
            placeholder="Job description, interviewer notes, target role expectations..."
            value={draft.extraContext}
          />
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
          <h2 className="text-xl font-semibold text-slate-100">Settings</h2>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-500">
                Language
              </span>
              <select
                className="w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-storm/60"
                onChange={(event) => onDraftChange('language', event.target.value)}
                value={draft.language}
              >
                {languageOptions.map((language) => (
                  <option key={language} value={language}>
                    {language.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2">
              <span className="text-xs uppercase tracking-[0.24em] text-slate-500">
                Overlay position
              </span>
              <select
                className="w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-storm/60"
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

          <div className="mt-4 space-y-3">
            {modelOptions.map((option) => (
              <button
                className={`w-full rounded-[1.5rem] border px-4 py-4 text-left transition ${
                  draft.model === option.label
                    ? 'border-storm/60 bg-storm/10'
                    : 'border-white/10 bg-slate-950/40 hover:border-white/20 hover:bg-white/[0.03]'
                }`}
                key={option.label}
                onClick={() => onDraftChange('model', option.label)}
                type="button"
              >
                <p className="text-sm font-semibold text-slate-100">{option.label}</p>
                <p className="mt-1 text-sm text-slate-400">{option.description}</p>
              </button>
            ))}
          </div>

          <label className="mt-5 flex items-center justify-between rounded-[1.5rem] border border-white/10 bg-slate-950/40 px-4 py-4">
            <div>
              <p className="text-sm font-semibold text-slate-100">Session history</p>
              <p className="mt-1 text-sm text-slate-400">
                Save question-answer exchanges after the session ends.
              </p>
            </div>
            <input
              checked={draft.historyEnabled}
              className="h-4 w-4 rounded border-white/20 bg-slate-950 text-storm focus:ring-storm/20"
              onChange={(event) =>
                onDraftChange('historyEnabled', event.target.checked)
              }
              type="checkbox"
            />
          </label>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-100">Groq API key</h2>
              <p className="mt-2 text-sm text-slate-400">
                The same key powers both Whisper transcription and answer generation.
              </p>
            </div>
            <span className="rounded-full border border-white/10 px-3 py-1 text-xs uppercase tracking-[0.24em] text-slate-500">
              {settings.apiKeyStored ? 'Stored securely' : 'Not saved'}
            </span>
          </div>

          <div className="mt-5 flex flex-col gap-3 md:flex-row">
            <input
              className="flex-1 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-storm/60 focus:ring-2 focus:ring-storm/20"
              onChange={(event) => onDraftChange('apiKeyInput', event.target.value)}
              placeholder={settings.apiKeyStored ? 'Replace stored API key' : 'Paste your GROQ_API_KEY'}
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

        {actionError && (
          <div className="rounded-[1.75rem] border border-rose-500/30 bg-rose-500/10 px-4 py-4 text-sm text-rose-200">
            {actionError}
          </div>
        )}
      </section>

      <aside className="space-y-6">
        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5">
          <h3 className="text-lg font-semibold text-slate-100">Live preview</h3>
          <p className="mt-2 text-sm text-slate-400">
            A compact view of the transcript and the latest streamed answer.
          </p>
          <div className="mt-5">
            <Transcript compact lines={transcriptLines} />
          </div>
          <div className="mt-4 rounded-[1.75rem] border border-white/10 bg-slate-950/60 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Latest answer
            </p>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
              {answer || 'Answers stream here as soon as WingMan detects a question.'}
            </p>
          </div>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
            Session control
          </p>
          <p className="mt-3 text-sm text-slate-400">
            Start once your API key and at least one context field are filled in.
          </p>
          <div className="mt-5 flex flex-col gap-3">
            <button
              className="rounded-full bg-gradient-to-r from-storm to-glow px-4 py-3 text-sm font-semibold text-slate-950 shadow-halo transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
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
