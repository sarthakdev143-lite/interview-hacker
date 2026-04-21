# WingMan

WingMan is a desktop interview assistant built with Electron, React, Tailwind CSS, and a local Python service. It captures system audio, streams Groq Whisper transcriptions, detects likely interview questions, and renders protected answer overlays that stay out of common screen-capture paths via Electron content protection.

## Features

- Dashboard window for resume upload, extra context, model selection, overlay presets, API key storage, and session control
- Floating protected overlay window with live transcript, streamed answer output, manual follow-up input, and global shortcuts
- Local Flask service with SSE endpoints for transcript and answer streams
- Groq-backed transcription with `whisper-large-v3-turbo`
- Groq-backed answer streaming with `llama-3.3-70b-versatile` and alternative model options
- Secure `GROQ_API_KEY` storage using Electron `safeStorage`
- Session history saved to the app data folder only when history is enabled

## Development

```bash
# Install Node dependencies
npm install

# Install Python dependencies
cd python
pip install -r requirements.txt
cd ..

# Development mode
npm run dev
```

`npm run dev` starts the Vite renderer, watches the Electron main/preload builds, launches Electron, and lets Electron start the local Python server automatically.

## Packaging

```bash
# Install packaging dependencies for reproducible PyInstaller builds
pip install -r python/requirements-pyinstaller.txt

# Build the Electron app bundles
npm run build

# Package with electron-builder
npm run package
```

`npm run package` builds the Electron bundles, compiles the Python server into a sidecar executable with PyInstaller, and packages the desktop app with `electron-builder`.

If Windows Defender quarantines `python/dist/wingman-server/wingman-server.exe`, add an exclusion for `python/dist/wingman-server/` and rerun `npm run package`.

## Notes

- On Windows, install `pyaudiowpatch` for WASAPI loopback capture.
- On macOS, install BlackHole and configure a Multi-Output Device before starting a session.
- The overlay uses `BrowserWindow.setContentProtection(true)` so it is excluded from supported screen-capture APIs on Windows and macOS.
