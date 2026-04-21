# WingMan — Comprehensive Fix Prompt

Apply ALL of the following fixes to the existing WingMan codebase. Do not scaffold a new project. Edit only the files listed.

---

## FIX 1 — Python server binary not starting (CRITICAL — causes "did not report a port in time")

### Problem
PyInstaller's `--onefile` mode extracts to a temp folder on every launch, which is slow and frequently gets blocked by Windows Defender. The binary also has no hidden imports declared, so Flask, groq, pymupdf, sounddevice, and pyaudiowpatch are not bundled correctly.

### Fix A — Switch PyInstaller to `--onedir` mode in `scripts/build-python.mjs`

Replace `--onefile` with `--onedir`. This produces a folder instead of a single exe, which is faster to start and less likely to be flagged by antivirus.

```javascript
// scripts/build-python.mjs — replace --onefile with --onedir and add hidden imports
const args = [
  ...prefixArgs,
  '-m', 'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onedir',                          // CHANGED from --onefile
  '--name', 'wingman-server',
  '--distpath', distDir,
  '--workpath', buildDir,
  '--specpath', specDir,
  // Hidden imports Flask and its dependencies need
  '--hidden-import', 'flask',
  '--hidden-import', 'flask_cors',
  '--hidden-import', 'werkzeug',
  '--hidden-import', 'werkzeug.serving',
  '--hidden-import', 'groq',
  '--hidden-import', 'httpx',
  '--hidden-import', 'anyio',
  '--hidden-import', 'fitz',
  '--hidden-import', 'pymupdf',
  '--hidden-import', 'sounddevice',
  '--hidden-import', 'numpy',
  '--hidden-import', 'pyaudiowpatch',
  // Collect entire packages that use dynamic imports
  '--collect-all', 'groq',
  '--collect-all', 'httpx',
  '--collect-all', 'anyio',
  '--collect-all', 'flask',
  '--collect-all', 'flask_cors',
  serverEntry,
];
```

### Fix B — Update `electron-builder.yml` to bundle the whole `wingman-server/` folder

```yaml
# electron-builder.yml
extraResources:
  - from: python/dist/wingman-server    # CHANGED: was python/dist, now the onedir folder
    to: python/wingman-server
    filter:
      - "**/*"
```

### Fix C — Update `src/pythonServer.ts` to point to the new onedir binary path

```typescript
// src/pythonServer.ts — update getSpawnTarget() packaged paths

if (process.platform === 'win32') {
  if (this.isPackaged) {
    // onedir: binary is inside the wingman-server folder
    const binary = path.join(
      process.resourcesPath,
      'python',
      'wingman-server',
      'wingman-server.exe',
    );
    return { command: binary, args: [] };
  }
  return {
    command: 'py',
    args: ['-3', '-u', path.join(process.cwd(), 'python', 'server.py')],
  };
}

if (this.isPackaged) {
  const binary = path.join(
    process.resourcesPath,
    'python',
    'wingman-server',
    'wingman-server',
  );
  return { command: binary, args: [] };
}
```

### Fix D — Add a `requirements-pyinstaller.txt` with pinned versions for stable builds

Create `python/requirements-pyinstaller.txt`:
```
pyinstaller>=6.0
pyinstaller-hooks-contrib>=2024.0
```

Install before packaging:
```bash
pip install -r python/requirements-pyinstaller.txt
```

---

## FIX 2 — Black screen on launch (CRITICAL)

### Problem
`BrowserWindow.show()` is called immediately after `loadRoute()` before React has painted, causing a black flash or permanently black window.

### Fix — Add `ready-to-show` wait in `src/windowManager.ts`

Replace the bottom of `createWindows()`:

```typescript
// src/windowManager.ts — replace end of createWindows()

await Promise.all([
  this.loadRoute(this.dashboardWindow, '/dashboard'),
  this.loadRoute(this.overlayWindow, '/overlay'),
]);

// Wait for first paint before showing — prevents black window
await Promise.all([
  new Promise<void>((resolve) => {
    this.dashboardWindow!.once('ready-to-show', resolve);
  }),
  new Promise<void>((resolve) => {
    this.overlayWindow!.once('ready-to-show', resolve);
  }),
]);

this.dashboardWindow.show();
this.overlayWindow.showInactive();
```

---

## FIX 3 — Visible error window instead of silent crash (CRITICAL)

### Problem
When the Python server fails, `shutdownAndQuit()` fires and the app exits with no visible feedback. The user just sees the app disappear.

### Fix — Replace the catch block in `app.whenReady()` in `src/main.ts`

