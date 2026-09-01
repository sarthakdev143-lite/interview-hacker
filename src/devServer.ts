// Copyright (c) 2026 Sarthak Parulekar
// Licensed under MIT + Commons Clause — commercial use prohibited.

import { app } from 'electron';

/**
 * Single source of truth for the Vite dev server URL.
 *
 * Three separate trust decisions used to read `process.env.VITE_DEV_SERVER_URL`
 * directly and unguarded: which URL the windows load, which origins
 * `assertTrustedSender` accepts for all IPC, and which origins `will-navigate`
 * allows. That variable comes from `.env`, which `dotenv/config` resolves
 * against the *working directory*, and electron-builder installs per-user into
 * a writable directory. So any unprivileged process could drop a `.env` beside
 * the installed executable and have the next launch load remote HTML into a
 * window holding the full preload bridge — from which it could start sessions,
 * read the sidecar token out of `AppState`, and fetch every stored interview
 * transcript.
 *
 * `WINGMAN_PYTHON_BIN` already got this treatment (see PythonServerManager);
 * this closes the same hole for the renderer.
 *
 * Two guarantees:
 *  - a packaged build ignores the variable entirely, and
 *  - even in development the URL must be http(s) on loopback.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

let cached: string | null | undefined;

function resolveDevServerUrl(): string | null {
  if (app.isPackaged) {
    return null;
  }

  const raw = process.env.VITE_DEV_SERVER_URL?.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function getDevServerUrl(): string | null {
  if (cached === undefined) {
    cached = resolveDevServerUrl();
  }
  return cached;
}

export function getDevServerOrigin(): string | null {
  const url = getDevServerUrl();
  if (!url) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
