import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { type DB, get, isUniqueViolation, run, transaction } from '../db.js';
import { HttpError, conflict, parse, text } from '../lib/http.js';
import type { Mailer } from '../lib/mailer.js';
import { DUMMY_HASH, hashPassword, passwordProblems, verifyPassword } from '../lib/password.js';
import {
  type AuthUser,
  createSession,
  destroySession,
  hashToken,
  newToken,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const emailSchema = z
  .string(text('Email'))
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(254, 'Email is too long')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email address');

export const passwordSchema = z.string(text('Password')).superRefine((value, ctx) => {
  const problems = passwordProblems(value);
  if (problems.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Password needs: ${problems.join(', ').toLowerCase()}` });
  }
});

export const nameSchema = z.string(text('Name')).trim().min(1, 'Name is required').max(100, 'Name is too long');

const signupSchema = z.object({
  name: nameSchema,
  company: z.string(text('Company')).trim().max(120, 'Company is too long').optional(),
  email: emailSchema,
  password: passwordSchema,
});
const loginSchema = z.object({
  email: emailSchema,
  password: z.string(text('Password')).min(1, 'Password is required'),
});
const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z.object({
  token: z.string(text('Reset token')).min(1, 'Reset token is required').max(200),
  password: passwordSchema,
});

const INVALID_TOKEN = 'This reset link is invalid or has expired. Request a new one.';

export function authRouter(db: DB, config: Config, mailer: Mailer): Router {
  const router = Router();
  const limitLogin = rateLimit(config.rateLimit, 'login', { windowMs: 15 * 60_000, max: 20 });
  const limitSignup = rateLimit(config.rateLimit, 'signup', { windowMs: 15 * 60_000, max: 20 });
  const limitForgot = rateLimit(config.rateLimit, 'forgot', { windowMs: 15 * 60_000, max: 5 });

  router.post('/signup', limitSignup, async (req, res) => {
    // A public sign-up can only ever create a customer; any `role` in the body is ignored.
    const input = parse(signupSchema, req.body);
    const passwordHash = await hashPassword(input.password, config.bcryptCost);

    let user: AuthUser;
    try {
      user = transaction(db, (): AuthUser => {
        const id = run(
          db,
          `INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'customer')`,
          input.email,
          passwordHash,
          input.name,
        ).lastInsertRowid;
        run(
          db,
          'INSERT INTO customers (user_id, name, email, company) VALUES (?, ?, ?, ?)',
          id,
          input.name,
          input.email,
          input.company || null,
        );
        return { id, email: input.email, name: input.name, role: 'customer' };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('An account with this email already exists.', { email: 'This email is already registered' });
      }
      throw err;
    }

    createSession(db, config, res, user.id);
    res.status(201).json({ user });
  });

  router.post('/login', limitLogin, async (req, res) => {
    const input = parse(loginSchema, req.body);
    const row = get<AuthUser & { password_hash: string; is_active: number }>(
      db,
      'SELECT id, email, name, role, password_hash, is_active FROM users WHERE email = ?',
      input.email,
    );

    const ok = await verifyPassword(input.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok || !row.is_active) {
      throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password.');
    }

    run(db, 'DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
    createSession(db, config, res, row.id);
    res.json({ user: { id: row.id, email: row.email, name: row.name, role: row.role } });
  });

  router.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.status(204).end();
  });

  // Answers 200 with `user: null` when signed out, so the app can ask on every load without a failed request.
  router.get('/me', (req, res) => {
    res.json({ user: req.user ?? null });
  });

  // Always answers the same way so the form cannot be used to discover which emails are registered.
  router.post('/forgot', limitForgot, async (req, res) => {
    const { email } = parse(forgotSchema, req.body);
    const user = get<{ id: number; name: string }>(
      db,
      'SELECT id, name FROM users WHERE email = ? AND is_active = 1',
      email,
    );

    if (user) {
      const token = newToken();
      const now = new Date();
      transaction(db, () => {
        run(db, 'UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', now.toISOString(), user.id);
        run(
          db,
          'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
          user.id,
          hashToken(token),
          new Date(now.getTime() + config.resetTtlMinutes * 60_000).toISOString(),
        );
      });
      try {
        await mailer.send({
          to: email,
          subject: 'Reset your Brightloop password',
          text:
            `Hi ${user.name},\n\nUse this link to choose a new password. It works once and expires in ` +
            `${config.resetTtlMinutes} minutes:\n\n${config.appUrl}/reset-password?token=${token}\n\n` +
            `If you did not ask for this, you can ignore this email.`,
        });
      } catch (err) {
        // The caller must not learn whether the account exists, so the failure is logged, not returned.
        console.error('[auth] could not send password reset email', err);
      }
    }
    res.status(202).json({ message: 'If that email is registered, a reset link is on its way.' });
  });

  router.post('/reset', limitForgot, async (req, res) => {
    const input = parse(resetSchema, req.body);
    const row = get<{ id: number; user_id: number; expires_at: string; used_at: string | null }>(
      db,
      'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?',
      hashToken(input.token),
    );
    if (!row || row.used_at || row.expires_at <= new Date().toISOString()) {
      throw new HttpError(400, 'invalid_token', INVALID_TOKEN);
    }

    const passwordHash = await hashPassword(input.password, config.bcryptCost);
    transaction(db, () => {
      // The conditional update makes the token single-use even if two requests race.
      const claimed = run(db, 'UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', new Date().toISOString(), row.id);
      if (claimed.changes !== 1) throw new HttpError(400, 'invalid_token', INVALID_TOKEN);
      run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, row.user_id);
      // Anyone holding an old session (including an attacker) is signed out.
      run(db, 'DELETE FROM sessions WHERE user_id = ?', row.user_id);
    });
    res.json({ message: 'Password updated. You can now sign in.' });
  });

  return router;
}
