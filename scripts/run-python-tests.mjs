// Copyright (c) 2026 Sarthak Parulekar
// Licensed under MIT + Commons Clause — commercial use prohibited.

/**
 * Runs the Python test suite with the interpreter that actually has the
 * dependencies installed.
 *
 * `npm run verify` used to shell out to a bare `python`, which on Windows
 * resolves to whatever is first on PATH — usually a system install without
 * numpy, so the gate failed with an ImportError that looked like a broken test
 * suite. Prefer the project virtualenv, fall back to an active one, then to
 * whatever the platform calls Python.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

function candidates() {
  const found = [];

  if (process.env.WINGMAN_PYTHON_BIN) {
    found.push(process.env.WINGMAN_PYTHON_BIN);
  }

  if (process.env.VIRTUAL_ENV) {
    found.push(
      isWindows
        ? path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe')
        : path.join(process.env.VIRTUAL_ENV, 'bin', 'python'),
    );
  }

  found.push(
    isWindows
      ? path.join(repoRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(repoRoot, '.venv', 'bin', 'python'),
  );

  return found;
}

function resolveInterpreter() {
  for (const candidate of candidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Not a path, so it is resolved via PATH by spawn.
  return isWindows ? 'python' : 'python3';
}

const interpreter = resolveInterpreter();
const args = [
  '-m',
  'unittest',
  'discover',
  '-s',
  'python/tests',
  '-t',
  'python/tests',
  ...process.argv.slice(2),
];

const child = spawn(interpreter, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    // Keep test runs from writing a log file into the user's data directory.
    WINGMAN_LOG_DIR: '',
    WINGMAN_LOG_LEVEL: process.env.WINGMAN_LOG_LEVEL ?? 'CRITICAL',
  },
});

child.on('error', (error) => {
  console.error(
    `Could not run the Python test suite with "${interpreter}": ${error.message}\n` +
      'Create the virtualenv first:\n' +
      '  python -m venv .venv\n' +
      `  ${isWindows ? '.venv\\Scripts\\activate' : 'source .venv/bin/activate'}\n` +
      '  pip install -r python/requirements.txt',
  );
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