```typescript
// src/main.ts — replace app.whenReady() block

app.whenReady().then(async () => {
  try {
    await createApp();
  } catch (error) {
    console.error('[wingman] Fatal startup error:', error);

    const message = error instanceof Error ? error.message : String(error);
    const logPath = path.join(app.getPath('userData'), 'wingman.log');

    // Write log file for diagnosis
    try {
      const { promises: fs } = await import('node:fs');
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(
        logPath,
        `[${new Date().toISOString()}] Fatal error:\n${message}\n`,
        'utf8',
      );
    } catch {
      // ignore log write failure
    }

    // Show a visible error window instead of silently quitting
    const { BrowserWindow } = await import('electron');
    const errWin = new BrowserWindow({
      width: 580,
      height: 280,
      show: true,
      resizable: false,
      title: 'WingMan — Error',
      backgroundColor: '#05070c',
      webPreferences: { nodeIntegration: false },
    });

    await errWin.loadURL(
      `data:text/html,<!DOCTYPE html><html><body style="margin:0;padding:2rem;background:%2305070c;font-family:system-ui,sans-serif;color:%23f8fafc">` +
      `<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">` +
      `<span style="font-size:2rem">❌</span>` +
      `<h2 style="margin:0;color:%23fca5a5;font-size:1.25rem">WingMan failed to start</h2></div>` +
      `<p style="margin:0 0 1rem;color:%23cbd5e1;font-size:0.875rem">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>` +
      `<p style="margin:0;color:%2364748b;font-size:0.8rem">Logs: ${logPath}</p>` +
      `<p style="margin:0.75rem 0 0;color:%2364748b;font-size:0.8rem">` +
      `Check that wingman-server.exe is not blocked by Windows Defender or antivirus.</p>` +
      `</body></html>`
    );

    errWin.on('closed', () => app.exit(1));
  }
});
```

---

## FIX 4 — Single-instance lock + clean reinstall (CRITICAL)

### Problem
NSIS installer shows "WingMan cannot be closed" because multiple instances can run simultaneously, and there's no mechanism to prevent or gracefully handle a second launch.

### Fix — Add single-instance lock at the top of `src/main.ts`, right after imports

```typescript
// src/main.ts — add immediately after all imports, before any other code

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  // Another instance is already running — bring it to focus and quit this one
  app.quit();
} else {
  app.on('second-instance', () => {
    if (windowManager.dashboardWindow) {
      if (windowManager.dashboardWindow.isMinimized()) {
        windowManager.dashboardWindow.restore();
      }
      windowManager.dashboardWindow.focus();
    }
  });
}
```

Also add `executableName` to `electron-builder.yml` so NSIS knows which process to terminate:

```yaml
# electron-builder.yml
win:
  target:
    - nsis
  artifactName: WingMan-${version}-setup.${ext}
  signAndEditExecutable: false
  verifyUpdateCodeSignature: false
  executableName: WingMan        # ADD THIS LINE
```

---

## FIX 5 — Global `/` shortcut breaks typing everywhere (HIGH)

### Problem
Registering `/` as a global shortcut intercepts every `/` keypress system-wide while WingMan is running. Users cannot type `/` in their browser, IDE, or any other app.

### Fix — Replace in `src/main.ts`

```typescript
// REMOVE:
globalShortcut.register('/', () => {
  windowManager.focusOverlayInput();
});

// ADD:
globalShortcut.register('CommandOrControl+Shift+Space', () => {
  windowManager.focusOverlayInput();
});
```

### Also update the UI labels:

In `src/App.tsx`, replace:
```tsx
<p>`/` focuses manual answer input</p>
// →
<p>`Ctrl+Shift+Space` focuses manual answer input</p>
```

In `src/components/SettingsPanel.tsx`, replace:
```tsx
<p className="mt-3 font-mono text-sm text-slate-100">/</p>
// →
<p className="mt-3 font-mono text-sm text-slate-100">Ctrl+Shift+Space</p>
```

In `src/components/Overlay.tsx`, replace:
```tsx
<p className="text-xs text-slate-500">
  `/` focuses this field from anywhere.
</p>
// →
<p className="text-xs text-slate-500">
  `Ctrl+Shift+Space` focuses this field.
</p>
```

---

## FIX 6 — Wrong Groq model IDs cause 404 errors (HIGH)

### Problem
`gpt-oss-120b` and `llama-4-scout-17b-16e-instruct` are Groq console display names, not actual API model identifiers. Every session using these models will fail with a 404.

### Fix — Update `src/components/SessionSetup.tsx`

```typescript
const modelOptions = [
  {
    label: 'llama-3.3-70b-versatile',
    description: 'Balanced default — best for most interview answers',
  },
  {
    label: 'meta-llama/llama-4-scout-17b-16e-instruct',
    description: 'Faster and lighter for lower latency',
  },
  {
    label: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    description: 'Most capable — best for complex technical questions',
  },
];
```

### Fix — Update `python/llm.py`

```python
class LLMClient:
    def __init__(self, api_key: str):
        self.client = Groq(api_key=api_key)
        self.default_model = "llama-3.3-70b-versatile"
        self.classifier_model = "meta-llama/llama-4-scout-17b-16e-instruct"
