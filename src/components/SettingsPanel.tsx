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
      <div className="panel-surface rounded-[1.75rem] p-6">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/55">
          Operations
        </p>
        <h2 className="mt-3 text-2xl font-semibold text-slate-100">System posture</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
          The overlay stays protected with Electron content protection while global
          shortcuts remain available over the interview window.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-[1.35rem] border border-white/10 bg-slate-950/45 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Stored key
            </p>
            <p className="mt-3 text-sm leading-6 text-slate-200">
              {settings.apiKeyStored
                ? 'Available from secure storage or .env.'
                : 'No Groq API key saved yet.'}
            </p>
          </div>
          <div className="rounded-[1.35rem] border border-white/10 bg-slate-950/45 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Audio status
            </p>
            <p className="mt-3 text-sm leading-6 text-slate-200">{healthMessage}</p>
          </div>
          <div className="rounded-[1.35rem] border border-white/10 bg-slate-950/45 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Overlay opacity
            </p>
            <p className="mt-3 text-sm leading-6 text-slate-200">
              {Math.round(settings.overlayOpacity * 100)}% saved as default.
            </p>
          </div>
        </div>
      </div>

      <div className="panel-surface rounded-[1.75rem] p-6">
        <h3 className="text-xl font-semibold text-slate-100">Shortcuts</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {[
            ['Toggle overlay', 'Ctrl+Shift+H or Ctrl+Alt+H'],
            ['Minimize overlay', 'Ctrl+Shift+M or Ctrl+Alt+M'],
            ['Focus manual input', 'Ctrl+Shift+Space'],
          ].map(([label, value]) => (
            <div
              className="rounded-[1.35rem] border border-white/10 bg-slate-950/45 p-4"
              key={label}
            >
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{label}</p>
              <p className="mt-3 font-mono text-sm text-slate-100">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="panel-surface rounded-[1.75rem] p-6">
        <h3 className="text-xl font-semibold text-slate-100">Maintenance</h3>
        <p className="mt-2 text-sm text-slate-400">
          Persist your current setup, inspect saved history, or open the loopback audio
          guide if audio capture still needs attention.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
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
