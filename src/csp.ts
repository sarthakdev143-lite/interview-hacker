// Copyright (c) 2026 Sarthak Parulekar
// SPDX-License-Identifier: MIT

/**
 * Content-Security-Policy for the renderer.
 *
 * The renderer holds the sidecar token and the full preload bridge, so an
 * injected script — from a dependency, or from markdown rendered into an
 * answer — would have everything it needs.
 *
 * `connect-src` is the interesting one: the data plane talks directly to the
 * Flask sidecar on an *ephemeral* loopback port, so the port cannot be pinned,
 * but the host can. `style-src` needs 'unsafe-inline' because Tailwind's
 * runtime injects style tags; scripts do not, so `script-src` stays strict.
 *
 * This lives in its own module because the policy has to reach the renderer by
 * two different routes, and they must not drift:
 *
 * - **dev** loads over `http://127.0.0.1:<port>`, so main.ts can attach it as a
 *   response header via `onHeadersReceived`, and the dev origin has to be
 *   allowed (Vite's HMR client is eval-based).
 * - **packaged** loads over `file://` via `loadFile()`, where response headers
 *   do not exist. That build is the only one users run, so the policy is baked
 *   into index.html as a `<meta http-equiv>` tag at build time by
 *   vite.renderer.config.ts, which calls this with `devOrigin = null`.
 *
 * A meta tag and a header are combined by taking the *intersection*, so the
 * production tag must never be injected into a dev build — it would forbid the
 * eval Vite needs. `apply: 'build'` on the Vite plugin enforces that.
 */
export function contentSecurityPolicy(
  devOrigin: string | null,
  delivery: 'header' | 'meta' = 'header',
): string {
  const scriptSrc = devOrigin
    ? // Vite's HMR client is eval-based; this branch is unreachable in a
      // packaged build because getDevServerOrigin() returns null there.
      `'self' 'unsafe-inline' 'unsafe-eval' ${devOrigin}`
    : `'self'`;
  const connectSrc = [
    `'self'`,
    'http://127.0.0.1:*',
    'ws://127.0.0.1:*',
    devOrigin ?? '',
    devOrigin ? devOrigin.replace(/^http/, 'ws') : '',
  ]
    .filter(Boolean)
    .join(' ');

  return [
    `default-src 'none'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc}`,
    `media-src 'none'`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `worker-src 'self' blob:`,
    `base-uri 'none'`,
    `form-action 'none'`,
    // frame-ancestors is ignored when delivered in a <meta> tag and Chromium
    // logs a console warning for it, so only emit it on the header path. No
    // protection is lost: the window is top-level and setWindowOpenHandler
    // denies every child window anyway.
    ...(delivery === 'header' ? [`frame-ancestors 'none'`] : []),
  ].join('; ');
}
