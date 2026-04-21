# Agent Prompt: Build a Real-Time AI Interview Assistant Desktop App

## Overview

Build a production-ready desktop application called **"WingMan"** — a real-time AI interview assistant that listens to system audio during a video call, transcribes speech in real time, and displays AI-generated answers in an invisible floating overlay window. The app must be undetectable by screen-sharing software.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop Shell | Electron (latest stable) |
| Frontend UI | React + Tailwind CSS (inside Electron renderer) |
| Audio Capture | Python (`pyaudiowpatch` on Windows, `sounddevice` + BlackHole on macOS) |
| Transcription | Groq Whisper API (`whisper-large-v3-turbo`) — no local model needed |
| AI Answers | Groq LLM API (`llama-3.3-70b-versatile`) with streaming |
| Bridge | Python Flask local server (port 5001) called by Electron via HTTP |
| Resume Parsing | PyMuPDF (`fitz`) for PDF text extraction |
| Packaging | electron-builder |

---

## Project Structure

```
wingman/
├── electron/
│   ├── main.js               # Electron main process
│   ├── preload.js            # Context bridge (IPC)
│   └── windowManager.js      # Overlay window logic
├── renderer/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   │   ├── Overlay.jsx       # Floating answer panel
│   │   │   ├── Transcript.jsx    # Live transcript feed
│   │   │   ├── SessionSetup.jsx  # Resume upload + session config
│   │   │   └── StatusBar.jsx     # Listening / thinking indicators
│   │   ├── hooks/
│   │   │   ├── useSession.js
│   │   │   └── useStream.js
│   │   └── main.jsx
│   ├── index.html
│   └── tailwind.config.js
├── python/
│   ├── server.py             # Flask server entry point
│   ├── audio_capture.py      # System audio capture
│   ├── transcriber.py        # Whisper transcription
│   ├── llm.py                # Claude API integration
│   └── resume_parser.py      # PDF resume extraction
├── package.json
├── electron-builder.yml
└── requirements.txt
```

---

## Step-by-Step Implementation

### STEP 1 — Project Scaffolding

1. Initialize with `npm init` and install Electron, React, Vite, Tailwind CSS, and `electron-builder`.
2. Set up Vite as the bundler for the renderer process.
3. Create a Python virtual environment and install: `flask flask-cors groq pyaudio pymupdf sounddevice numpy`.
   - On Windows also install `pyaudiowpatch` for loopback audio.
   - No local Whisper model download needed — transcription goes through the Groq API.
4. Configure `electron-builder.yml` to bundle the Python server as a sidecar binary using PyInstaller.

---

### STEP 2 — Python Flask Server (`python/server.py`)

Build a local Flask server on `http://127.0.0.1:5001` with the following endpoints:

#### `POST /session/start`
- Accepts JSON: `{ resume_text, extra_context, language, model }`
- Stores session config in memory
- Starts the background audio capture thread
- Returns `{ session_id, status }`

#### `POST /session/stop`
- Stops the audio capture thread
- Clears session state
- Returns `{ status }`

#### `POST /resume/upload`
- Accepts multipart form with a PDF file
- Uses PyMuPDF to extract all text from the PDF
- Returns `{ resume_text }`

#### `GET /transcript/stream`
- Server-Sent Events (SSE) endpoint
- Emits events as new transcript segments arrive:
  ```
  data: { "type": "transcript", "text": "...", "is_question": true/false }
  ```

#### `GET /answer/stream`
- SSE endpoint
- When a question is detected, streams the LLM answer token-by-token:
  ```
  data: { "type": "token", "text": "..." }
  data: { "type": "done" }
  ```

#### `POST /answer/manual`
- Accepts `{ prompt }` for manually typed questions
- Returns SSE stream of Groq LLM answer

#### `GET /health`
- Returns `{ status: "ok" }`

---

### STEP 3 — Audio Capture (`python/audio_capture.py`)

```python
# Pseudocode — implement fully

class AudioCapture:
    def __init__(self, callback):
        # callback receives raw audio chunks (bytes)
        self.callback = callback
        self.stream = None
        self.running = False

    def start(self):
        # On Windows: use pyaudiowpatch to find the loopback device
        # On macOS: use sounddevice with BlackHole as the input device
        # On Linux: use PulseAudio monitor source
        # Open a stream with:
        #   - sample_rate = 16000
        #   - channels = 1 (mono)
        #   - chunk_size = 1024
        # Call self.callback(audio_chunk) in the stream callback
        pass

    def stop(self):
        pass
```

**Important:** Audio is captured from system output (loopback), not the microphone, so the interviewer's voice is captured regardless of headphone use.

---

### STEP 4 — Transcription (`python/transcriber.py`)

