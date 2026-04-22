import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { DEV_SERVER_CONFIG_PATH } from './devServerConfig.mjs';

const HOST = '127.0.0.1';
const START_PORT = 5173;
const MAX_PORT = 5273;

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, HOST);
  });
}

async function findAvailablePort() {
  for (let port = START_PORT; port <= MAX_PORT; port += 1) {
    if (await canListen(port)) {
      return port;
    }
  }

  throw new Error(
    `Unable to find a free dev server port between ${START_PORT} and ${MAX_PORT}.`,
  );
}

const port = await findAvailablePort();
const payload = {
  host: HOST,
  port,
  url: `http://${HOST}:${port}`,
};

await writeFile(DEV_SERVER_CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
console.log(`[dev] Using renderer port ${port}`);
