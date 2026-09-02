import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pythonDir = path.join(repoRoot, 'python');
const distDir = path.join(pythonDir, 'dist');
const buildDir = path.join(pythonDir, 'build');
const specFile = path.join(pythonDir, 'wingman-server.spec');

// Resolve the Python executable.
//
// This has to be the *same* interpreter the project's dependencies were
// installed into, because PyInstaller bundles what it can import. It used to
// resolve to `py -3` on Windows and `python3` elsewhere — the system
// interpreter — so packaging only worked if PyInstaller, flask, groq and
// numpy had all been installed globally, which is exactly what the venv in
// the README exists to avoid. Prefer the venv and fall back to the system
// interpreter only when there isn't one.
//
// Using `shell: false` so that args with spaces are passed as-is to the
// process (no shell word-splitting on paths like "My Codes/...").
const venvPython =
  process.platform === 'win32'
    ? path.join(repoRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(repoRoot, '.venv', 'bin', 'python');

let command;
let prefixArgs = [];

if (process.env.WINGMAN_PYTHON_BIN) {
  command = process.env.WINGMAN_PYTHON_BIN;
} else if (existsSync(venvPython)) {
  command = venvPython;
} else if (process.platform === 'win32') {
  command = 'py';
  prefixArgs = ['-3'];
} else {
  command = 'python3';
}

console.log(`Building Python sidecar with: ${command}`);

const args = [
  ...prefixArgs,
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--distpath',
  distDir,
  '--workpath',
  buildDir,
  specFile,
];

const result = spawnSync(command, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  // shell: false — pass args as an array so paths with spaces are safe
  shell: false,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('\nPython server built successfully.');
console.log('If Windows Defender flags wingman-server.exe:');
console.log('  1. Open Windows Security > Virus & threat protection');
console.log('  2. Add an exclusion for: python/dist/wingman-server/');
console.log('  3. Re-run: npm run package\n');