```python
# Pseudocode — implement fully

import io
import wave
import numpy as np
from groq import Groq

class Transcriber:
    def __init__(self, language="en"):
        self.client = Groq()  # reads GROQ_API_KEY from env
        self.model = "whisper-large-v3-turbo"
        self.language = language
        self.buffer = []          # accumulate ~3 seconds of audio before transcribing
        self.buffer_duration = 3  # seconds
        self.sample_rate = 16000

    def feed(self, audio_chunk: bytes):
        # Append raw PCM chunk to buffer
        # When buffer has enough audio (~3s worth), call transcribe_buffer()
        # Return transcribed text segment or None if buffer not full yet

    def transcribe_buffer(self) -> str:
        # 1. Concatenate all PCM chunks in buffer into one numpy float32 array
        # 2. Encode as a WAV file in memory using io.BytesIO + wave module
        #    (Groq Whisper API accepts audio file uploads, not raw arrays)
        # 3. Call:
        #      response = self.client.audio.transcriptions.create(
        #          file=("audio.wav", wav_bytes, "audio/wav"),
        #          model=self.model,
        #          language=self.language,
        #          response_format="text"
        #      )
        # 4. Clear buffer
        # 5. Return response (plain string)
        pass
```

**No model download required.** The Groq API handles transcription server-side using `whisper-large-v3-turbo`. Remove any Whisper model loading logic and loading state from the dashboard.

**Question Detection:** After each transcription segment, use a simple heuristic + LLM to classify if it's a question:
- Heuristic: ends with `?`, contains keywords like "how", "why", "what", "tell me", "explain", "describe", "can you"
- If heuristic fires → send to Groq LLM for confirmation and answer generation

---

### STEP 5 — LLM Integration (`python/llm.py`)

```python
from groq import Groq

SYSTEM_PROMPT = """
You are WingMan, a real-time interview assistant. Your job is to help the candidate answer interview questions clearly, confidently, and concisely.

Rules:
- Give direct, structured answers (use bullet points or numbered steps when appropriate)
- Keep answers under 150 words unless it's a complex technical question
- Tailor answers to the candidate's resume and background provided below
- For coding questions, provide clean, commented code with a brief explanation
- Do not mention that you are an AI assistant

Candidate Resume:
{resume_text}

Extra Context:
{extra_context}
"""

class LLMClient:
    def __init__(self):
        self.client = Groq()  # reads GROQ_API_KEY from env
        self.default_model = "llama-3.3-70b-versatile"
        # Alternative models available on Groq:
        #   "llama-4-scout-17b-16e-instruct"  — faster, lighter
        #   "gpt-oss-120b"                     — most capable

    def stream_answer(self, question: str, session: dict):
        system = SYSTEM_PROMPT.format(
            resume_text=session.get("resume_text", "Not provided"),
            extra_context=session.get("extra_context", "None")
        )
        model = session.get("model", self.default_model)
        stream = self.client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": question}
            ],
            max_tokens=500,
            stream=True
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
```

---

### STEP 6 — Electron Main Process (`electron/main.js`)

```javascript
// Key responsibilities:

// 1. Start the Python Flask server as a child process on app launch
//    - Use app.getAppPath() to find the bundled Python binary
//    - Wait for /health to return 200 before showing any window

// 2. Create TWO windows:

//    a) Dashboard Window (normal window)
//       - width: 900, height: 700
//       - Standard frame and decorations
//       - Loads renderer/index.html#/dashboard

//    b) Overlay Window (the invisible floating panel)
//       - width: 420, height: 600
//       - transparent: true
//       - frame: false
//       - alwaysOnTop: true, level: 'screen-saver'
//       - skipTaskbar: true
//       - focusable: false (so it doesn't interfere with interview window)
//       - setContentProtection(true)  ← THIS makes it invisible to screen capture
//       - Positioned at bottom-right of screen by default
//       - Loads renderer/index.html#/overlay

// 3. IPC handlers:
//    ipcMain.handle('start-session', async (event, config) => { ... })
//    ipcMain.handle('stop-session', async () => { ... })
//    ipcMain.handle('move-overlay', (event, { x, y }) => { ... })
//    ipcMain.handle('resize-overlay', (event, { width, height }) => { ... })
//    ipcMain.handle('toggle-overlay', () => { ... })
```

---

### STEP 7 — Overlay UI (`renderer/src/components/Overlay.jsx`)

The overlay is a floating panel that appears over the interview window. Design requirements:

**Visual Style:**
- Dark glass-morphism aesthetic: `background: rgba(10, 10, 15, 0.88)`, `backdrop-filter: blur(20px)`
- Thin border: `1px solid rgba(255,255,255,0.08)`
- Rounded corners: `border-radius: 16px`
- Drop shadow for depth

**Layout (top to bottom):**
1. **Header bar** (drag handle) — shows WingMan logo + session status dot (green = listening, yellow = thinking, red = stopped). Draggable to reposition overlay.
2. **Transcript strip** — last 2 lines of live transcript in small muted text, auto-scrolling
3. **Divider line**
4. **Answer panel** — streams AI answer tokens as they arrive. Smooth typewriter animation. Monospace font for code blocks.
5. **Footer** — manual input field (press `/` to focus), minimize button, stop button

**Keyboard Shortcuts (global, registered in main.js):**
- `Ctrl+Shift+H` — toggle overlay visibility
- `Ctrl+Shift+M` — minimize/restore overlay
- `/` — focus manual input field

