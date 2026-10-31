import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Starts the application for the end-to-end tests: a brand-new SQLite file, seeded with the demo data, served
 * together with the built web app. Playwright runs this and stops it when the tests finish.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'server');
const data = path.join(root, 'e2e', '.data');
const port = process.env.E2E_PORT ?? '4317';

if (!fs.existsSync(path.join(root, 'client', 'dist', 'index.html'))) {
  console.error('The web app is not built yet. Run `npm run build` first (or use `npm run e2e`, which does).');
  process.exit(1);
}

fs.rmSync(data, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: port,
  APP_URL: `http://localhost:${port}`,
  DB_PATH: path.join(data, 'e2e.db'),
  MAILBOX_DIR: path.join(data, 'outbox'),
  // The tests sign in many times in a row, and cheap hashing keeps that quick.
  RATE_LIMIT: 'false',
  BCRYPT_COST: '4',
};

// tsx is how the server itself is run (`npm start`), so it is used directly rather than through npm.
const node = (script) => ['--import', 'tsx', script];
const seeded = spawnSync(process.execPath, node('src/seed.ts'), { cwd: server, env, stdio: 'inherit' });
if (seeded.status !== 0) process.exit(seeded.status ?? 1);

const app = spawn(process.execPath, node('src/index.ts'), { cwd: server, env, stdio: 'inherit' });
const stop = () => app.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.on('exit', (code) => process.exit(code ?? 0));
