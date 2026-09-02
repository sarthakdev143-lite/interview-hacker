# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before `0.1.0` were tagged but never accompanied by notes; the entries
below are reconstructed from the commit history.

## [Unreleased]

### Added

- macOS (`.dmg`, `.zip`) and Linux (`.AppImage`, `.deb`) builds. Previously the
  README claimed cross-platform support that no artifact backed — those users
  could only run from source.
- CI on Windows, macOS and Linux running the full `verify` gate, plus a guard
  that fails the build if the renderer loses its CSP or reacquires a remote
  font dependency.
- Tagged releases are built and published by CI with `SHA256SUMS`, one runner
  per platform because the PyInstaller sidecar cannot cross-build.
- Vitest, with 50 cases covering the IPC payload validators and the CSP
  builder. The TypeScript side previously had no tests at all.
- `SECURITY.md`, `CONTRIBUTING.md`, issue and pull request templates, and a
  disclaimer stating what the app records and who should not use it.
- Session history browsing, paging, deletion and wipe.
- A rotating sidecar log that redacts transcript text by default.

### Changed

- **Relicensed to MIT.** The previous licence called itself "MIT with Commons
  Clause" and was neither: it dropped MIT's merge, publish and sublicense
  grants, added a non-commercial restriction, and omitted both the attribution
  and the limitation-of-liability clauses.
- Fonts are bundled rather than fetched from Google, removing a network round
  trip and a third-party request on every launch.
- The overlay preset list moved to `contracts.ts` beside the type it has to
  agree with, and the IPC validators moved to `src/validation.ts` so they can
  be tested without Electron.
- Strict TypeScript, and ESLint rules that encode the architecture — notably
  forcing renderer traffic through `src/lib/backend.ts`.

### Fixed

- **The packaged app had no Content-Security-Policy.** The policy was delivered
  as an HTTP response header, but the shipped build loads over `file://` where
  headers do not apply. Only development was ever protected.
- **Bundled fonts were silently blocked.** `src/index.css` imported them from
  Google, which the CSP forbade, so the app had been quietly falling back to
  system fonts.
- **`npm run dev` could not work on macOS or Linux.** The sidecar spawned a bare
  `python3` instead of the project virtualenv, so it died at import. Packaging
  had the same bug and required PyInstaller installed globally.
- `app:open-external` accepted any http or https URL, leaving an exfiltration
  channel the CSP cannot constrain. Now an exact-match allowlist.
- `settings.json`, both log files and history records were written with default
  permissions — world-readable on POSIX. History records are plaintext
  transcripts.
- PDF text extraction was bounded in pages but not in output, so a compressed
  PDF could exhaust memory and take the audio device down with the sidecar.
- Four commits were misattributed to another contributor's git identity.

## [0.0.5-alpha] - 2026-04-25

### Added

- Cross-platform window capture protection, and overlay resize with bounds
  management.
- Multilingual sessions: utterances with no English signal are routed to the
  classifier instead of being dropped.
- Rate-limit handling — retries honouring `Retry-After` with capped backoff,
  then fallback to a sibling model.
- Model caching, and a settle window for question processing.

### Fixed

- App name is set before the instance lock and userData path resolve.
- Python server startup errors are reported accurately instead of always
  surfacing as a timeout.

## [0.0.4-beta] - 2026-04-24

### Added

- Overlay opacity control, and unit tests for the LLM, transcriber, usage and
  VAD modules.

## [0.0.3-alpha] - 2026-04-23

### Added

- Runtime ID fencing for session workers, improved question classification, and
  trailing-filler / answer lead-in handling.

## [0.0.2-alpha] - 2026-04-23

### Added

- Development server configuration improvements and UI refinements.

## [0.0.1-alpha] - 2026-04-23

Initial tagged build: system audio capture, transcription, question detection,
streamed answers and the capture-protected overlay.

[Unreleased]: https://github.com/sarthakdev143-lite/interview-hacker/compare/v0.0.5-alpha...HEAD
[0.0.5-alpha]: https://github.com/sarthakdev143-lite/interview-hacker/compare/v0.0.4-beta...v0.0.5-alpha
[0.0.4-beta]: https://github.com/sarthakdev143-lite/interview-hacker/compare/v0.0.3-alpha...v0.0.4-beta
[0.0.3-alpha]: https://github.com/sarthakdev143-lite/interview-hacker/compare/v0.0.2-alpha...v0.0.3-alpha
[0.0.2-alpha]: https://github.com/sarthakdev143-lite/interview-hacker/compare/v0.0.1-alpha...v0.0.2-alpha
[0.0.1-alpha]: https://github.com/sarthakdev143-lite/interview-hacker/releases/tag/v0.0.1-alpha
