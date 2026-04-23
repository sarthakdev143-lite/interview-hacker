import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppState, OverlayPreset } from './types/contracts';

export class WindowManager {
  dashboardWindow: BrowserWindow | null = null;

  overlayWindow: BrowserWindow | null = null;

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

  private hardenWindow(window: BrowserWindow) {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!this.isAppUrl(url)) {
        event.preventDefault();
      }
    });
    this.applyCaptureProtection(window);
    window.on('show', () => {
      this.applyCaptureProtection(window);
    });
    window.on('restore', () => {
      this.applyCaptureProtection(window);
    });
    window.webContents.on('did-finish-load', () => {
      this.applyCaptureProtection(window);
    });
  }

  private applyCaptureProtection(window: BrowserWindow): void {
    if (window.isDestroyed()) {
      return;
    }

    window.setContentProtection(true);

    if (process.platform === 'win32') {
      this.applyWin32Protection(window);
    }
  }

  private applyWin32Protection(window: BrowserWindow): void {
    if (window.isDestroyed()) {
      return;
    }

    let hwnd: number;
    try {
      const buffer = window.getNativeWindowHandle();
      hwnd = buffer.readUInt32LE(0);
    } catch {
      return;
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
      `[WingManProtect]::SetWindowDisplayAffinity([IntPtr]${hwnd}, 0x11)`,
    ].join('\n');

    const powershell =
      `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      execFileSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          psScript,
        ],
        {
          timeout: 6000,
          windowsHide: true,
          stdio: 'ignore',
        },
      );
    } catch (error) {
      console.warn('[wingman] Direct Win32 protection call failed:', error);
    }
  }

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
      focusable: false,
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
    this.overlayWindow.setFocusable(true);
    this.overlayWindow.focus();
    this.overlayWindow.webContents.send('overlay:focus-input');
    this.applyCaptureProtection(this.overlayWindow);
  }

  releaseOverlayFocus() {
    if (!this.overlayWindow) {
      return;
    }

    this.overlayWindow.blur();
    this.overlayWindow.setFocusable(false);
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
