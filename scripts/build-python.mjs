import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pythonDir = path.join(repoRoot, 'python');
const distDir = path.join(pythonDir, 'dist');
const buildDir = path.join(pythonDir, 'build');
const specFile = path.join(pythonDir, 'wingman-server.spec');

const command =
  process.env.WINGMAN_PYTHON_BIN ??
  (process.platform === 'win32' ? 'py' : 'python3');
const prefixArgs =
  process.env.WINGMAN_PYTHON_BIN || process.platform !== 'win32' ? [] : ['-3'];

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
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('\nPython server built successfully.');
console.log('If Windows Defender flags wingman-server.exe:');
console.log('  1. Open Windows Security > Virus & threat protection');
console.log('  2. Add an exclusion for: python/dist/wingman-server/');
console.log('  3. Re-run: npm run package\n');
