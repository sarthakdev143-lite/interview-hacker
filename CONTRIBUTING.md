# Contributing to WingMan

Thanks for taking the time. This document covers the setup, the one gate every
change has to pass, and the handful of conventions that are easy to violate
without noticing.

By contributing you agree your work is licensed under the [MIT License](LICENSE).

## Setup

```bash
git clone https://github.com/sarthakdev143-lite/interview-hacker.git
cd interview-hacker
npm install

# The app spawns this venv directly — .venv/Scripts/python.exe on Windows,
# .venv/bin/python elsewhere — so the deps must go in it, not in system Python.
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r python/requirements.txt

npm run dev
```

You need a [Groq API key](https://console.groq.com/keys) to run a session. The
free tier is enough and needs no credit card.

## The gate

```bash
npm run verify     # typecheck + lint + vitest + python tests
```

**Every PR must pass this.** CI runs it on Windows, macOS and Linux.

Run a single Python test file, or one test, with the venv interpreter so `numpy`
and friends resolve:

```bash
.venv/Scripts/python.exe python/tests/test_vad.py
.venv/Scripts/python.exe python/tests/test_llm.py ResolveModelsTests.test_retired_model_falls_back_and_is_reported
```

TypeScript tests run under Vitest:

```bash
npm test           # once
npm run test:watch # while working
```

Their scope is deliberately narrow. `main.ts`, `windowManager.ts` and
`pythonServer.ts` import `electron` at module scope, so testing them means
running under Electron or maintaining a mock of the runtime — more cost than
value for code that is mostly wiring. The parts worth testing are the ones where
a missed case is a security bug, and those live in modules with no Electron
import: `src/validation.ts` and `src/csp.ts`. **If you add logic to `main.ts`
that deserves a test, move it into one of those first.**

## Architecture in one screen

Three runtimes, two transports. [README.md](README.md#️-architecture) has the
full picture; the short version:

- **Electron main** (`src/main.ts`) owns the single `AppState`, the Python
  sidecar lifecycle, global shortcuts and all IPC.
- **Renderer** is one React bundle loaded twice — dashboard at `#/dashboard`,
  overlay at `#/overlay`. Each window runs its own hooks and SSE connections.
- **Python sidecar** (`python/server.py`) is Flask on an ephemeral loopback port.

The two transports are easy to conflate, so be explicit about which one you are
adding to:

- **Control plane** — renderer → `window.wingman.*` (preload) → `ipcMain.handle`
  → `PythonServerManager.request()`. Sessions, settings, keys, overlay geometry.
- **Data plane** — the renderer talks to Flask *directly*: SSE
  `/transcript/stream` and `/answer/stream`, plus `/answer/manual`,
  `/resume/upload`, `/history`.

## Conventions that will bite you

**Adding an IPC channel is four edits, in this order.** `WingmanApi` in
`src/types/contracts.ts` → bridge method in `src/preload.ts` → `ipcMain.handle`
in `src/main.ts` **starting with `assertTrustedSender(event)`** → renderer call
site. Numeric payloads go through `requireFiniteNumber()`, enum-ish settings
through `normalizeSettingsUpdates()`. All 19 existing handlers do this; a new
one that skips the sender check will be rejected.

**API keys never cross to the renderer.** Anything needing a key is a
control-plane call that reads it from `SecureStore` in main. Copy
`app:list-models`. Only the `apiKeyStored` booleans are exposed.

**Every background worker must be fenced to its runtime.** Capture `runtime_id`,
`stop_event` and `llm` at start, and re-check `self.runtime_id != runtime_id`
before emitting anything. Otherwise a stopped session leaks tokens into the next
one. `test_stale_answer_worker_does_not_emit_after_stop` guards this.

**Never hardcode a model ID as the source of truth.** Groq retires them, and a
saved user preference outlives them — this repo has already been broken by
exactly that. `LLMClient.resolve_models()` resolves at session start. Check
`POST /models` before assuming an ID still exists.

**The VAD minimum is measured in voiced frames, not clip length.** Pre-roll and
the retained tail are padding. Letting them satisfy the minimum sends keyboard
clicks to a paid endpoint.

**The Python tests drive `SessionManager` through private methods**
(`_publish_transcript`, `_flush_pending_question_if_ready`, `_yield_queue`,
`_on_transcript`) and a `FakeTranscriber`. Renaming those breaks the suite even
when behaviour is unchanged.

**New runtime Python dependencies need adding to `python/wingman-server.spec`**
under `hiddenimports`, or the packaged exe fails at import time.

**`WINGMAN_PYTHON_BIN` is a dev-only override.** A packaged build runs the
bundled sidecar and falls back to the override only when that binary is missing.
Test packaged behaviour with `release/win-unpacked/WingMan.exe`, not just
`npm run dev`.

## Performance changes

End-of-question to first answer token is ~800 ms on the default Groq path and it
is the number that decides whether the app is usable live. The stages interact —
the VAD hangover is partly hidden by the speaker's own trailing silence — so
**re-measure before and after** rather than reasoning about one stage in
isolation. Include the numbers in your PR.

## Pull requests

- Branch off `master`, keep PRs focused on one thing.
- Explain *why*, not just *what*. The existing comments in this codebase explain
  reasoning and constraints; match that standard.
- Run `npm run verify` before pushing.
- Add a Python test for behavioural changes to the audio/question pipeline.
- Note the platforms you tested on. Windows is the only one with a packaged
  build, and macOS/Linux fixes are especially welcome.

## Good first issues

- `electron-builder.yml` has no `mac:` or `linux:` targets.
- Linux capture protection is X11-only; Wayland is unsolved.
- Every question-detection heuristic in `session_manager.py` is an English
  keyword list. `_needs_classifier()` covers the gap, but native-language
  heuristics would be better.
- The renderer (React components and hooks) has no test coverage — only the
  main-side validators do.

## Reporting bugs

Use the issue templates. Include your OS and version, the app version, the
transcription provider, and the relevant part of `userData/wingman.log` or
`wingman-python.log`.

Transcript text is hash-redacted in logs by default. If you set
`WINGMAN_LOG_TRANSCRIPTS=1` to debug, **do not** then attach that log to a
public issue — it contains real interview content.

Security issues go to [SECURITY.md](SECURITY.md), not the public tracker.
