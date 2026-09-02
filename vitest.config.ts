import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure logic on the Electron side.
 *
 * Scope is deliberately narrow. main.ts, windowManager.ts and pythonServer.ts
 * import `electron` at module scope, so testing them means either running under
 * Electron or maintaining a mock of the runtime — both of which cost more than
 * they return for code that is mostly wiring. The parts worth testing are the
 * ones where a missed case is a security bug rather than a rendering glitch,
 * and those have been extracted into modules with no Electron dependency:
 * src/validation.ts and src/csp.ts.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The Python suite covers the audio pipeline; this covers the IPC boundary.
    // Neither is a substitute for the other.
    reporters: 'default',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
