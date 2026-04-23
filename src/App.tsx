import { useEffect } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { HistoryPanel } from './components/HistoryPanel';
import { Overlay } from './components/Overlay';
import { SessionSetup } from './components/SessionSetup';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { useSession } from './hooks/useSession';
import { useStream } from './hooks/useStream';

const navItems = [
  {
    to: '/dashboard',
    label: 'Mission Control',
    hint: 'Setup',
  },
  {
    to: '/history',
    label: 'Session Archive',
    hint: 'History',
  },
  {
    to: '/settings',
    label: 'Ops',
    hint: 'Settings',
  },
];

function DashboardApp() {
  const location = useLocation();
  const session = useSession();
  const stream = useStream(
    session.appState.serverPort,
    session.appState.serverToken,
    session.appState.currentSessionId,
    session.appState.sessionStatus,
  );
  const isOverlay = location.pathname === '/overlay';

  useEffect(() => {
    document.body.dataset.surface = isOverlay ? 'overlay' : 'dashboard';
  }, [isOverlay]);

  if (isOverlay) {
    return (
      <Overlay
        answer={stream.answer}
        appState={session.appState}
        onManualSubmit={stream.submitManualPrompt}
        onMinimize={session.minimizeOverlay}
        onStop={session.stopSession}
        status={stream.status}
        transcriptLines={stream.transcriptLines}
      />
    );
  }

  return (
    <div className="min-h-screen bg-transparent px-4 py-4 lg:px-6">
      <div className="app-shell grid min-h-[calc(100vh-2rem)] rounded-[2rem] border border-white/10 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="relative border-b border-white/10 p-5 xl:border-b-0 xl:border-r">
          <div className="hero-orb left-[-80px] top-[-40px] h-40 w-40 bg-cyan-400/20" />
          <div className="hero-orb bottom-[-30px] right-[-20px] h-28 w-28 bg-emerald-400/20" />

          <div className="panel-surface-strong relative rounded-[1.75rem] p-5">
            <p className="text-xs uppercase tracking-[0.34em] text-cyan-200/55">
              WingMan
            </p>
            <h1 className="mt-4 max-w-[12ch] text-3xl font-bold leading-tight text-white">
              Interview support that looks intentional.
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              Build context, capture the room, and keep a discreet live answer panel
              available without the current rough edges.
            </p>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="rounded-[1.25rem] border border-white/10 bg-white/[0.04] p-3">
                <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
                  Engine
                </p>
                <p className="mt-2 text-sm font-medium text-slate-100">
                  {session.draft.model.split('/').at(-1)}
                </p>
              </div>
              <div className="rounded-[1.25rem] border border-white/10 bg-white/[0.04] p-3">
                <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
                  Overlay
                </p>
                <p className="mt-2 text-sm font-medium text-slate-100">
                  {Math.round(session.draft.overlayOpacity * 100)}% opacity
                </p>
              </div>
            </div>
          </div>

          <div className="mt-5">
            <StatusBar compact health={session.appState.health} status={session.appState.sessionStatus} />
          </div>

          <nav className="mt-5 space-y-2">
            {navItems.map((item) => (
              <NavLink
                className={({ isActive }) =>
                  `group panel-surface flex items-center justify-between rounded-[1.35rem] px-4 py-3 transition ${
                    isActive
                      ? 'border-cyan-300/30 bg-cyan-400/10 text-white'
                      : 'text-slate-300 hover:border-white/20 hover:bg-white/[0.05]'
                  }`
                }
                key={item.to}
                to={item.to}
              >
                <div>
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.24em] text-slate-500 transition group-hover:text-slate-400">
                    {item.hint}
                  </p>
                </div>
                <span className="text-lg text-slate-500 transition group-hover:text-slate-300">
                  +
                </span>
              </NavLink>
            ))}
          </nav>

          <div className="panel-surface mt-5 rounded-[1.75rem] p-4">
            <p className="text-xs uppercase tracking-[0.28em] text-slate-500">
              Global shortcuts
            </p>
            <div className="mt-4 space-y-3 text-sm text-slate-300">
              <div className="flex items-center justify-between gap-3">
                <span>Toggle overlay</span>
                <code className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-200">
                  Ctrl+Shift+H
                </code>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Minimize overlay</span>
                <code className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-200">
                  Ctrl+Shift+M
                </code>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Focus manual input</span>
                <code className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-200">
                  Ctrl+Shift+Space
                </code>
              </div>
            </div>
          </div>
        </aside>

        <main className="relative overflow-auto p-5 lg:p-7">
          <div className="mb-6 flex flex-col gap-4 rounded-[1.75rem] border border-white/10 bg-white/[0.03] px-5 py-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.34em] text-cyan-200/60">
                Control surface
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-white">
                Cleaner hierarchy, faster scanning, less visual noise.
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:min-w-[320px]">
              <div className="rounded-[1.2rem] border border-white/10 bg-slate-950/40 px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
                  Server
                </p>
                <p className="mt-1 text-sm text-slate-100">
                  {session.appState.serverReady ? 'Connected' : 'Booting'}
                </p>
              </div>
              <div className="rounded-[1.2rem] border border-white/10 bg-slate-950/40 px-4 py-3">
                <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
                  Overlay
                </p>
                <p className="mt-1 text-sm text-slate-100">
                  {session.appState.overlayVisible ? 'Visible' : 'Hidden'}
                </p>
              </div>
            </div>
          </div>

          <Routes>
            <Route
              element={
                <SessionSetup
                  actionError={
                    session.actionError ??
                    stream.streamError ??
                    session.appState.error
                  }
                  answer={stream.answer}
                  appState={session.appState}
                  canStart={session.canStart}
                  draft={session.draft}
                  onClearApiKey={session.clearApiKey}
                  onDraftChange={(field, value) =>
                    session.setDraft((current) => ({
                      ...current,
                      [field]: value,
                    }) as typeof session.draft)
                  }
                  onSaveApiKey={session.saveApiKey}
                  onSavePreferences={session.savePreferences}
                  onStart={session.startSession}
                  onStop={session.stopSession}
                  onUploadResume={session.handleResumeUpload}
                  resumeUploading={session.resumeUploading}
                  savingKey={session.savingKey}
                  sessionRunning={session.sessionRunning}
                  settings={session.settings}
                  transcriptLines={stream.transcriptLines}
                />
              }
              path="/dashboard"
            />
            <Route
              element={
                <HistoryPanel
                  history={session.history}
                  loading={session.historyLoading}
                  onOpenFolder={session.openHistoryFolder}
                />
              }
              path="/history"
            />
            <Route
              element={
                <SettingsPanel
                  healthMessage={
                    session.appState.health?.audio.message ??
                    'Waiting for the audio capture backend to report status.'
                  }
                  onOpenExternal={session.openExternal}
                  onOpenFolder={session.openHistoryFolder}
                  onSave={session.savePreferences}
                  settings={session.settings}
                />
              }
              path="/settings"
            />
            <Route element={<Navigate replace to="/dashboard" />} path="*" />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <DashboardApp />
    </HashRouter>
  );
}
