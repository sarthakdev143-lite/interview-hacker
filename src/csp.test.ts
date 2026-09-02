// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy } from './csp';

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split('; ').map((part) => {
      const [name, ...values] = part.split(' ');
      return [name, values.join(' ')];
    }),
  );
}

describe('contentSecurityPolicy', () => {
  const production = contentSecurityPolicy(null);
  const dev = contentSecurityPolicy('http://127.0.0.1:5173');

  it('denies everything that is not explicitly allowed', () => {
    expect(directives(production).get('default-src')).toBe("'none'");
  });

  it('never allows eval in a packaged build', () => {
    // Vite's HMR client needs unsafe-eval; the shipped renderer must not have
    // it. getDevServerOrigin() returns null when packaged, which is what makes
    // this branch the production one.
    expect(production).not.toContain('unsafe-eval');
    expect(directives(production).get('script-src')).toBe("'self'");
  });

  it('allows eval and the dev origin only when a dev server is present', () => {
    expect(dev).toContain('unsafe-eval');
    expect(directives(dev).get('script-src')).toContain('http://127.0.0.1:5173');
  });

  it('allows the loopback sidecar on an unknown port', () => {
    // The Flask sidecar binds an ephemeral port, so the port cannot be pinned
    // — but the host can, and SSE plus fetch both go through connect-src.
    const connect = directives(production).get('connect-src') ?? '';
    expect(connect).toContain('http://127.0.0.1:*');
    expect(connect).toContain('ws://127.0.0.1:*');
  });

  it('adds the dev websocket origin for HMR', () => {
    expect(directives(dev).get('connect-src')).toContain('ws://127.0.0.1:5173');
  });

  it('keeps object, frame and media closed', () => {
    const d = directives(production);
    expect(d.get('object-src')).toBe("'none'");
    expect(d.get('frame-src')).toBe("'none'");
    expect(d.get('media-src')).toBe("'none'");
  });

  it('blocks base tag and form hijacking', () => {
    const d = directives(production);
    expect(d.get('base-uri')).toBe("'none'");
    expect(d.get('form-action')).toBe("'none'");
  });

  it('does not allow remote font or style origins', () => {
    // The fonts are bundled precisely so this can stay closed; a reintroduced
    // Google Fonts @import would be blocked at runtime and fall back silently.
    const d = directives(production);
    expect(d.get('font-src')).toBe("'self' data:");
    expect(d.get('style-src')).toBe("'self' 'unsafe-inline'");
    expect(production).not.toContain('googleapis');
  });

  it('omits frame-ancestors on the meta path, where it is ignored', () => {
    // Chromium ignores frame-ancestors in a meta tag and logs a warning for it.
    expect(contentSecurityPolicy(null, 'meta')).not.toContain('frame-ancestors');
    expect(contentSecurityPolicy(null, 'header')).toContain("frame-ancestors 'none'");
  });

  it('defaults to the header form', () => {
    expect(contentSecurityPolicy(null)).toBe(contentSecurityPolicy(null, 'header'));
  });

  it('produces no empty directives when there is no dev origin', () => {
    // connect-src is assembled by filtering out blanks; a regression there
    // yields a policy with a dangling separator that Chromium drops entirely.
    expect(production).not.toContain('  ');
    expect(production).not.toContain('; ;');
    for (const [name, value] of directives(production)) {
      expect(name).not.toBe('');
      expect(value.trim()).not.toBe('');
    }
  });
});
