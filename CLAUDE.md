# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WingMan is an Electron + React desktop app with a Python (Flask) sidecar. It captures system audio via loopback, transcribes it, detects interview questions, and streams Groq LLM answers into a floating overlay that is hidden from screen-capture tools.

A design constraint runs through the whole codebase: **the app must run on one free Groq API key.** Transcription defaults to Groq Whisper behind a local VAD so only speech is uploaded, and the dashboard shows live spend. Deepgram is an opt-in second provider, never a requirement.

## Commands

```bash
# One-time Python env (dev spawns .venv/Scripts/python.exe on Windows)
python -m venv .venv
.venv\Scripts\activate
pip install -r python/requirements.txt      # root requirements.txt just re-exports this

npm run dev            # predev picks a free port -> .dev-server.json, then runs
                       # renderer + main watch + preload watch + electron concurrently
npm run typecheck      # tsc --noEmit
npm run lint           # eslint --ext .ts,.tsx .
npm run test:python    # python python/tests/test_session_manager.py
npm run verify         # typecheck + lint + test:python
npm run build          # vite builds renderer / main / preload into dist/
npm run package        # verify -> build -> PyInstaller sidecar -> electron-builder -> release/
```

Run one test file, or a single test (use the venv interpreter so `numpy`/deps resolve):

```bash
.venv/Scripts/python.exe python/tests/test_vad.py
.venv/Scripts/python.exe python/tests/test_llm.py ResolveModelsTests.test_retired_model_falls_back_and_is_reported
```

There is no JS/TS test runner — `verify` is the full gate.

## Architecture

Three runtimes, two transports.

**Electron main** ([src/main.ts](src/main.ts)) owns the single `AppState` object, the Python sidecar lifecycle, global shortcuts, and all IPC. Every state change goes through `updateState()`, which merges live window metadata from `WindowManager.getStateMeta()` and broadcasts `app:state` to both windows.

**Renderer** is one React bundle loaded twice. [src/windowManager.ts](src/windowManager.ts) opens the dashboard at hash route `#/dashboard` and the overlay at `#/overlay`; [src/App.tsx](src/App.tsx) branches on `location.pathname === '/overlay'`. Each window therefore runs its own `useSession`/`useStream` instance and its own EventSource connections.

**Python sidecar** ([python/server.py](python/server.py)) is a Flask app bound to an ephemeral port on 127.0.0.1.

### Dual transport — do not conflate these

- **Control plane**: renderer → `window.wingman.*` (preload) → `ipcMain.handle` in main.ts → `PythonServerManager.request()`. Session start/stop, settings, keys, overlay geometry.
- **Data plane**: the renderer talks to Flask *directly* at `http://127.0.0.1:<port>` — SSE `/transcript/stream` and `/answer/stream`, plus `/answer/manual`, `/resume/upload`, `/history`. Main hands the renderer `serverPort` and `serverToken` inside `AppState` so it can do this. Fetch calls send `X-Wingman-Token`; EventSource cannot set headers, so SSE passes `?token=` instead (`server.py:require_server_token` accepts both).

### Sidecar handshake

`PythonServerManager` ([src/pythonServer.ts](src/pythonServer.ts)) generates a 32-byte hex token, passes it as `WINGMAN_SERVER_TOKEN` plus `WINGMAN_HISTORY_DIR`, then waits for the child to print `PORT:<n>` on stdout before polling `/health`. Spawn target order: `WINGMAN_PYTHON_BIN` → packaged `resourcesPath/python/wingman-server/wingman-server.exe` → `.venv/Scripts/python.exe` (win) / `python3`. The packaged exe is built `console=False`, so stdout can be lost — hence the Windows-only `netstat -ano` PID→port fallback. An unexpected child exit triggers `scheduleServerRestart()` with a 1.2 s retry loop.

### Audio → answer pipeline (Python)

`AudioCapture` (WASAPI loopback via `pyaudiowpatch` on Windows, monitor/BlackHole device via `sounddevice` elsewhere) downmixes and resamples to 16 kHz mono int16 → `SessionManager.audio_queue` → a transcriber → `_on_transcript`. Finals go to `_publish_transcript`, which accumulates segments and, on a `QUESTION_SETTLE_SECONDS` gap, flushes them: text matching `DIRECT_QUESTION_PREFIXES` bypasses the LLM entirely; ambiguous text goes to the classifier on a background thread; obvious non-questions never reach the LLM. Confirmed questions land on `answer_queue`, and `_stream_answer_worker` fans Groq tokens to every SSE subscriber (and to a private queue for `/answer/manual`).

`create_transcriber()` in [python/transcriber.py](python/transcriber.py) picks between two implementations sharing one interface (`start` / `feed` / `stop` plus `on_transcript(text, is_final)`):

