import { useEffect } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { HistoryPanel } from './components/HistoryPanel';
import { Overlay } from './components/Overlay';
import { SessionSetup } from './components/SessionSetup';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { useSession } from './hooks/useSession';
import { useStream } from './hooks/useStream';

function DashboardApp() {
  const location = useLocation();
  const session = useSession();
  const stream = useStream(session.appState.serverPort);
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
    <div className="min-h-screen bg-transparent p-5">
      <div className="grid min-h-[calc(100vh-2.5rem)] overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.03] shadow-halo xl:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="border-r border-white/10 bg-slate-950/50 p-5">
          <div className="rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-4">
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">WingMan</p>
            <h1 className="mt-3 text-2xl font-semibold text-slate-50">
              Real-time interview wingmate
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              Secure floating answers, live transcription, and resume-aware
              guidance during interviews.
            </p>
          </div>

          <div className="mt-5">
            <StatusBar compact health={session.appState.health} status={session.appState.sessionStatus} />
          </div>

          <nav className="mt-6 space-y-2">
            {[
              { to: '/dashboard', label: 'Setup' },
              { to: '/history', label: 'History' },
              { to: '/settings', label: 'Settings' },
            ].map((item) => (
              <NavLink
                className={({ isActive }) =>
                  `flex items-center justify-between rounded-2xl px-4 py-3 text-sm transition ${
                    isActive
                      ? 'bg-storm/15 text-slate-50'
                      : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                  }`
                }
                key={item.to}
                to={item.to}
              >
                <span>{item.label}</span>
                <span className="text-xs uppercase tracking-[0.24em] text-slate-500">
                  View
                </span>
              </NavLink>
            ))}
          </nav>

          <div className="mt-6 rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Overlay shortcuts
            </p>
            <div className="mt-3 space-y-2 text-sm text-slate-300">
              <p>`Ctrl+Shift+H` or `Ctrl+Alt+H` toggles visibility</p>
              <p>`Ctrl+Shift+M` or `Ctrl+Alt+M` minimizes the panel</p>
              <p>`Ctrl+Shift+Space` focuses manual answer input</p>
            </div>
          </div>
        </aside>

        <main className="overflow-auto p-6">
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
