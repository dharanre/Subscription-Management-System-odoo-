import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { type DB, type Param, all, get, isUniqueViolation, run, transaction } from '../db.js';
import { HttpError, conflict, likePattern, notFound, pageOf, pagingSchema, parse, kind } from '../lib/http.js';
import { hashPassword } from '../lib/password.js';
import { requireRole } from '../middleware/auth.js';
import { emailSchema, nameSchema, passwordSchema } from './auth.js';

const listSchema = pagingSchema.extend({
  role: z.enum(['admin', 'staff', 'customer']).optional(),
  q: z.string().trim().max(100).optional(),
});
const staffSchema = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema });
const statusSchema = z.object({
  isActive: z.boolean(kind('isActive must be true or false', 'isActive is required')),
});

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  is_active: number;
  is_demo: number;
  created_at: string;
}
const COLUMNS = 'id, email, name, role, is_active, is_demo, created_at';

const toUser = (r: UserRow) => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  isActive: r.is_active === 1,
  isDemo: r.is_demo === 1,
  createdAt: r.created_at,
});

export function usersRouter(db: DB, config: Config): Router {
  const router = Router();
  // Account administration is admin-only; staff cannot see or change accounts.
  router.use(requireRole('admin'));

  router.get('/', (req, res) => {
    const { page, pageSize, role, q } = parse(listSchema, req.query);
    const where: string[] = [];
    const args: Param[] = [];
    if (role) {
      where.push('role = ?');
      args.push(role);
    }
    if (q) {
      where.push(`(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`);
      args.push(likePattern(q), likePattern(q));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users ${clause}`, ...args)!.n;
    const rows = all<UserRow>(
      db,
      `SELECT ${COLUMNS} FROM users ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...args,
      pageSize,
      (page - 1) * pageSize,
    );
    res.json(pageOf(rows.map(toUser), total, page, pageSize));
  });

  router.post('/staff', async (req, res) => {
    const input = parse(staffSchema, req.body);
    const passwordHash = await hashPassword(input.password, config.bcryptCost);
    try {
      const { lastInsertRowid } = run(
        db,
        `INSERT INTO users (email, password_hash, name, role, created_by) VALUES (?, ?, ?, 'staff', ?)`,
        input.email,
        passwordHash,
        input.name,
        req.user!.id,
      );
      res.status(201).json({ user: toUser(get<UserRow>(db, `SELECT ${COLUMNS} FROM users WHERE id = ?`, lastInsertRowid)!) });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('An account with this email already exists.', { email: 'This email is already registered' });
      }
      throw err;
    }
  });

  router.patch('/:id/status', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw notFound('User');
    const { isActive } = parse(statusSchema, req.body);
    if (id === req.user!.id) throw new HttpError(400, 'invalid_request', 'You cannot deactivate your own account.');

    transaction(db, () => {
      const changed = run(db, 'UPDATE users SET is_active = ? WHERE id = ?', isActive ? 1 : 0, id);
      if (changed.changes !== 1) throw notFound('User');
      if (!isActive) run(db, 'DELETE FROM sessions WHERE user_id = ?', id);
    });
    res.json({ user: toUser(get<UserRow>(db, `SELECT ${COLUMNS} FROM users WHERE id = ?`, id)!) });
  });

  return router;
}
