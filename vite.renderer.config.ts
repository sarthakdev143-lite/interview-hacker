import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const devServerConfigPath = path.resolve(__dirname, '.dev-server.json');

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
  plugins: [react()],
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
