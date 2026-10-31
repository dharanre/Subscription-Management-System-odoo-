import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, migrate, openDb } from '../src/db.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { seedAccounts, DEMO_PASSWORD } from '../src/seed.js';

export const GOOD_PASSWORD = 'Str0ng#Passw';
export { DEMO_PASSWORD };

export async function buildTestApp() {
  const config = loadConfig({ nodeEnv: 'test', dbPath: ':memory:', bcryptCost: 4, rateLimit: false, devMailbox: false });
  const db: DB = openDb(':memory:');
  migrate(db);
  await seedAccounts(db, config.bcryptCost);
  const mailer = new MemoryMailer();
  const app = createApp({ config, db, mailer });
  return { app, db, mailer, config };
}

export type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

/** A supertest agent that keeps its session cookie, signed in as the given account. */
export async function loginAs(t: TestApp, email: string, password = DEMO_PASSWORD) {
  const agent = request.agent(t.app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export async function signupCustomer(t: TestApp, email: string, name = 'Test Customer') {
  const agent = request.agent(t.app);
  const res = await agent.post('/api/auth/signup').send({ name, email, password: GOOD_PASSWORD });
  if (res.status !== 201) throw new Error(`signup failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export const ADMIN = 'admin@brightloop.example';
export const STAFF = 'staff@brightloop.example';

/** Pulls the reset token out of the most recent email sent by the app. */
export function lastResetToken(mailer: { sent: { text: string }[] }): string {
  const mail = mailer.sent.at(-1);
  const match = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('No reset email with a token was sent');
  return match[1]!;
}
