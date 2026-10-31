import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDb } from './db.js';
import { DevMailbox } from './lib/mailer.js';
import { sweepExpired } from './lib/subscriptions.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);

const app = createApp({ config, db, mailer: new DevMailbox(config.mailboxDir) });
const server = app.listen(config.port, () => {
  console.log(`[server] Brightloop API listening on http://localhost:${config.port} (${config.nodeEnv})`);
});

// Plans that close on their own do so shortly after their expiry date, even if nobody opens the app.
function closeExpired() {
  try {
    const closed = sweepExpired(db);
    if (closed) console.log(`[lifecycle] closed ${closed} expired subscription${closed === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('[lifecycle] automatic closure failed', err);
  }
}
closeExpired();
const sweeper = setInterval(closeExpired, 60 * 60 * 1000);
sweeper.unref();

function shutdown(signal: string) {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
