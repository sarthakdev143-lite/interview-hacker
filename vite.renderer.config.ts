import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { contentSecurityPolicy } from './src/csp';

const devServerConfigPath = path.resolve(__dirname, '.dev-server.json');

/**
 * Bakes the production CSP into index.html as a <meta http-equiv> tag.
 *
 * The packaged renderer is loaded with `loadFile()` — i.e. `file://` — where
 * the `onHeadersReceived` policy main.ts installs cannot apply, because there
 * is no HTTP response to attach a header to. Without this the shipped build,
 * which is the only one users run, has no CSP at all.
 *
 * `apply: 'build'` is load-bearing: injecting the production policy into the
 * dev server would intersect with the dev header policy and forbid the
 * `unsafe-eval` that Vite's HMR client needs.
 */
function cspMetaTag(): Plugin {
  return {
    name: 'wingman-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return {
          html,
          tags: [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content: contentSecurityPolicy(null, 'meta'),
              },
              injectTo: 'head-prepend',
            },
          ],
        };
      },
    },
  };
}

function getDevServerPort() {
  if (!fs.existsSync(devServerConfigPath)) {
    return 5173;
  }

  try {
    const raw = fs.readFileSync(devServerConfigPath, 'utf8');
    const parsed = JSON.parse(raw) as { port?: number };
    return Number(parsed.port ?? 5173);
  } catch {
    return 5173;
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), cspMetaTag()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: getDevServerPort(),
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
