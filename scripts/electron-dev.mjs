import { spawn } from 'node:child_process';
import path from 'node:path';
import waitOn from 'wait-on';
import { readDevServerConfig } from './devServerConfig.mjs';

const { port } = readDevServerConfig();

await waitOn({
  resources: [
    `tcp:127.0.0.1:${port}`,
    'file:dist/main/main.js',
    'file:dist/preload/preload.js',
  ],
});

const nodemonEntry = path.join(
  process.cwd(),
  'node_modules',
  'nodemon',
  'bin',
  'nodemon.js',
);

const child = spawn(process.execPath, [nodemonEntry, '--config', 'nodemon.electron.json'], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