- **`GroqTranscriber` (default)** — [python/vad.py](python/vad.py) segments the stream into utterances and only those are uploaded to Groq Whisper, so silence is free. Batch, so there are no interim results; `on_activity` fires at the frame where speech starts so the overlay does not sit idle through the round trip. Two requests run concurrently and `_emit_in_order` re-serialises them, because a short utterance can overtake a long one and scramble a multi-sentence question.
- **`DeepgramTranscriber`** — the original streaming WebSocket, with interim results.

**The VAD's minimum is measured in voiced frames, not clip length.** Pre-roll and the retained tail are padding; letting them satisfy the minimum sends keyboard clicks to a paid endpoint.

**Concurrency invariant**: every background worker captures `runtime_id`, `stop_event`, and `llm` at start and re-checks `self.runtime_id != runtime_id` before emitting anything. `start_session()` bumps `runtime_id`; `_reset_runtime()` installs a fresh `stop_event`. Any new worker must follow this or a stopped session will leak tokens into the next one (`test_stale_answer_worker_does_not_emit_after_stop` guards it).

### Models are resolved at runtime, never hardcoded

Groq retires model IDs, and a saved user preference outlives them. This repo was already broken by exactly that: every model the UI offered (`llama-3.3-70b-versatile` and both llama-4 variants) had been removed from the account, so answers *and* the question classifier failed.

`LLMClient.resolve_models()` runs at session start, lists what the key can actually reach, and falls back through `ANSWER_MODEL_PREFERENCES` when the requested model is gone, reporting it to the UI as a `notice` event. `POST /models` populates the dashboard picker from the same live list. When the catalog cannot be fetched the requested model is kept — absence of evidence is not evidence the model is gone.

**gpt-oss and qwen3 are reasoning models**: they spend part of the completion budget on hidden `delta.reasoning` and return *empty content* when the budget is too small. The old classifier capped `max_completion_tokens` at 8, which silently answered "not a question" every time. Hence `reasoning_effort: 'low'`, `CLASSIFIER_MAX_TOKENS = 96`, and `ANSWER_MAX_TOKENS = 900`. `_create()` retries without `reasoning_effort` for models that reject the parameter.

### Latency budget

End-of-question to first answer token is the number that decides whether the app
is usable live. Measured on the default Groq path by feeding recorded speech
through the real pipeline at wall-clock speed:

