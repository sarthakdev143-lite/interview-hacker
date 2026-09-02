## What and why

<!-- What changes, and what problem it solves. Explain the reasoning, not just
     the diff — this codebase documents *why* and PRs should match. -->

Closes #

## How it was verified

<!-- Delete what does not apply. -->

- [ ] `npm run verify` passes (typecheck + lint + Python tests)
- [ ] Added or updated Python tests for behavioural changes
- [ ] Tested a real session end to end
- [ ] Tested the packaged build (`release/win-unpacked/WingMan.exe`), not just `npm run dev`

Platforms tested:

## Checklist for the areas that bite

<!-- Only tick the ones your change touches. -->

- [ ] **New IPC channel** — four edits in order (`contracts.ts` → `preload.ts` →
      `ipcMain.handle` starting with `assertTrustedSender(event)` → renderer),
      payloads validated
- [ ] **New background worker** — captures `runtime_id` / `stop_event` / `llm`
      at start and re-checks `self.runtime_id` before emitting
- [ ] **New Python runtime dependency** — added to `hiddenimports` in
      `python/wingman-server.spec`
- [ ] **Model IDs** — resolved at runtime, not hardcoded as the source of truth
- [ ] **Touches the latency path** — re-measured; numbers below
- [ ] **New source file** — carries the `Copyright` + `SPDX-License-Identifier: MIT`
      header if its siblings do

## Latency

<!-- Only if you touched the audio → answer path. Before/after, measured. -->
