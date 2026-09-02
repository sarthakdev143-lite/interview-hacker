# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report it privately through
[GitHub Security Advisories](https://github.com/sarthakdev143-lite/interview-hacker/security/advisories/new),
or by email to **sarthakdev143.official@gmail.com** with `[SECURITY]` in the
subject.

Please include:

- the version (`package.json` `version`, or the installer filename)
- your OS and version
- steps to reproduce, and what an attacker gains
- relevant excerpts from `wingman.log` / `wingman-python.log` (see *Logs* below
  before pasting — redact anything you are not comfortable publishing)

You can expect an acknowledgement within **7 days** and an assessment within
**30 days**. This is a solo-maintained project, so please allow reasonable time
before public disclosure. Fixes ship in the next release; credit is given in
the release notes unless you ask otherwise.

## Supported versions

Only the **latest release** receives security fixes. There are no long-term
support branches.

## What this app actually does

Read this before deciding whether a finding is a vulnerability — several of
these are deliberate design decisions, not oversights.

**It records system audio.** WingMan captures the system audio loopback (WASAPI
on Windows, a monitor/BlackHole device elsewhere). During a session, everything
playing through your speakers is captured, segmented by a local VAD, and the
speech portions are uploaded to your configured transcription provider.

**It sends your audio and text to third parties.** Speech goes to Groq
(Whisper) or, if you opt in, Deepgram. Detected questions and any resume text
you upload go to Groq for completion. Their privacy policies govern that data,
not this one. The app has no backend of its own and phones home to nobody.

**It stores interview transcripts unencrypted.** Session history is written as
plaintext JSON under the app's `userData` directory. Anyone with access to your
user account can read it. Use the in-app history controls to delete sessions.

**It hides itself from screen capture.** `setContentProtection(true)` — which
on Windows maps to `WDA_EXCLUDEFROMCAPTURE` — keeps the overlay out of Windows
Graphics Capture, so Zoom/Teams/Meet/OBS do not see it. This is a documented
Electron/OS feature, and it is the entire point of the app. It is not a
vulnerability report.

## Security model

**API keys** are encrypted with Electron `safeStorage` (DPAPI on Windows,
Keychain on macOS, the selected libsecret backend on Linux) and written to
`settings.json` under `userData`. If `safeStorage` reports encryption is
unavailable — including when Linux falls back to the reversible `basic_text`
backend — the app **refuses to store the key** rather than writing it in
plaintext. Keys are never exposed to the renderer; only the booleans
`apiKeyStored` / `deepgramApiKeyStored` cross that boundary.

**The Python sidecar** binds to `127.0.0.1` on an ephemeral port. Every route,
including `/health`, is gated by a 256-bit bearer token compared with
`hmac.compare_digest`. The token is generated per launch and passed to the
child via an environment variable. It never appears in logs — the request
handler strips query strings, because `EventSource` cannot set headers and so
passes the token as `?token=`.

**The renderer** runs with `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, a deny-all `setWindowOpenHandler`, blocked
`will-navigate` / `will-redirect` / `will-frame-navigate`, denied permission
requests, and a strict CSP. All 19 IPC handlers validate the sender before
doing anything.

**Logs** are rotated and capped at 2 MB. Transcript text is replaced with
`<N chars, #sha256[:8]>` unless you explicitly set `WINGMAN_LOG_TRANSCRIPTS=1`,
which exists for debugging and writes real interview text to disk. Do not set
it and then attach the log to a public issue.

### Known limitations — please don't report these as vulnerabilities

- **Same-user attackers can decrypt the stored keys.** `safeStorage` is scoped
  to your OS user account. It protects against other users and offline disk
  access, not against code already running as you.
- **Releases are unsigned.** There is no Authenticode or Apple Developer ID
  signature, so Windows SmartScreen and macOS Gatekeeper will warn. Verify the
  checksum on the release page, or build from source.
- **The installer is per-user**, so it lands in a user-writable directory. Any
  process running as you can modify the app.
- **Bundled model output is rendered as text, never HTML.** If you add markdown
  rendering, re-examine that decision.

## Responsible use

This tool captures audio from meetings that other people are part of. Recording
or transcribing a conversation without consent is illegal in many
jurisdictions — including all-party-consent regions — and violates the terms of
service of most interview and meeting platforms. You are responsible for how
you use it. See the disclaimer in [README.md](README.md).
