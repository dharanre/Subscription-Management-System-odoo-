import { Router } from 'express';
import { z } from 'zod';
import { type DB, type Param, all, get } from '../db.js';
import { HttpError, likePattern, notFound, pageOf, pagingSchema, parse, text } from '../lib/http.js';
import { ACTIONS, STATUSES } from '../lib/lifecycle.js';
import { dateSchema, today } from '../lib/money.js';
import {
  type SubLineRow,
  type SubRow,
  type SummaryJoin,
  applyAction,
  createSubscription,
  getSubscription,
  loadLines,
  ownedCustomerIds,
  presentDetail,
  presentSummary,
  sweepExpired,
  updateDraft,
} from '../lib/subscriptions.js';
import { requireRole } from '../middleware/auth.js';

const lineSchema = z.object({
  productId: z.number({ required_error: 'Choose a product', invalid_type_error: 'Choose a product' }).int().positive('Choose a product'),
  variantId: z.number({ invalid_type_error: 'Choose a valid option' }).int().positive().nullable().optional(),
  quantity: z.number({ required_error: 'Quantity is required', invalid_type_error: 'Quantity must be a number' }).int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(100_000, 'Quantity is too large'),
});
const id = (label: string) => z.number({ required_error: `Choose ${label}`, invalid_type_error: `Choose ${label}` }).int().positive(`Choose ${label}`);

const fields = {
  customerId: id('a customer'),
  templateId: id('a template').nullable(),
  planId: id('a plan'),
  startDate: dateSchema('Start date'),
  expiryDate: dateSchema('Expiry date'),
  paymentTermsId: id('payment terms').nullable(),
  notes: z.string(text('Notes')).trim().max(2000, 'Notes are too long').nullable(),
  lines: z.array(lineSchema).max(100, 'At most 100 lines'),
};
const createSchema = z.object({
  customerId: fields.customerId,
  templateId: fields.templateId.optional(),
  planId: id('a plan').nullable().optional(),
  startDate: fields.startDate.optional(),
  expiryDate: fields.expiryDate.optional(),
  paymentTermsId: fields.paymentTermsId.optional(),
  notes: fields.notes.optional(),
  lines: fields.lines.optional(),
});
const updateSchema = z.object(fields).omit({ templateId: true }).partial();
const actionSchema = z.object({ note: z.string(text('Note')).trim().max(500, 'Note is too long').nullable().optional() });
const listSchema = pagingSchema.extend({
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  planId: z.coerce.number().int().positive().optional(),
  /** Only subscriptions that start within these dates. */
  from: dateSchema('From').optional(),
  to: dateSchema('To').optional(),
});

const SUMMARY_SQL = `SELECT s.*, c.name AS customer_name, c.company AS customer_company, p.name AS plan_name, p.billing_period AS plan_period
  FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id`;

/**
 * Staff and admins see every subscription. A customer reaches only subscriptions whose customer record
 * is linked to their own login: the filter is applied on the server from the session, never from a
 * customer or account id supplied by the browser, and another customer's record answers 404.
 */
export function subscriptionsRouter(db: DB): Router {
  const router = Router();
  const staffOnly = requireRole('admin', 'staff');

  const isStaff = (req: Express.Request) => req.user!.role !== 'customer';
  const actorOf = (req: Express.Request) => ({ kind: isStaff(req) ? ('staff' as const) : ('customer' as const), userId: req.user!.id });

  /** Loads a subscription this caller may see, or throws 404. */
  function visible(req: Express.Request, rawId: string): SubRow {
    const subId = Number(rawId);
    const row = Number.isInteger(subId) ? getSubscription(db, subId) : undefined;
    if (!row) throw notFound('Subscription');
    if (!isStaff(req) && !ownedCustomerIds(db, req.user!.id).includes(row.customer_id)) throw notFound('Subscription');
    return row;
  }

  /** Extra WHERE clause that limits a customer to their own records. Staff get no restriction. */
  function scope(req: Express.Request): { sql: string; args: Param[]; none: boolean } {
    if (isStaff(req)) return { sql: '', args: [], none: false };
    const owned = ownedCustomerIds(db, req.user!.id);
    if (owned.length === 0) return { sql: '', args: [], none: true };
    return { sql: `s.customer_id IN (${owned.map(() => '?').join(',')})`, args: owned, none: false };
  }

  router.get('/', (req, res) => {
    sweepExpired(db);
    const { page, pageSize, status, q, customerId, planId, from, to } = parse(listSchema, req.query);
    const mine = scope(req);
    if (mine.none) return void res.json(pageOf([], 0, page, pageSize));

    const where: string[] = [];
    const args: Param[] = [];
    if (mine.sql) {
      where.push(mine.sql);
      args.push(...mine.args);
    }
    if (status) {
      where.push('s.status = ?');
      args.push(status);
    }
    if (customerId && isStaff(req)) {
      where.push('s.customer_id = ?');
      args.push(customerId);
    }
    if (planId) {
      where.push('s.plan_id = ?');
      args.push(planId);
    }
    if (from) {
      where.push('s.start_date >= ?');
      args.push(from);
    }
    if (to) {
      where.push('s.start_date <= ?');
      args.push(to);
    }
    if (q) {
      where.push(`(s.number LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\')`);
      args.push(likePattern(q), likePattern(q), likePattern(q));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM subscriptions s JOIN customers c ON c.id = s.customer_id ${clause}`, ...args)!.n;
    const rows = all<SummaryJoin>(db, `${SUMMARY_SQL} ${clause} ORDER BY s.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);
    const lines = loadLines(db, rows.map((r) => r.id));
    const date = today();
    res.json(pageOf(rows.map((r) => presentSummary(r, lines.get(r.id) ?? ([] as SubLineRow[]), date)), total, page, pageSize));
  });

  /** How many subscriptions are in each status, for the tabs above the list. */
  router.get('/counts', (req, res) => {
    sweepExpired(db);
    const mine = scope(req);
    const counts: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    if (!mine.none) {
      const rows = all<{ status: string; n: number }>(db, `SELECT s.status, COUNT(*) AS n FROM subscriptions s ${mine.sql ? `WHERE ${mine.sql}` : ''} GROUP BY s.status`, ...mine.args);
      for (const r of rows) counts[r.status] = r.n;
    }
    res.json({ counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
  });

  router.get('/:id', (req, res) => {
    sweepExpired(db);
    const row = visible(req, String(req.params.id));
    res.json({ subscription: presentDetail(db, row, actorOf(req).kind, req.user!.id) });
  });

  router.post('/', staffOnly, (req, res) => {
    const input = parse(createSchema, req.body);
    const newId = createSubscription(db, { ...input, createdBy: req.user!.id });
    res.status(201).json({ subscription: presentDetail(db, getSubscription(db, newId)!, 'staff') });
  });

  router.patch('/:id', staffOnly, (req, res) => {
    const row = visible(req, String(req.params.id));
    updateDraft(db, row.id, parse(updateSchema, req.body));
    res.json({ subscription: presentDetail(db, getSubscription(db, row.id)!, 'staff') });
  });

  router.post('/:id/actions/:action', (req, res) => {
    const action = ACTIONS.find((a) => a === req.params.action);
    if (!action) throw new HttpError(404, 'not_found', 'Unknown action.');
    sweepExpired(db);
    const row = visible(req, String(req.params.id));
    const { note } = parse(actionSchema, req.body);
    const actor = actorOf(req);
    applyAction(db, row.id, action, actor, note);
    res.json({ subscription: presentDetail(db, getSubscription(db, row.id)!, actor.kind, req.user!.id) });
  });

  return router;
}
