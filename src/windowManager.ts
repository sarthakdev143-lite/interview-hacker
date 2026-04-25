import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppState, OverlayBounds, OverlayPreset } from './types/contracts';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn, execFile } = require('node:child_process') as typeof import('node:child_process');

export class WindowManager {
  dashboardWindow: BrowserWindow | null = null;

  overlayWindow: BrowserWindow | null = null;

  /**
   * Tracks window IDs that currently have a Win32 protection job in-flight.
   * Prevents spawning multiple PowerShell processes for the same window.
   */
  private readonly pendingWin32 = new Set<number>();

  constructor(private readonly preloadPath: string) {}

  private get rendererPath() {
    return path.join(__dirname, '../renderer/index.html');
  }

  private isAppUrl(rawUrl: string) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    try {
      const parsed = new URL(rawUrl);

      if (devServerUrl) {
        return parsed.origin === new URL(devServerUrl).origin;
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
   * Applies all available capture-protection layers for the current platform.
   * - All platforms : Electron setContentProtection (instant)
   * - Windows       : SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE=0x11) async
   * - Linux/X11     : _NET_WM_BYPASS_COMPOSITOR hint via xprop
   */
  private applyCaptureProtection(window: BrowserWindow): void {
    if (window.isDestroyed()) return;

    // Layer 1 (all platforms): Electron built-in.
    //   macOS  → NSWindowSharingNone  (bulletproof)
    //   Windows → WDA_MONITOR (0x01)  (shows black, instant fallback)
    //   Linux  → best-effort X11 hint
    window.setContentProtection(true);

    if (process.platform === 'win32') {
      // Layer 2: WDA_EXCLUDEFROMCAPTURE (0x11) — fully removes the window from
      // Windows Graphics Capture, which is used by Teams, Zoom, Meet, OBS, and
      // every modern screen-share tool.  Applied asynchronously so the main
      // process event loop is never blocked.
      this.scheduleWin32Protection(window);
    }

    if (process.platform === 'linux') {
      // Layer 2: Ask the compositor to bypass this window so it is not included
      // in desktop-level captures.  Best-effort; silently ignored when xprop is
      // not available or on Wayland.
      this.applyLinuxHint(window);
    }
  }

  // ─── Windows ───────────────────────────────────────────────────────────────

  /**
   * Schedules an async Win32 protection job for `window`.
   * If a job is already in flight for this window it is silently skipped —
   * the in-flight job already covers the request.
   *
   * After the first successful application a single safety-net re-apply is
   * scheduled 3 seconds later to cover race conditions on slow machines
   * (e.g. window shown before PowerShell had time to finish the first run).
   */
  private scheduleWin32Protection(window: BrowserWindow, isSafetyNet = false): void {
    if (window.isDestroyed()) return;

    const id = window.id;
    if (this.pendingWin32.has(id)) return; // job already in-flight

    this.pendingWin32.add(id);

    void this.applyWin32ProtectionAsync(window)
      .then(() => {
        this.pendingWin32.delete(id);
        if (!isSafetyNet) {
          // One delayed re-apply to guarantee protection on slow systems.
          setTimeout(() => {
            if (!window.isDestroyed()) {
              this.scheduleWin32Protection(window, true);
            }
          }, 3000);
        }
      })
      .catch((err: unknown) => {
        this.pendingWin32.delete(id);
        console.warn('[wingman] Win32 capture protection failed:', err);
      });
  }

  /**
   * Calls SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE=0x11) via PowerShell.
   *
   * Key correctness fixes vs. the naïve approach:
   *  1. BigInt HWND read  – avoids UInt32 truncation on 64-bit Windows 11.
   *  2. Hex [IntPtr] literal – avoids Int32 overflow when HWND > 0x7FFFFFFF.
   *  3. -ExecutionPolicy Bypass – prevents policy restrictions from blocking
   *     inline Add-Type / C# compilation on hardened Win11 environments.
   *  4. Non-blocking (spawn) – never freezes the Electron main process.
   *  5. pwsh.exe fallback – works on machines with PowerShell 7+ only.
   */
  private applyWin32ProtectionAsync(window: BrowserWindow): Promise<void> {
    if (window.isDestroyed()) return Promise.resolve();

    let hwndHex: string;
    try {
      const buf = window.getNativeWindowHandle();
      // getNativeWindowHandle returns an 8-byte buffer on 64-bit Windows.
      // readBigUInt64LE avoids truncating the upper 32 bits of the pointer.
      hwndHex = buf.readBigUInt64LE(0).toString(16);
    } catch {
      return Promise.resolve();
    }

    const psScript = [
      "Add-Type -TypeDefinition @'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class WingManProtect {',
      '  [DllImport("user32.dll", SetLastError=true)]',
      '  public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);',
      '}',
      "'@",
      // 0x11 = WDA_EXCLUDEFROMCAPTURE: completely invisible to Windows Graphics Capture.
      // Hex literal prevents [IntPtr] cast overflow when HWND > Int32.MaxValue.
      `[WingManProtect]::SetWindowDisplayAffinity([IntPtr]0x${hwndHex}, 0x11)`,
    ].join('\n');

    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const ps5 = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const ps7 = 'pwsh.exe';

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', // Required on Win11 to allow Add-Type compilation.
      '-WindowStyle', 'Hidden',
      '-Command', psScript,
    ];

    // Try ps5 then ps7; resolve on first success, reject only if both fail.
    const tryExe = (exe: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const proc = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* ignore */ }
          reject(new Error(`[wingman] Timeout waiting for ${exe}`));
        }, 10_000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`${exe} exited with code ${String(code)}`));
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

    return tryExe(ps5).catch(() => tryExe(ps7));
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
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
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
      window?.webContents.send('app:state', state);
    }
  }

  getStateMeta() {
    return {
      overlayVisible: Boolean(this.overlayWindow?.isVisible()),
      overlayMinimized: Boolean(this.overlayWindow?.isMinimized()),
    };
  }
}
