// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

/**
 * Payload validation for the IPC boundary.
 *
 * Everything here runs on the main side of a `contextBridge` call, on data the
 * renderer supplied. It lives outside main.ts so it can be tested without
 * standing up Electron: main.ts imports `app`, `session` and `globalShortcut`
 * at module scope, so importing it from a test runner pulls in the whole
 * runtime. These functions are pure, so they are cheap to test exhaustively —
 * and they are exactly the functions where a missed case is a security bug
 * rather than a rendering glitch.
 */

import {
  DEFAULT_ANSWER_MODEL,
  OVERLAY_PRESETS,
  TRANSCRIPTION_PROVIDERS,
  type OverlayPreset,
  type PublicSettings,
  type StartSessionRequest,
  type TranscriptionProvider,
} from './types/contracts';

// Generous for real input, finite for anything else. Mirrors the caps the
// sidecar applies, so an oversized field is rejected before it is sent.
export const MAX_RESUME_CHARS = 60_000;
export const MAX_CONTEXT_CHARS = 20_000;
export const MAX_API_KEY_CHARS = 512;

/**
 * Hosts the renderer may hand to the user's browser.
 *
 * `shell.openExternal` leaves the app entirely, so the CSP's `connect-src`
 * cannot constrain it: a compromised renderer that can only reach loopback
 * over fetch can still exfiltrate to anywhere by asking main to open a URL
 * with the data in the query string. Validating only the scheme — which is
 * what this did — leaves that channel open.
 *
 * Matching is exact, not by suffix: a suffix test would accept
 * `github.com.example.net`, and an `endsWith('.github.com')` test would accept
 * an attacker-controlled subdomain on any host that hands them out.
 */
export const EXTERNAL_URL_ALLOWLIST: ReadonlySet<string> = new Set([
  // Linked from SettingsPanel when macOS has no loopback device.
  'existential.audio',
  // Where users get the API keys the app asks for.
  'console.groq.com',
  'console.deepgram.com',
  // Repo, issues, releases.
  'github.com',
]);

export function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function requireString(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be text.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} is too long (limit ${maxLength} characters).`);
  }
  return value;
}

type SettingsUpdates = Partial<Omit<PublicSettings, 'apiKeyStored' | 'deepgramApiKeyStored'>>;

export function normalizeSettingsUpdates(updates: SettingsUpdates): SettingsUpdates {
  const normalized: SettingsUpdates = {};

  if (updates.language !== undefined) {
    normalized.language = String(updates.language).trim() || 'en';
  }
  if (updates.model !== undefined) {
    normalized.model = String(updates.model).trim() || DEFAULT_ANSWER_MODEL;
  }
  if (updates.overlayPreset !== undefined) {
    const preset = updates.overlayPreset as OverlayPreset;
    if (!OVERLAY_PRESETS.includes(preset)) {
      throw new Error('Invalid overlay preset.');
    }
    normalized.overlayPreset = preset;
  }
  if (updates.overlayOpacity !== undefined) {
    normalized.overlayOpacity = Math.max(
      0.25,
      Math.min(requireFiniteNumber(updates.overlayOpacity, 'overlayOpacity'), 1),
    );
  }
  if (updates.historyEnabled !== undefined) {
    normalized.historyEnabled = Boolean(updates.historyEnabled);
  }
  if (updates.transcriptionProvider !== undefined) {
    const provider = updates.transcriptionProvider as TranscriptionProvider;
    if (!TRANSCRIPTION_PROVIDERS.includes(provider)) {
      throw new Error('Invalid transcription provider.');
    }
    normalized.transcriptionProvider = provider;
  }

  return normalized;
}

/**
 * `session:start` persists settings and drives window geometry, but it used to
 * do so without any of the validation `app:save-settings` applies — an
 * inconsistent trust boundary for two paths that write the same file.
 */
export function normalizeStartSessionRequest(
  config: StartSessionRequest,
): StartSessionRequest {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid session configuration.');
  }

  const settings = normalizeSettingsUpdates({
    language: config.language,
    model: config.model,
    overlayPreset: config.overlayPreset,
    overlayOpacity: config.overlayOpacity,
    historyEnabled: config.historyEnabled,
    transcriptionProvider: config.transcriptionProvider,
  });

  return {
    ...config,
    resumeText: requireString(config.resumeText, 'Resume text', MAX_RESUME_CHARS),
    extraContext: requireString(config.extraContext, 'Extra context', MAX_CONTEXT_CHARS),
    apiKey: requireString(config.apiKey, 'Groq API key', MAX_API_KEY_CHARS),
    deepgramApiKey: requireString(
      config.deepgramApiKey,
      'Deepgram API key',
      MAX_API_KEY_CHARS,
    ),
    language: settings.language ?? 'en',
    model: settings.model ?? DEFAULT_ANSWER_MODEL,
    overlayPreset: settings.overlayPreset ?? 'bottom-right',
    overlayOpacity: settings.overlayOpacity ?? 0.95,
    historyEnabled: settings.historyEnabled ?? false,
    transcriptionProvider: settings.transcriptionProvider ?? 'groq',
  };
}

export function normalizeExternalUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    throw new Error('Invalid external URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid external URL.');
  }

  // http is dropped as well as the exotic schemes. Every allowed destination is
  // https, and permitting http would let a network attacker read the URL.
  if (parsed.protocol !== 'https:') {
    throw new Error('Only https URLs can be opened externally.');
  }

  // `https://user:pass@host/` renders as the credentials in some browsers and
  // is never something this app needs to open.
  if (parsed.username || parsed.password) {
    throw new Error('External URLs must not carry credentials.');
  }

  if (!EXTERNAL_URL_ALLOWLIST.has(parsed.hostname)) {
    throw new Error(`Refusing to open an external URL for ${parsed.hostname}.`);
  }

  return parsed.toString();
}
