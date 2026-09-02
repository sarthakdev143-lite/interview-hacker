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
const MAX_STDERR_BUFFER = 16 * 1024;

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
        // Lets the sidecar exit on its own if this process dies without running
        // shutdown() — killed from Task Manager, or hard-crashed. Otherwise it
        // survives holding the loopback capture device and a listening socket.
        WINGMAN_PARENT_PID: String(process.pid),
      },
      stdio: 'pipe',
      windowsHide: true,
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    // These are written from event callbacks and read from the poll loop below.
    // TypeScript's control-flow analysis does not track assignments made inside
    // a nested function, so plain `let` bindings would narrow to `null` at the
    // read sites. A holder object keeps them honestly typed.
    const startup: {
      spawnError: Error | null;
      exit: { code: number | null; signal: NodeJS.Signals | null } | null;
    } = { spawnError: null, exit: null };

    this.child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        if (line.startsWith(PORT_PREFIX)) {
          this.port = Number(line.slice(PORT_PREFIX.length));
        } else {
          console.warn(`[wingman-python] ${line}`);
        }
      }
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Only used to explain a startup failure, but the handler stays attached
      // for the life of the process, so it must not grow without bound.
      stderrBuffer = (stderrBuffer + text).slice(-MAX_STDERR_BUFFER);
      for (const line of splitLines(text)) {
        console.error(`[wingman-python] ${line}`);
      }
    });

    this.child.once('error', (error) => {
      startup.spawnError = error;
      stderrBuffer += `${error.message}\n`;
    });

    // The pid is captured here because the exit handler clears `this.child`,
    // and the netstat lookup below still needs it.
    const childPid = this.child.pid;

    this.child.on('exit', (code, signal) => {
      const expected = this.isExpectedShutdown;
      if (code !== 0 && code !== null) {
        console.error(`[wingman-python] exited with code ${code}`);
      }
      startup.exit = { code, signal };
      this.child = null;
      this.port = null;
      this.isExpectedShutdown = false;
      this.options.onExit?.({ code, expected });
    });

    const startedAt = Date.now();
    while (!this.port) {
      const failure = startup.spawnError;
      if (failure) {
        throw new Error(
          `Failed to start Python server (${command}): ${failure.message}`,
        );
      }

      // A child that has already exited leaves `this.child` null, so this must
      // be tracked separately. Reading `this.child?.exitCode` here instead used
      // to yield undefined and fall through to the 20s timeout below, reporting
      // "did not report a port in time" for a process that had died instantly.
      const exit = startup.exit;
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
          console.warn(
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

    // The venv layout differs by platform: Scripts/python.exe on Windows,
    // bin/python everywhere else. Only the Windows branch used to exist, so on
    // macOS and Linux this fell through to a bare `python3` — the interpreter
    // on PATH, which does not have flask/groq/numpy installed. That made the
    // documented setup (create .venv, pip install -r) fail at import with no
    // hint as to why. Fall back to `python3` only when there is no venv.
    const venvPython =
      process.platform === 'win32'
        ? path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
        : path.join(process.cwd(), '.venv', 'bin', 'python');

    if (existsSync(venvPython)) {
      return { command: venvPython, args: ['-u', serverScript] };
    }

    return {
      command: process.platform === 'win32' ? venvPython : 'python3',
      args: ['-u', serverScript],
    };
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
    const exitController = new AbortController();
    const exitPromise = once(child, 'exit', { signal: exitController.signal }).catch(
      () => undefined,
    );

    try {
      await Promise.race([exitPromise, delay(4000)]);
    } finally {
      // Without this, `once` keeps its listener attached whenever the timeout
      // wins the race.
      exitController.abort();
      await this.terminate(child);
    }
  }

  /**
   * Terminates the sidecar, escalating until it is actually gone.
   *
   * A polite SIGTERM with no follow-up is not enough: the sidecar can be
   * blocked inside a native audio callback, and it holds the WASAPI loopback
   * device and a listening socket. Leaving it running means the next launch
   * finds the device busy.
   */
  private async terminate(child: ChildProcessWithoutNullStreams) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.kill();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      await delay(200);
    }

    if (process.platform === 'win32' && child.pid) {
      // SIGTERM is emulated on Windows and a frozen PyInstaller process can
      // ignore it. taskkill /T /F takes the whole tree.
      try {
        await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
        });
        return;
      } catch {
        // Fall through to SIGKILL.
      }
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private authHeaders() {
    return {
      'X-Wingman-Token': this.authToken,
    };
  }
}
