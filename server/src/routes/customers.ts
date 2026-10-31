import { Router } from 'express';
import { z } from 'zod';
import { type DB, type Param, all, get, run } from '../db.js';
import { conflict, likePattern, notFound, pageOf, pagingSchema, parse, text } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import { emailSchema, nameSchema } from './auth.js';

const optionalText = (label: string, max: number) => z.string(text(label)).trim().max(max, `${label} is too long`).nullable();

const fields = {
  name: nameSchema,
  email: emailSchema,
  company: optionalText('Company', 120),
  phone: optionalText('Phone', 40),
  address: optionalText('Address', 400),
};
const createSchema = z.object({ ...fields, company: fields.company.optional(), phone: fields.phone.optional(), address: fields.address.optional() });
const updateSchema = z.object(fields).partial();
const listSchema = pagingSchema.extend({ q: z.string().trim().max(100).optional() });

interface CustomerRow {
  id: number;
  user_id: number | null;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  address: string | null;
  is_demo: number;
  created_at: string;
  subscription_count?: number;
}

const toCustomer = (r: CustomerRow) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  company: r.company,
  phone: r.phone,
  address: r.address,
  hasPortalAccount: r.user_id !== null,
  subscriptionCount: r.subscription_count ?? 0,
  isDemo: r.is_demo === 1,
  createdAt: r.created_at,
});

const SELECT = `SELECT c.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.customer_id = c.id) AS subscription_count FROM customers c`;

/** Staff and admins manage customer records; customers only ever reach their own data through the portal endpoints. */
export function customersRouter(db: DB): Router {
  const router = Router();
  router.use(requireRole('admin', 'staff'));

  router.get('/', (req, res) => {
    const { page, pageSize, q } = parse(listSchema, req.query);
    const where: string[] = [];
    const args: Param[] = [];
    if (q) {
      where.push(`(c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\')`);
      args.push(likePattern(q), likePattern(q), likePattern(q));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM customers c ${clause}`, ...args)!.n;
    const rows = all<CustomerRow>(db, `${SELECT} ${clause} ORDER BY c.name COLLATE NOCASE LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);
    res.json(pageOf(rows.map(toCustomer), total, page, pageSize));
  });

  router.get('/:id', (req, res) => {
    const row = get<CustomerRow>(db, `${SELECT} WHERE c.id = ?`, Number(req.params.id));
    if (!row) throw notFound('Customer');
    res.json({ customer: toCustomer(row) });
  });

  router.post('/', (req, res) => {
    const input = parse(createSchema, req.body);
    if (get(db, 'SELECT 1 AS x FROM customers WHERE email = ?', input.email)) {
      throw conflict('A customer with this email already exists.', { email: 'This email is already a customer' });
    }
    const id = run(db, 'INSERT INTO customers (name, email, company, phone, address) VALUES (?, ?, ?, ?, ?)', input.name, input.email, input.company || null, input.phone || null, input.address || null).lastInsertRowid;
    res.status(201).json({ customer: toCustomer(get<CustomerRow>(db, `${SELECT} WHERE c.id = ?`, id)!) });
  });

  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const current = Number.isInteger(id) ? get<CustomerRow>(db, 'SELECT * FROM customers WHERE id = ?', id) : undefined;
    if (!current) throw notFound('Customer');
    const input = parse(updateSchema, req.body);

    // The email of a customer with a portal login is its sign-in name, so it is changed through the account, not here.
    if (input.email !== undefined && input.email !== current.email) {
      if (current.user_id !== null) throw conflict('This customer signs in with that email, so it cannot be changed here.', { email: 'Tied to the customer’s login' });
      if (get(db, 'SELECT 1 AS x FROM customers WHERE email = ? AND id <> ?', input.email, id)) {
        throw conflict('A customer with this email already exists.', { email: 'This email is already a customer' });
      }
    }
    run(
      db,
      'UPDATE customers SET name = ?, email = ?, company = ?, phone = ?, address = ? WHERE id = ?',
      input.name ?? current.name,
      input.email ?? current.email,
      input.company === undefined ? current.company : input.company || null,
      input.phone === undefined ? current.phone : input.phone || null,
      input.address === undefined ? current.address : input.address || null,
      id,
    );
    res.json({ customer: toCustomer(get<CustomerRow>(db, `${SELECT} WHERE c.id = ?`, id)!) });
  });

  return router;
}
