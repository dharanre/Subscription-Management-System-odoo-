import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { type DB, migrate, openDb, run } from './db.js';
import { hashPassword } from './lib/password.js';

/**
 * Demo accounts for local use. These are fictional, flagged is_demo = 1 in the database, and use
 * a published password, so the seed refuses to run against a production environment.
 */
export const DEMO_PASSWORD = 'Demo#Pass2026';

const DEMO_USERS = [
  { email: 'admin@brightloop.example', name: 'Asha Admin (demo)', role: 'admin' },
  { email: 'staff@brightloop.example', name: 'Sam Staff (demo)', role: 'staff' },
  { email: 'finance@brightloop.example', name: 'Fiona Finance (demo)', role: 'staff' },
] as const;

export async function seedAccounts(db: DB, bcryptCost: number): Promise<{ created: number }> {
  const passwordHash = await hashPassword(DEMO_PASSWORD, bcryptCost);
  let created = 0;
  for (const u of DEMO_USERS) {
    created += run(
      db,
      `INSERT OR IGNORE INTO users (email, password_hash, name, role, is_demo) VALUES (?, ?, ?, ?, 1)`,
      u.email,
      passwordHash,
      u.name,
      u.role,
    ).changes;
  }
  return { created };
}

async function main() {
  const config = loadConfig();
  if (config.nodeEnv === 'production') {
    throw new Error('Refusing to seed demo data into a production environment.');
  }
  const db = openDb(config.dbPath);
  migrate(db);
  const accounts = await seedAccounts(db, config.bcryptCost);
  db.close();
  console.log(`[seed] demo accounts created: ${accounts.created} (existing records left untouched)`);
  console.log(`[seed] sign in as admin@brightloop.example or staff@brightloop.example with password "${DEMO_PASSWORD}"`);
}

// Only run when executed directly (`npm run seed`), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
