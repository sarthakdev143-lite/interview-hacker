import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDevServerOrigin, getDevServerUrl } from './devServer';
import type { AppState, OverlayBounds, OverlayPreset } from './types/contracts';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFile } = require('node:child_process') as typeof import('node:child_process');

export class WindowManager {
  dashboardWindow: BrowserWindow | null = null;

  overlayWindow: BrowserWindow | null = null;

  constructor(private readonly preloadPath: string) {}

  private get rendererPath() {
    return path.join(__dirname, '../renderer/index.html');
  }

  private isAppUrl(rawUrl: string) {
    const devServerOrigin = getDevServerOrigin();
    try {
      const parsed = new URL(rawUrl);

      if (devServerOrigin) {
        return parsed.origin === devServerOrigin;
      }

      return rawUrl.startsWith(pathToFileURL(this.rendererPath).toString());
    } catch {
      return false;
    }
  }

  // ─── Protection helpers ────────────────────────────────────────────────────

  /**
   * Applies capture protection immediately and re-applies on every window
   * lifecycle event that could reset or bypass the protection.
   */
  private hardenWindow(window: BrowserWindow) {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!this.isAppUrl(url)) {
        event.preventDefault();
      }
    });

    // Apply now and on every event that can strip the affinity.
    const protect = () => this.applyCaptureProtection(window);
    this.applyCaptureProtection(window);

    window.on('show', protect);
    window.on('restore', protect);
    window.on('focus', protect);
    window.on('maximize', protect);
    window.on('unmaximize', protect);
    window.on('enter-full-screen', protect);
    window.on('leave-full-screen', protect);
    window.webContents.on('did-finish-load', protect);
  }

  /**
   * Applies capture protection for the current platform.
   * - macOS   : NSWindowSharingNone
   * - Windows : SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE = 0x11)
   * - Linux   : best-effort X11 hint, plus the _NET_WM_BYPASS_COMPOSITOR below
   *
   * `setContentProtection` does all of this natively and synchronously. On
   * Windows it applies WDA_EXCLUDEFROMCAPTURE — the affinity that removes the
   * window from Windows Graphics Capture, which is what Teams, Zoom, Meet and
   * OBS use — not the weaker WDA_MONITOR.
   *
   * This previously shelled out to PowerShell to set the affinity by hand, on
   * the belief that Electron only managed WDA_MONITOR. That is no longer true:
   * reading GetWindowDisplayAffinity back off both live windows returns 0x11
   * with the PowerShell path disabled entirely. The subprocess compiled C# via
   * Add-Type on every one of the eight lifecycle events below, and under
   * startup contention it hit its own 10s timeout and fell through to a
   * `pwsh.exe` that is absent on stock Windows, logging failures for work that
   * had already succeeded. Verify with GetWindowDisplayAffinity before
   * reintroducing anything like it.
   */
  private applyCaptureProtection(window: BrowserWindow): void {
    if (window.isDestroyed()) return;

    window.setContentProtection(true);

    if (process.platform === 'linux') {
      // Ask the compositor to exclude the window from desktop-level captures.
      // Best-effort; silently ignored without xprop, and on Wayland.
      this.applyLinuxHint(window);
    }
  }

  // ─── Linux ─────────────────────────────────────────────────────────────────

  /**
   * Sets _NET_WM_BYPASS_COMPOSITOR=1 on the window via xprop.
   * This tells the X11 compositor to exclude the window from its compositing
   * pipeline, which also removes it from desktop-level screen captures.
   * Silently no-ops when xprop is not installed or on Wayland.
   */
  private applyLinuxHint(window: BrowserWindow): void {
    if (window.isDestroyed()) return;

    let xid: string;
    try {
      const buf = window.getNativeWindowHandle();
      xid = buf.readUInt32LE(0).toString(10);
    } catch {
      return;
    }

    execFile(
      'xprop',
      ['-id', xid, '-f', '_NET_WM_BYPASS_COMPOSITOR', '32c',
       '-set', '_NET_WM_BYPASS_COMPOSITOR', '1'],
      { timeout: 3000 },
      (err) => {
        if (err) console.warn('[wingman] xprop hint failed (non-fatal):', err.message);
      },
    );
  }

  // ─── Window creation ───────────────────────────────────────────────────────

  private async loadRoute(window: BrowserWindow, route: string) {
    // Null in a packaged build, so the bundled renderer is the only thing a
    // shipped app will ever load.
    const devServerUrl = getDevServerUrl();
    if (devServerUrl) {
      await window.loadURL(`${devServerUrl}#${route}`);
      return;
    }

    await window.loadFile(this.rendererPath, { hash: route });
  }

  private normalizeOpacity(opacity: number) {
    if (!Number.isFinite(opacity)) {
      return 0.95;
    }

    return Math.max(0.25, Math.min(opacity, 1));
  }

  async createWindows(preset: OverlayPreset, overlayOpacity: number) {
    this.dashboardWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 980,
      minHeight: 720,
      backgroundColor: '#07111f',
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: this.preloadPath,
      },
    });

    this.overlayWindow = new BrowserWindow({
      width: 420,
      height: 600,
      show: false,
      transparent: true,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // The overlay must stay focusable so it can still receive mouse input on
      // Windows after the user switches back to the interview window.
      focusable: true,
      fullscreenable: false,
      hasShadow: true,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: this.preloadPath,
        backgroundThrottling: false,
      },
    });

    this.hardenWindow(this.dashboardWindow);
    this.hardenWindow(this.overlayWindow);

    this.overlayWindow.setOpacity(this.normalizeOpacity(overlayOpacity));
    this.overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    this.applyCaptureProtection(this.overlayWindow);
    if (process.platform !== 'win32') {
      this.overlayWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    }

    this.positionOverlay(preset);

    this.dashboardWindow.on('closed', () => {
      this.dashboardWindow = null;
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.close();
      }
    });

    this.overlayWindow.on('closed', () => {
      this.overlayWindow = null;
    });

    const dashboardReadyToShow = new Promise<void>((resolve) => {
      this.dashboardWindow!.once('ready-to-show', resolve);
    });
    const overlayReadyToShow = new Promise<void>((resolve) => {
      this.overlayWindow!.once('ready-to-show', resolve);
    });

    await Promise.all([
      this.loadRoute(this.dashboardWindow, '/dashboard'),
      this.loadRoute(this.overlayWindow, '/overlay'),
    ]);

    // Wait for the first paint before showing the windows to avoid a black flash.
    await Promise.all([dashboardReadyToShow, overlayReadyToShow]);

    this.dashboardWindow.show();
    this.applyCaptureProtection(this.dashboardWindow);
    this.overlayWindow.showInactive();
    this.applyCaptureProtection(this.overlayWindow);
  }

  // ─── Overlay controls ──────────────────────────────────────────────────────

  positionOverlay(preset: OverlayPreset) {
    if (!this.overlayWindow) {
      return;
    }

    const display = screen.getPrimaryDisplay().workArea;
    const [width, height] = this.overlayWindow.getSize();
    const margin = 24;

    const x =
      preset === 'bottom-left' || preset === 'top-left'
        ? display.x + margin
        : display.x + display.width - width - margin;
    const y =
      preset === 'top-left' || preset === 'top-right'
        ? display.y + margin
        : display.y + display.height - height - margin;

    this.overlayWindow.setPosition(x, y);
  }

  moveOverlay(x: number, y: number) {
    if (!this.overlayWindow) {
      return;
    }

    this.overlayWindow.setPosition(x, y);
  }

  setOverlayBounds(bounds: OverlayBounds) {
    if (!this.overlayWindow) {
      return;
    }

    const normalizedWidth = Math.max(360, Math.min(bounds.width, 1100));
    const normalizedHeight = Math.max(360, Math.min(bounds.height, 1200));

    this.overlayWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: normalizedWidth,
      height: normalizedHeight,
    });
  }

  resizeOverlay(width: number, height: number) {
    if (!this.overlayWindow) {
      return;
    }

    const normalizedWidth = Math.max(360, Math.min(width, 1100));
    const normalizedHeight = Math.max(360, Math.min(height, 1200));
    this.overlayWindow.setSize(normalizedWidth, normalizedHeight);
  }

  setOverlayOpacity(opacity: number) {
    if (!this.overlayWindow) {
      return;
    }

    this.overlayWindow.setOpacity(this.normalizeOpacity(opacity));
  }

  toggleOverlayVisibility() {
    if (!this.overlayWindow) {
      return;
    }

    if (this.overlayWindow.isVisible()) {
      this.overlayWindow.hide();
    } else {
      this.overlayWindow.showInactive();
    }

    this.applyCaptureProtection(this.overlayWindow);
  }

  toggleOverlayMinimize() {
    if (!this.overlayWindow) {
      return;
    }

    if (this.overlayWindow.isMinimized()) {
      this.overlayWindow.restore();
      this.overlayWindow.showInactive();
    } else {
      this.overlayWindow.minimize();
    }

    this.applyCaptureProtection(this.overlayWindow);
  }

  focusOverlayInput() {
    if (!this.overlayWindow) {
      return;
    }

    this.overlayWindow.show();
    this.overlayWindow.focus();
    this.overlayWindow.webContents.send('overlay:focus-input');
    this.applyCaptureProtection(this.overlayWindow);
  }

  releaseOverlayFocus() {
    if (!this.overlayWindow) {
      return;
    }

    this.overlayWindow.blur();
    this.applyCaptureProtection(this.overlayWindow);
  }

  sendAppState(state: AppState) {
    for (const window of [this.dashboardWindow, this.overlayWindow]) {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        continue;
      }

      try {
        window.webContents.send('app:state', state);
      } catch {
        // The render frame can be torn down between the check and the send,
        // which is routine during shutdown and never worth reporting.
      }
    }
  }

  getStateMeta() {
    return {
      overlayVisible: Boolean(this.overlayWindow?.isVisible()),
      overlayMinimized: Boolean(this.overlayWindow?.isMinimized()),
    };
  }
}
