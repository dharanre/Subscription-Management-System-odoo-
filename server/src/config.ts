import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(serverRoot, '..');

export interface Config {
  nodeEnv: string;
  port: number;
  dbPath: string;
  /** Public URL of the web app; used to build links in emails. */
  appUrl: string;
  bcryptCost: number;
  sessionTtlHours: number;
  resetTtlMinutes: number;
  cookieSecure: boolean;
  /** Local "mail server": emails are written to disk and shown on the dev mailbox page. */
  devMailbox: boolean;
  mailboxDir: string;
  rateLimit: boolean;
  /** Built client bundle, served by the API process when present. */
  clientDist: string;
  /** ISO 4217 code used when showing amounts. Amounts are stored as plain numbers, never converted. */
  currency: string;
  /** BCP 47 tag controlling number and date formatting in the UI. */
  locale: string;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid numeric environment value: "${value}"`);
  return n;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const envFile = path.join(serverRoot, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const env = process.env;
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';

  return {
    nodeEnv,
    port: int(env.PORT, 4000),
    dbPath: env.DB_PATH ?? path.join(serverRoot, 'data', 'brightloop.db'),
    appUrl: (env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
    bcryptCost: int(env.BCRYPT_COST, 10),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 24 * 7),
    resetTtlMinutes: int(env.RESET_TTL_MINUTES, 30),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
    devMailbox: env.DEV_MAILBOX ? env.DEV_MAILBOX === 'true' : !isProd,
    mailboxDir: env.MAILBOX_DIR ?? path.join(serverRoot, 'data', 'outbox'),
    rateLimit: env.RATE_LIMIT ? env.RATE_LIMIT === 'true' : nodeEnv !== 'test',
    clientDist: path.join(repoRoot, 'client', 'dist'),
    currency: (env.CURRENCY ?? 'INR').toUpperCase(),
    locale: env.LOCALE ?? 'en-IN',
    ...overrides,
  };
}
