import type { PublicSettings } from '../types/contracts';

interface SettingsPanelProps {
  settings: PublicSettings;
  healthMessage: string;
  onSave: () => Promise<void>;
  onOpenFolder: () => Promise<void>;
  onOpenExternal: (url: string) => Promise<void>;
}

export function SettingsPanel({
  settings,
  healthMessage,
  onSave,
  onOpenFolder,
  onOpenExternal,
}: SettingsPanelProps) {
  return (
    <div className="space-y-6">
      <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
        <h2 className="text-2xl font-semibold text-slate-100">Operational notes</h2>
        <p className="mt-2 text-sm text-slate-400">
          The overlay is protected with Electron content protection and global
          shortcuts stay active even while the interview window has focus.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-slate-950/50 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Stored key
            </p>
            <p className="mt-3 text-sm text-slate-200">
              {settings.apiKeyStored
                ? 'Saved securely with OS encryption.'
                : 'No Groq API key saved yet.'}
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/50 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Audio status
            </p>
            <p className="mt-3 text-sm text-slate-200">{healthMessage}</p>
          </div>
        </div>
      </div>

      <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
        <h3 className="text-xl font-semibold text-slate-100">Shortcuts</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-3xl border border-white/10 bg-slate-950/50 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Toggle overlay
            </p>
            <p className="mt-3 font-mono text-sm text-slate-100">
              Ctrl+Shift+H or Ctrl+Alt+H
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/50 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Minimize overlay
            </p>
            <p className="mt-3 font-mono text-sm text-slate-100">
              Ctrl+Shift+M or Ctrl+Alt+M
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/50 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Focus manual input
            </p>
            <p className="mt-3 font-mono text-sm text-slate-100">
              Ctrl+Shift+Space
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6">
        <h3 className="text-xl font-semibold text-slate-100">Maintenance</h3>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-white"
            onClick={() => {
              void onSave();
            }}
            type="button"
          >
            Save defaults
          </button>
          <button
            className="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
            onClick={() => {
              void onOpenFolder();
            }}
            type="button"
          >
            Open history folder
          </button>
          <button
            className="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-200 transition hover:border-white/30 hover:bg-white/5"
            onClick={() => {
              void onOpenExternal('https://existential.audio/blackhole/');
            }}
            type="button"
          >
            BlackHole setup guide
          </button>
        </div>
      </div>
    </div>
  );
}