| stage | ~cost |
|---|---|
| VAD hangover before the utterance closes | 700 ms (overlaps the speaker's natural pause) |
| Groq Whisper round trip | 450–650 ms |
| question detection + enqueue | ~130 ms |
| Groq time-to-first-token (`gpt-oss-120b`, `reasoning_effort: low`) | 420–500 ms |
| **total** | **~800 ms** |

It was ~1230 ms until `QUESTION_SETTLE_SECONDS` was made provider-aware. Before
tuning any of these, re-measure — the stages interact, and the hangover is
partly hidden by the speaker's own trailing silence.

### Non-English interviews

Every heuristic in `session_manager.py` is an English keyword list, so in another
language they only ever produce false negatives. A punctuated question works in
any language because Whisper supplies the `?`, but an imperative prompt
("cuéntame sobre…", "erzählen Sie mir von…") matches nothing.

`_needs_classifier()` closes that gap: in a non-English session an utterance with
no English signal is buffered and sent to the classifier rather than dropped,
bounded by `MIN_CLASSIFIER_WORDS`/`MAX_CLASSIFIER_WORDS` so back-channel noise and
monologues do not trigger calls. English sessions are unaffected and take no
extra calls. **Both** gates matter — `_publish_transcript` decides whether the
text is buffered at all, and `_flush_pending_question_if_ready` decides whether
it reaches the classifier; fixing only the second one changes nothing.

### Rate limits

On a free tier a 429 is an expected condition, not an exception. `LLMClient._create()`
retries transient failures (429/408/5xx/connection) up to `LLM_MAX_ATTEMPTS`,
preferring the server's `retry-after` header over a guessed backoff and capping
any wait at `MAX_RETRY_WAIT_SECONDS` — nobody waits 30 s mid-interview. Groq
meters per model, so a persistently rate-limited answer falls back to a sibling
model from `ANSWER_MODEL_PREFERENCES` rather than waiting longer.

Only the *create* call is retried. A stream that has already yielded tokens is
never restarted, because the candidate has already seen them. Retries surface in
the UI as `notice` events, and an exhausted rate limit says so plainly instead of
the generic "I lost the answer stream".

### Cost accounting

[python/usage.py](python/usage.py) tracks session spend: transcription seconds (exact, from the VAD) and LLM tokens (real counts from `chunk.x_groq.usage` on the final streamed chunk). Snapshots reach the UI as `usage` events on the transcript SSE stream and via `GET /usage`. Deepgram bills connection time, so its total is wall clock (`set_stream_seconds`) rather than the speech the VAD measured — that asymmetry is the whole point of the comparison the UI shows.

### Capture protection

`WindowManager.hardenWindow()` is the only correct way to create a window here. Windows can drop display affinity across lifecycle events, so protection is re-applied on `show`/`restore`/`focus`/`maximize`/`unmaximize`/fullscreen/`did-finish-load`. `setContentProtection(true)` does the work on every platform; on Linux an `xprop _NET_WM_BYPASS_COMPOSITOR` hint is added. main.ts additionally disables the `WindowsGraphicsCapture` Chromium feature at startup.

**Electron already applies `WDA_EXCLUDEFROMCAPTURE` (0x11) on Windows** — the affinity that hides the window from Windows Graphics Capture (Teams, Zoom, Meet, OBS), not the weaker `WDA_MONITOR`. This was previously duplicated by shelling out to PowerShell + `Add-Type` on all eight lifecycle events; under startup contention that hit its own 10 s timeout and fell through to a `pwsh.exe` absent on stock Windows, logging failures for work Electron had already done. It was removed after reading `GetWindowDisplayAffinity` back off both live windows with the PowerShell path disabled and still getting 0x11. **Verify the same way before reintroducing anything like it** — a PowerShell script that enumerates windows by PID and calls `GetWindowDisplayAffinity` settles the question in one run.

### Adding an IPC channel

Four edits, in this order: `WingmanApi` in [src/types/contracts.ts](src/types/contracts.ts) → bridge method in [src/preload.ts](src/preload.ts) → `ipcMain.handle` in main.ts **starting with `assertTrustedSender(event)`** → renderer call site. Numeric payloads go through `requireFiniteNumber()`; enum-ish settings through `normalizeSettingsUpdates()`.

API keys never cross to the renderer, so anything needing one is a control-plane IPC call that reads the key from `SecureStore` in main — `app:list-models` is the model to copy.

`contracts.ts` is shared by main, preload, and renderer. TS is camelCase, Python is snake_case; the conversion happens in main.ts (`startSession`) — except SSE payload and history-record types, which mirror the Python snake_case shape verbatim.

### Secrets

`SecureStore` ([src/secureStore.ts](src/secureStore.ts)) encrypts both API keys with Electron `safeStorage` into `settings.json` under `userData`. Only the booleans `apiKeyStored` / `deepgramApiKeyStored` are exposed to the renderer. Starting a session requires **both** a Groq key and a Deepgram key. `GROQ_API_KEY` from `.env` is a fallback; there is no Deepgram fallback on the Electron side (only `server.py` reads `DEEPGRAM_API_KEY`).

## Things that will bite you

- **`WINGMAN_PYTHON_BIN` is a dev-only override.** A packaged build runs the bundled sidecar and only falls back to the override when that binary is genuinely missing. It used to take precedence unconditionally, and because main.ts loads `.env` via `dotenv/config` relative to the working directory, launching a packaged build from the repo pointed the shipped app at a developer virtualenv. Test packaged behaviour with `release/win-unpacked/WingMan.exe`, not just `npm run dev`.
- **Failures during sidecar startup used to be misreported.** The exit handler nulls `this.child`, so a check on `this.child?.exitCode` can never see an early exit; a process that died instantly surfaced as "did not report a port in time" 20 seconds later. Early exits are now tracked in a local. Keep it that way — the spawn path is the hardest part of this app to debug remotely.
- **Do not reintroduce a hardcoded model list** as the source of truth, and do not assume a model ID mentioned in this repo still exists — check `POST /models` or `models.list()` first. See "Models are resolved at runtime" above.
- **Only the Deepgram provider requires a second API key.** `main.ts:startSession`, `server.py:start_session`, and `useSession.canStart` each gate on `provider === 'deepgram'`; a new gate that demands the key unconditionally silently breaks the free path.
- The Python tests drive `SessionManager` through its private methods (`_publish_transcript`, `_flush_pending_question_if_ready`, `_yield_queue`, `_on_transcript`) and a `FakeTranscriber` mirroring `start`/`stop`/`feed`. Renaming those breaks the suite even when behaviour is unchanged.
- `python/wingman-server.spec` lists `hiddenimports` explicitly — a new runtime-only Python dependency needs adding there or the packaged exe fails at import time.
- Dev mode depends on `.dev-server.json` (written by `scripts/select-dev-port.mjs`, gitignored). `scripts/launch-electron.mjs` passes its URL as `VITE_DEV_SERVER_URL`, and both main.ts and windowManager.ts use that variable to decide whether a URL is trusted. Nodemon watches `dist/main` and `dist/preload`, so an Electron restart only happens after the vite watch build lands.
- Licensing headers on the main source files say **MIT + Commons Clause (commercial use prohibited)**, matching `LICENSE` and `package.json`'s `"license": "SEE LICENSE IN LICENSE"`. Keep the header when adding files that carry one, and never revert `package.json`'s license field back to a bare `"MIT"` — that would misrepresent the actual grant.
