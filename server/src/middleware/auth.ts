import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Config } from '../config.js';
import { type DB, get, run } from '../db.js';
import { forbidden, unauthorized } from '../lib/http.js';

export type Role = 'admin' | 'staff' | 'customer';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const SESSION_COOKIE = 'bl_session';

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function createSession(db: DB, config: Config, res: Response, userId: number): void {
  const token = newToken();
  const maxAgeMs = config.sessionTtlHours * 3600 * 1000;
  run(
    db,
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    hashToken(token),
    userId,
    new Date(Date.now() + maxAgeMs).toISOString(),
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: maxAgeMs,
    path: '/',
  });
}

export function destroySession(db: DB, req: Request, res: Response): void {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (token) run(db, 'DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Attaches req.user when the request carries a valid, unexpired session for an active account. */
export function loadSession(db: DB): RequestHandler {
  return (req, _res, next) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) {
      const row = get<AuthUser>(
        db,
        `SELECT u.id, u.email, u.name, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1`,
        hashToken(token),
        new Date().toISOString(),
      );
      if (row) req.user = { id: row.id, email: row.email, name: row.name, role: row.role };
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  next();
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

/** Origins the web app is served from: the configured app URL, plus its 127.0.0.1 twin when it is on localhost. */
export function allowedOrigins(config: Config): Set<string> {
  const app = new URL(config.appUrl);
  const origins = new Set([app.origin]);
  if (app.hostname === 'localhost') origins.add(`${app.protocol}//127.0.0.1${app.port ? `:${app.port}` : ''}`);
  return origins;
}

/**
 * Cookie sessions are sent automatically by browsers, so a state-changing request is only accepted
 * when its Origin header is this server's own host or the configured web app (a dev proxy rewrites
 * Host but not Origin, so comparing Host alone would reject the real front end).
 */
export const sameOriginWrites = (config: Config): RequestHandler => {
  const allowed = allowedOrigins(config);
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (origin) {
      let host: string | undefined;
      try {
        host = new URL(origin).host;
      } catch {
        host = undefined;
      }
      if (!allowed.has(origin) && host !== req.headers.host) return next(forbidden('Cross-site requests are not allowed.'));
    }
    next();
  };
};
