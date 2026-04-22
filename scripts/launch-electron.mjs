import { spawn } from 'node:child_process';
import path from 'node:path';
import { readDevServerConfig } from './devServerConfig.mjs';

const { url } = readDevServerConfig();
const electronEntry =
  process.platform === 'win32'
    ? path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron');

const env = {
  ...process.env,
  VITE_DEV_SERVER_URL: url,
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronEntry, ['.'], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
