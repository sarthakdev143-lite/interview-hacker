// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_URL_ALLOWLIST,
  MAX_CONTEXT_CHARS,
  MAX_RESUME_CHARS,
  normalizeExternalUrl,
  normalizeSettingsUpdates,
  normalizeStartSessionRequest,
  requireFiniteNumber,
  requireString,
} from './validation';

describe('normalizeExternalUrl', () => {
  it('allows the BlackHole link the settings panel actually opens', () => {
    expect(normalizeExternalUrl('https://existential.audio/blackhole/')).toBe(
      'https://existential.audio/blackhole/',
    );
  });

  it('allows every host on the allowlist', () => {
    for (const host of EXTERNAL_URL_ALLOWLIST) {
      expect(normalizeExternalUrl(`https://${host}/x`)).toContain(host);
    }
  });

  it('refuses a host that is not on the allowlist', () => {
    // shell.openExternal leaves the app, so connect-src cannot constrain it.
    // This is the exfiltration channel the allowlist exists to close.
    expect(() => normalizeExternalUrl('https://evil.example/?q=stolen')).toThrow(
      /Refusing to open/,
    );
  });

  it('is not fooled by a suffix that merely ends with an allowed host', () => {
    expect(() => normalizeExternalUrl('https://github.com.evil.example/')).toThrow(
      /Refusing to open/,
    );
  });

  it('is not fooled by an allowed host appearing as a prefix', () => {
    expect(() => normalizeExternalUrl('https://github.community/')).toThrow(
      /Refusing to open/,
    );
  });

  it('does not treat a subdomain as the allowed host', () => {
    // Anyone can be handed a subdomain on some providers, so an
    // endsWith('.github.com') test would have been exploitable.
    expect(() => normalizeExternalUrl('https://attacker.github.com.evil/')).toThrow();
  });

  it('rejects a host smuggled into the userinfo section', () => {
    // Parses as host `evil.example` with username `github.com`. A naive
    // "does the URL contain an allowed host" check would pass this.
    expect(() => normalizeExternalUrl('https://github.com@evil.example/')).toThrow();
  });

  it('rejects credentials even on an allowed host', () => {
    expect(() => normalizeExternalUrl('https://user:pw@github.com/')).toThrow(
      /credentials/,
    );
  });

  it.each([
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ms-msdt:/id',
  ])('rejects the %s scheme', (url) => {
    expect(() => normalizeExternalUrl(url)).toThrow();
  });

  it('rejects http even for an allowed host', () => {
    expect(() => normalizeExternalUrl('http://github.com/')).toThrow(/https/);
  });

  it('rejects a non-string and an unparseable value', () => {
    expect(() => normalizeExternalUrl(undefined as unknown as string)).toThrow();
    expect(() => normalizeExternalUrl('not a url')).toThrow();
  });

  it('rejects an absurdly long URL before parsing it', () => {
    const long = `https://github.com/${'a'.repeat(4000)}`;
    expect(() => normalizeExternalUrl(long)).toThrow(/Invalid external URL/);
  });
});

describe('requireFiniteNumber', () => {
  it('accepts ordinary numbers including zero and negatives', () => {
    expect(requireFiniteNumber(0, 'x')).toBe(0);
    expect(requireFiniteNumber(-12.5, 'x')).toBe(-12.5);
  });

  it.each([NaN, Infinity, -Infinity])('rejects %s', (value) => {
    // These reach setBounds and setOpacity, where a non-finite value is a
    // window that cannot be recovered without editing settings.json by hand.
    expect(() => requireFiniteNumber(value, 'overlayOpacity')).toThrow(/finite/);
  });

  it('rejects values that are not numbers, rather than coercing them', () => {
    // '12' would survive a `Number(value)` check and reach setBounds as a
    // string, so the typeof test is doing real work here.
    for (const value of ['12', null, undefined, {}, [], true]) {
      expect(() => requireFiniteNumber(value, 'x')).toThrow();
    }
  });
});

describe('requireString', () => {
  it('maps null and undefined onto an empty string', () => {
    expect(requireString(undefined, 'x', 10)).toBe('');
    expect(requireString(null, 'x', 10)).toBe('');
  });

  it('rejects a non-string rather than coercing it', () => {
    expect(() => requireString(42, 'Resume text', 10)).toThrow(/must be text/);
  });

  it('accepts input exactly at the limit and rejects one past it', () => {
    expect(requireString('a'.repeat(10), 'x', 10)).toHaveLength(10);
    expect(() => requireString('a'.repeat(11), 'x', 10)).toThrow(/too long/);
  });
});