**States to handle:**
- `idle` — "Listening..." with subtle animated waveform
- `transcribing` — shows live transcript text appearing
- `thinking` — shows spinner + "Generating answer..."
- `answering` — streams tokens with cursor blink
- `done` — answer fully shown, fades to idle after 30s

---

### STEP 8 — Dashboard UI (`renderer/src/components/SessionSetup.jsx`)

Full-page dashboard for session configuration:

**Sections:**
1. **Resume Upload** — drag-and-drop PDF zone. On drop, POST to `/resume/upload`, display extracted text preview in a scrollable box.
2. **Extra Context** — large textarea for pasting job description, company info, or custom instructions.
3. **Settings:**
   - Language selector (dropdown of Whisper-supported languages)
   - AI Model selector: `llama-3.3-70b-versatile` (default), `llama-4-scout-17b-16e-instruct` (faster), `gpt-oss-120b` (most capable)
   - Overlay position presets (bottom-right, bottom-left, top-right, top-left)
4. **API Key input** — single field for `GROQ_API_KEY` (used for both transcription and LLM). Stored via Electron's `safeStorage`.
5. **Start Session button** — large CTA, disabled until API key and at least one config field is filled

**Design:** Clean, minimal dark theme. Matches overlay aesthetic. Left sidebar navigation between Setup / History / Settings tabs.

---

### STEP 9 — Session History

After each session ends, save a JSON log to the user's app data directory:
```json
{
  "session_id": "uuid",
  "date": "ISO timestamp",
  "duration_seconds": 1840,
  "exchanges": [
    {
      "question": "Tell me about yourself",
      "answer": "...",
      "timestamp": "..."
    }
  ]
}
```

Display history in the dashboard with expandable cards per session.

---

### STEP 10 — Environment & Security

- Store `GROQ_API_KEY` using Electron's `safeStorage.encryptString()` — never store in plaintext. This single key covers both Whisper transcription and LLM answer generation.
- The Python server should only bind to `127.0.0.1` (localhost), never `0.0.0.0`
- Add a random port selection on startup to avoid conflicts, pass port to Electron via stdout
- Never log audio data or transcripts to disk unless the user explicitly enables session history

---

## requirements.txt

```
flask
flask-cors
openai-whisper
anthropic
pymupdf
sounddevice
numpy
pyaudio
# Windows only:
pyaudiowpatch ; sys_platform == "win32"
```

---

## package.json dependencies

```json
{
  "dependencies": {
    "electron": "^29.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "react-router-dom": "^6.0.0",
    "tailwindcss": "^3.0.0",
    "@anthropic-ai/sdk": "^0.20.0",
    "axios": "^1.6.0",
    "eventsource": "^2.0.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "electron-builder": "^24.0.0",
    "concurrently": "^8.0.0"
  }
}
```

---

## Critical Implementation Notes

1. **Screen invisibility:** `win.setContentProtection(true)` in Electron is the key call that makes the overlay window excluded from screen capture APIs on both macOS and Windows. Call this immediately after creating the overlay BrowserWindow.

2. **Audio loopback on macOS:** BlackHole must be installed separately. Add a first-run check: if no loopback device is found, show a setup guide in the dashboard directing the user to install BlackHole and configure a Multi-Output Device in Audio MIDI Setup.

3. **Whisper model loading:** Load the Whisper model once on server startup, not per-request. Model loading takes 2–5 seconds — show a loading state in the dashboard.

4. **Latency target:** Aim for under 4 seconds from end of spoken question to first streamed token appearing in the overlay. The main bottleneck is Whisper — use the `base` model by default and allow upgrading to `small` in settings.

5. **Question detection debounce:** Don't fire a new Claude request on every transcript segment. Buffer transcript segments for 2 seconds of silence after potential question detection before triggering the LLM call.

6. **Streaming UI:** Use `EventSource` in the renderer to connect to the Flask SSE endpoints. Append tokens to a React state string as they arrive. Use `requestAnimationFrame` to throttle DOM updates if tokens arrive very fast.

7. **Graceful shutdown:** On `app.on('before-quit')`, call `/session/stop` and wait for the Python process to exit cleanly before quitting Electron.

---

## Build & Run Instructions to Include in README

```bash
# Install Node dependencies
npm install

# Install Python dependencies
cd python && pip install -r requirements.txt

# Development mode (runs Electron + Vite + Flask concurrently)
npm run dev

# Build for production
npm run build        # builds React renderer
npm run package      # packages with electron-builder
```

---

## Deliverable Checklist

- [ ] Electron app launches and starts Python server automatically
- [ ] Dashboard loads with resume upload, context input, settings
- [ ] Session starts → audio capture begins
- [ ] Live transcript appears in overlay
- [ ] Questions auto-detected → answer streams into overlay
- [ ] Manual question input works via `/` shortcut
- [ ] Overlay is invisible when screen sharing is active
- [ ] Overlay is draggable and resizable
- [ ] Session history saved and viewable in dashboard
- [ ] API key stored securely via `safeStorage`
- [ ] App packages to a single `.dmg` / `.exe` installer