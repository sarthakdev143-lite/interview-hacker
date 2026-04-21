import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { AppState, OverlayPreset } from './types/contracts';

export class WindowManager {
  dashboardWindow: BrowserWindow | null = null;

  overlayWindow: BrowserWindow | null = null;

  constructor(private readonly preloadPath: string) {}

  private get rendererPath() {
    return path.join(__dirname, '../renderer/index.html');
  }

  private async loadRoute(window: BrowserWindow, route: string) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      await window.loadURL(`${devServerUrl}#${route}`);
      return;
    }

    await window.loadFile(this.rendererPath, { hash: route });
  }

  async createWindows(preset: OverlayPreset) {
    this.dashboardWindow = new BrowserWindow({
      width: 900,
      height: 700,
      minWidth: 860,
      minHeight: 620,
      backgroundColor: '#05070c',
      show: false,
      webPreferences: {
        preload: this.preloadPath,
      },
    });

    this.overlayWindow = new BrowserWindow({
      width: 420,
      height: 600,
      show: false,
      transparent: true,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      fullscreenable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preloadPath,
        backgroundThrottling: false,
      },
    });

    this.overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    this.overlayWindow.setContentProtection(true);
    if (process.platform !== 'win32') {
      this.overlayWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    }

    this.positionOverlay(preset);

    this.dashboardWindow.on('closed', () => {
      this.dashboardWindow = null;
    });

    this.overlayWindow.on('closed', () => {
      this.overlayWindow = null;
    });

    await Promise.all([
      this.loadRoute(this.dashboardWindow, '/dashboard'),
      this.loadRoute(this.overlayWindow, '/overlay'),
    ]);

    this.dashboardWindow.show();
    this.overlayWindow.showInactive();
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

    const normalizedWidth = Math.max(320, Math.min(width, 960));
    const normalizedHeight = Math.max(360, Math.min(height, 1200));
    this.overlayWindow.setSize(normalizedWidth, normalizedHeight);
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
  }

  focusOverlayInput() {
    if (!this.overlayWindow) {
      return;
    }

    this.overlayWindow.show();
    this.overlayWindow.setFocusable(true);
    this.overlayWindow.focus();
    this.overlayWindow.webContents.send('overlay:focus-input');
  }

  releaseOverlayFocus() {
    if (!this.overlayWindow) {
      return;
    }

    this.overlayWindow.blur();
    this.overlayWindow.setFocusable(false);
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
