import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DEV_SERVER_CONFIG_PATH = path.join(
  process.cwd(),
  '.dev-server.json',
);

export function readDevServerConfig() {
  if (!existsSync(DEV_SERVER_CONFIG_PATH)) {
    return {
      host: '127.0.0.1',
      port: 5173,
      url: 'http://127.0.0.1:5173',
    };
  }

  const content = readFileSync(DEV_SERVER_CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(content);
  return {
    host: parsed.host ?? '127.0.0.1',
    port: Number(parsed.port ?? 5173),
    url: parsed.url ?? `http://${parsed.host ?? '127.0.0.1'}:${parsed.port ?? 5173}`,
  };
}
