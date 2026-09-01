import {
  execFile,
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { HealthPayload } from './types/contracts';

const PORT_PREFIX = 'PORT:';
const execFileAsync = promisify(execFile);

export interface PythonServerExitInfo {
  code: number | null;
  expected: boolean;
}

interface PythonServerManagerOptions {
  onExit?: (info: PythonServerExitInfo) => void;
}

function splitLines(buffer: string) {
  return buffer.split(/\r?\n/).filter(Boolean);
}

export class PythonServerManager {
  constructor(
    private readonly isPackaged: boolean,
    private readonly options: PythonServerManagerOptions = {},
  ) {}

  private child: ChildProcessWithoutNullStreams | null = null;

  private port: number | null = null;

  private readonly authToken = randomBytes(32).toString('hex');

  private isExpectedShutdown = false;

  private lastPortProbeAt = 0;

  async start(historyDir: string): Promise<HealthPayload> {
    if (this.child && this.port) {
      return this.getHealth();
    }

    await fs.mkdir(historyDir, { recursive: true });

    const { command, args } = this.getSpawnTarget();
    this.isExpectedShutdown = false;
    this.lastPortProbeAt = 0;
    this.child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        WINGMAN_HISTORY_DIR: historyDir,
        WINGMAN_SERVER_TOKEN: this.authToken,
        // The sidecar logs to a rotating file here. Its stdout/stderr go to a
        // console that does not exist in a packaged build (console=False +
        // windowsHide), so without this a shipped app has no diagnostics at all.
        WINGMAN_LOG_DIR: path.dirname(historyDir),
      },
      stdio: 'pipe',
      windowsHide: true,
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let spawnError: Error | null = null;

    this.child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        if (line.startsWith(PORT_PREFIX)) {
          this.port = Number(line.slice(PORT_PREFIX.length));
        } else {
          console.log(`[wingman-python] ${line}`);
        }
      }
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer += text;
      for (const line of splitLines(text)) {
        console.error(`[wingman-python] ${line}`);
      }
    });

    this.child.once('error', (error) => {
      spawnError = error;
      stderrBuffer += `${error.message}\n`;
    });

    // The pid is captured here because the exit handler clears `this.child`,
    // and the netstat lookup below still needs it.
    const childPid = this.child.pid;
    let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

    this.child.on('exit', (code, signal) => {
      const expected = this.isExpectedShutdown;
      if (code !== 0 && code !== null) {
        console.error(`[wingman-python] exited with code ${code}`);
      }
      earlyExit = { code, signal };
      this.child = null;
      this.port = null;
      this.isExpectedShutdown = false;
      this.options.onExit?.({ code, expected });
    });

    const startedAt = Date.now();
    while (!this.port) {
      if (spawnError) {
        throw new Error(
          `Failed to start Python server (${command}): ${spawnError.message}`,
        );
      }

      // A child that has already exited leaves `this.child` null, so this must
      // be tracked separately. Reading `this.child?.exitCode` here instead used
      // to yield undefined and fall through to the 20s timeout below, reporting
      // "did not report a port in time" for a process that had died instantly.
      const exit: { code: number | null; signal: NodeJS.Signals | null } | null =
        earlyExit;
      if (exit) {
        const cause = exit.signal
          ? `was terminated by ${exit.signal}`
          : `exited with code ${exit.code}`;
        throw new Error(
          `Python server ${cause} before reporting a port. Command: ${command}. ${stderrBuffer}`.trim(),
        );
      }

      if (this.isPackaged && childPid) {
        const discoveredPort = await this.discoverPortFromProcess(childPid);
        if (discoveredPort) {
          this.port = discoveredPort;
          console.log(
            `[wingman-python] discovered port ${discoveredPort} from process lookup`,
          );
          break;
        }
      }

      if (Date.now() - startedAt > 20000) {
        throw new Error(
          `Python server did not report a port in time. Command: ${command}. ${stderrBuffer}`.trim(),
        );
      }
      await delay(200);
    }

    return this.waitForHealth();
  }

  async getHealth(): Promise<HealthPayload> {
    if (!this.port) {
      throw new Error('Python server is not running.');
    }

    const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Health check failed with status ${response.status}.`);
    }
    return (await response.json()) as HealthPayload;
  }

  getPort() {
    return this.port;
  }

  getAuthToken() {
    return this.authToken;
  }

  isRunning() {
    return Boolean(this.child && this.port);
  }

  private async waitForHealth(): Promise<HealthPayload> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 20000) {
      try {
        return await this.getHealth();
      } catch {
        await delay(250);
      }
    }

    throw new Error('Python server failed to become healthy in time.');
  }

  private async discoverPortFromProcess(pid: number) {
    if (!pid) {
      return null;
    }

    const now = Date.now();
    if (now - this.lastPortProbeAt < 1000) {
      return null;
    }
    this.lastPortProbeAt = now;

    if (process.platform === 'win32') {
      try {
        const { stdout } = await execFileAsync(
          'netstat',
          ['-ano', '-p', 'tcp'],
          {
            windowsHide: true,
          },
        );

        for (const line of stdout.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 5) {
            continue;
          }

          const [protocol, localAddress, , state, owningPid] = parts;
          if (
            protocol !== 'TCP' ||
            state !== 'LISTENING' ||
            owningPid !== String(pid)
          ) {
            continue;
          }

          const match = localAddress.match(/:(\d+)$/);
          if (!match) {
            continue;
          }

          const port = Number(match[1]);
          if (Number.isFinite(port) && port > 0) {
            return port;
          }
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  /** The frozen sidecar shipped alongside a packaged build, if there is one. */
  private getBundledBinary() {
    if (!this.isPackaged) {
      return null;
    }

    return path.join(
      process.resourcesPath,
      'python',
      'wingman-server',
      process.platform === 'win32' ? 'wingman-server.exe' : 'wingman-server',
    );
  }

  private getSpawnTarget() {
    const serverScript = path.join(process.cwd(), 'python', 'server.py');
    const override = process.env.WINGMAN_PYTHON_BIN?.trim();

    // A packaged install ships its own sidecar and must run it. Honouring the
    // override first meant a stray .env in the working directory could point a
    // shipped app at a developer virtualenv that will not exist on the user's
    // machine — which is exactly how this failed when the packaged build was
    // launched from the repo. The override survives only as a rescue hatch for
    // when the bundled binary is missing.
    const bundled = this.getBundledBinary();
    if (bundled) {
      if (existsSync(bundled)) {
        return { command: bundled, args: [] };
      }

      console.warn(
        `[wingman-python] bundled sidecar missing at ${bundled}; falling back to WINGMAN_PYTHON_BIN`,
      );
    }

    if (override) {
      return { command: override, args: ['-u', serverScript] };
    }

    if (process.platform === 'win32') {
      return {
        command: path.join(process.cwd(), '.venv', 'Scripts', 'python.exe'),
        args: ['-u', serverScript],
      };
    }

    return { command: 'python3', args: ['-u', serverScript] };
  }

  async request<T>(route: string, init?: RequestInit): Promise<T> {
    if (!this.port) {
      throw new Error('Python server is not available.');
    }

    const response = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(details || `Request failed with status ${response.status}.`);
    }

    return (await response.json()) as T;
  }

  async shutdown() {
    if (!this.child) {
      return;
    }

    this.isExpectedShutdown = true;
    if (this.port) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/session/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
          body: '{}',
        });
      } catch {
        // Ignore session stop failures during shutdown.
      }

      try {
        await fetch(`http://127.0.0.1:${this.port}/shutdown`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
          body: '{}',
        });
      } catch {
        // Ignore shutdown request failures; the process is terminated below if needed.
      }
    }

    const child = this.child;
    const exitPromise = once(child, 'exit');
    try {
      await Promise.race([exitPromise, delay(4000)]);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  }

  private authHeaders() {
    return {
      'X-Wingman-Token': this.authToken,
    };
  }
}