describe('normalizeSettingsUpdates', () => {
  it('returns only the keys that were supplied', () => {
    expect(normalizeSettingsUpdates({ language: 'es' })).toEqual({ language: 'es' });
  });

  it('falls back to en for a blank language', () => {
    expect(normalizeSettingsUpdates({ language: '   ' }).language).toBe('en');
  });

  it('clamps overlay opacity into the readable range', () => {
    // Below 0.25 the overlay is effectively invisible and the user cannot find
    // it again to fix the setting.
    expect(normalizeSettingsUpdates({ overlayOpacity: -5 }).overlayOpacity).toBe(0.25);
    expect(normalizeSettingsUpdates({ overlayOpacity: 99 }).overlayOpacity).toBe(1);
    expect(normalizeSettingsUpdates({ overlayOpacity: 0.6 }).overlayOpacity).toBe(0.6);
  });

  it('rejects a non-finite opacity instead of clamping it', () => {
    // Math.min/max would happily propagate NaN.
    expect(() => normalizeSettingsUpdates({ overlayOpacity: NaN })).toThrow(/finite/);
  });

  it('rejects an unknown overlay preset', () => {
    expect(() =>
      normalizeSettingsUpdates({ overlayPreset: 'middle' as never }),
    ).toThrow(/Invalid overlay preset/);
  });

  it('rejects an unknown transcription provider', () => {
    // A provider the sidecar does not know fails deep inside session start.
    expect(() =>
      normalizeSettingsUpdates({ transcriptionProvider: 'whisper-local' as never }),
    ).toThrow(/Invalid transcription provider/);
  });

  it('accepts every declared preset and provider', () => {
    for (const preset of ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const) {
      expect(normalizeSettingsUpdates({ overlayPreset: preset }).overlayPreset).toBe(preset);
    }
    for (const provider of ['groq', 'deepgram'] as const) {
      expect(
        normalizeSettingsUpdates({ transcriptionProvider: provider }).transcriptionProvider,
      ).toBe(provider);
    }
  });

  it('coerces historyEnabled to a real boolean', () => {
    expect(normalizeSettingsUpdates({ historyEnabled: 1 as never }).historyEnabled).toBe(true);
  });
});

describe('normalizeStartSessionRequest', () => {
  const valid = {
    resumeText: 'Engineer',
    extraContext: 'Backend role',
    apiKey: 'gsk_test',
    deepgramApiKey: '',
    language: 'en',
    model: 'openai/gpt-oss-120b',
    overlayPreset: 'bottom-right',
    overlayOpacity: 0.9,
    historyEnabled: true,
    transcriptionProvider: 'groq',
  } as never;

  it('passes a valid payload through', () => {
    const result = normalizeStartSessionRequest(valid);
    expect(result.transcriptionProvider).toBe('groq');
    expect(result.overlayOpacity).toBe(0.9);
  });

  it('rejects a non-object payload', () => {
    expect(() => normalizeStartSessionRequest(null as never)).toThrow(
      /Invalid session configuration/,
    );
  });

  it('applies the same enum validation app:save-settings applies', () => {
    // The two paths write the same settings file; validating only one of them
    // is an inconsistent trust boundary, which is what this regressed to before.
    expect(() =>
      normalizeStartSessionRequest({ ...(valid as object), transcriptionProvider: 'nope' } as never),
    ).toThrow(/Invalid transcription provider/);
  });

  it('enforces the sidecar length caps before sending', () => {
    expect(() =>
      normalizeStartSessionRequest({
        ...(valid as object),
        resumeText: 'a'.repeat(MAX_RESUME_CHARS + 1),
      } as never),
    ).toThrow(/too long/);

    expect(() =>
      normalizeStartSessionRequest({
        ...(valid as object),
        extraContext: 'a'.repeat(MAX_CONTEXT_CHARS + 1),
      } as never),
    ).toThrow(/too long/);
  });

  it('supplies defaults for omitted fields', () => {
    const result = normalizeStartSessionRequest({} as never);
    expect(result.language).toBe('en');
    expect(result.overlayPreset).toBe('bottom-right');
    expect(result.transcriptionProvider).toBe('groq');
    expect(result.resumeText).toBe('');
  });
});
