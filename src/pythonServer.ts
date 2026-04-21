import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { HealthPayload } from './types/contracts';

const PORT_PREFIX = 'PORT:';

function splitLines(buffer: string) {
  return buffer.split(/\r?\n/).filter(Boolean);
}

export class PythonServerManager {
  constructor(private readonly isPackaged: boolean) {}

  private child: ChildProcessWithoutNullStreams | null = null;

  private port: number | null = null;

  async start(historyDir: string): Promise<HealthPayload> {
    if (this.child && this.port) {
      return this.getHealth();
    }

    await fs.mkdir(historyDir, { recursive: true });

    const { command, args } = this.getSpawnTarget();
    this.child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        WINGMAN_HISTORY_DIR: historyDir,
      },
      stdio: 'pipe',
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

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

    this.child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[wingman-python] exited with code ${code}`);
      }
      this.child = null;
      this.port = null;
    });

    const startedAt = Date.now();
    while (!this.port) {
      if (Date.now() - startedAt > 20000) {
        throw new Error(
          `Python server did not report a port in time. ${stderrBuffer}`.trim(),
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

    const response = await fetch(`http://127.0.0.1:${this.port}/health`);
    if (!response.ok) {
      throw new Error(`Health check failed with status ${response.status}.`);
    }
    return (await response.json()) as HealthPayload;
  }

  getPort() {
    return this.port;
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

  private getSpawnTarget() {
    if (process.env.WINGMAN_PYTHON_BIN) {
      return {
        command: process.env.WINGMAN_PYTHON_BIN,
        args: [path.join(process.cwd(), 'python', 'server.py')],
      };
    }

    if (process.platform === 'win32') {
      if (this.isPackaged) {
        const binary = path.join(process.resourcesPath, 'python', 'wingman-server.exe');
        return { command: binary, args: [] };
      }

      return {
        command: 'py',
        args: ['-3', '-u', path.join(process.cwd(), 'python', 'server.py')],
      };
    }

    if (this.isPackaged) {
      const binary = path.join(process.resourcesPath, 'python', 'wingman-server');
      return { command: binary, args: [] };
    }

    return {
      command: 'python3',
      args: ['-u', path.join(process.cwd(), 'python', 'server.py')],
    };
  }

  async request<T>(route: string, init?: RequestInit): Promise<T> {
    if (!this.port) {
      throw new Error('Python server is not available.');
    }

    const response = await fetch(`http://127.0.0.1:${this.port}${route}`, init);
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

    if (this.port) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/session/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch {
        // Ignore session stop failures during shutdown.
      }

      try {
        await fetch(`http://127.0.0.1:${this.port}/shutdown`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
}