```

### Fix — Update `src/secureStore.ts` default model

```typescript
const DEFAULT_SETTINGS: Omit<PublicSettings, 'apiKeyStored'> = {
  language: 'en',
  model: 'llama-3.3-70b-versatile',   // already correct, leave as-is
  overlayPreset: 'bottom-right',
  historyEnabled: false,
};
```

---

## FIX 7 — Windows Defender antivirus false positive mitigation

PyInstaller binaries are commonly flagged. Add a post-build step and README note.

### Add to `scripts/build-python.mjs` after the PyInstaller call succeeds:

```javascript
// After spawnSync call succeeds (status === 0):
console.log('\n✅ Python server built successfully.');
console.log('⚠️  If Windows Defender flags wingman-server.exe:');
console.log('   1. Open Windows Security → Virus & threat protection');
console.log('   2. Add an exclusion for: python/dist/wingman-server/');
console.log('   3. Re-run: npm run package\n');
```

### Add to `electron-builder.yml` — request admin on install to allow Defender exclusion:

```yaml
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  deleteAppDataOnUninstall: false
  runAfterFinish: true
  perMachine: false
```

---

## FIX 8 — PyInstaller spec file for reproducible builds (RECOMMENDED)

Instead of relying on CLI flags, create `python/wingman-server.spec` so PyInstaller builds are reproducible and easier to debug:

```python
# python/wingman-server.spec
import sys
from PyInstaller.utils.hooks import collect_all

block_cipher = None

datas = []
binaries = []
hiddenimports = [
    'flask', 'flask_cors', 'werkzeug', 'werkzeug.serving',
    'groq', 'httpx', 'httpx._transports', 'anyio', 'anyio._backends._asyncio',
    'fitz', 'pymupdf', 'sounddevice', 'numpy', 'cffi', '_cffi_backend',
]

for pkg in ['groq', 'httpx', 'anyio', 'flask', 'flask_cors', 'certifi']:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

if sys.platform == 'win32':
    hiddenimports += ['pyaudiowpatch']

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'PIL', 'cv2'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='wingman-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='wingman-server',
)
```

Then update `scripts/build-python.mjs` to use the spec file:

```javascript
const args = [
  ...prefixArgs,
  '-m', 'PyInstaller',
  '--noconfirm',
  '--clean',
  '--distpath', distDir,
  '--workpath', buildDir,
  '--specpath', specDir,
  path.join(pythonDir, 'wingman-server.spec'),  // use spec file instead of server.py
];
```

---

## Build & Test Order After Applying All Fixes

```bash
# 1. Install pyinstaller if not already installed
pip install pyinstaller pyinstaller-hooks-contrib

# 2. Test Python server standalone first (catches import errors before packaging)
cd python
python server.py
# Should print: PORT:XXXXX
# Press Ctrl+C

# 3. Test packaged Python binary standalone
cd ..
node scripts/build-python.mjs
./python/dist/wingman-server/wingman-server.exe
# Should print: PORT:XXXXX within 3 seconds

# 4. If step 3 works, run full package
npm run package

# 5. If Windows Defender quarantines the exe during step 3 or 4:
#    - Open Windows Security → Virus & threat protection → Protection history
#    - Restore the quarantined file
#    - Add exclusion for the python/dist folder
#    - Re-run step 3
```

---

## Summary of All Changes

| File | Fix |
|---|---|
| `scripts/build-python.mjs` | Switch to `--onedir`, add hidden imports, use spec file |
| `python/wingman-server.spec` | New file — reproducible PyInstaller spec |
| `python/requirements-pyinstaller.txt` | New file — pinned PyInstaller deps |
| `electron-builder.yml` | Update extraResources path for onedir, add executableName |
| `src/pythonServer.ts` | Update packaged binary path for onedir structure |
| `src/windowManager.ts` | Add `ready-to-show` wait before `show()` |
| `src/main.ts` | Add single-instance lock, visible error window, fix `/` shortcut |
| `src/components/SessionSetup.tsx` | Fix Groq model IDs |
| `src/components/SettingsPanel.tsx` | Update shortcut label |
| `src/components/Overlay.tsx` | Update shortcut label |
| `src/App.tsx` | Update shortcut label |
| `python/llm.py` | Fix classifier_model ID |
