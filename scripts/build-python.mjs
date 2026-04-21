import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pythonDir = path.join(repoRoot, 'python');
const serverEntry = path.join(pythonDir, 'server.py');
const distDir = path.join(pythonDir, 'dist');
const buildDir = path.join(pythonDir, 'build');
const specDir = buildDir;

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
  '--onefile',
  '--name',
  'wingman-server',
  '--distpath',
  distDir,
  '--workpath',
  buildDir,
  '--specpath',
  specDir,
  serverEntry,
];

const result = spawnSync(command, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
