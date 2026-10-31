import { Router } from 'express';
import { z } from 'zod';
import { type DB, type Param, all, get } from '../db.js';
import { likePattern, notFound, pageOf, pagingSchema, parse, text } from '../lib/http.js';
import { dateSchema, fromMinor, moneySchema } from '../lib/money.js';
import { METHODS, type PaymentRow, getPayment, presentPayment } from '../lib/paymentRows.js';
import { receivablesSummary, voidPayment } from '../lib/payments.js';
import { ownedCustomerIds } from '../lib/subscriptions.js';
import { requireRole } from '../middleware/auth.js';

/** The body for recording a payment. Shared with the invoice route that records one. */
export const recordPaymentSchema = z.object({
  amount: moneySchema('Amount').refine((minor) => minor > 0, 'Amount must be greater than zero'),
  method: z.enum(METHODS, { errorMap: () => ({ message: `Method must be one of: ${METHODS.join(', ')}` }) }),
  paidOn: dateSchema('Payment date').optional(),
  reference: z.string(text('Reference')).trim().max(100, 'Reference is too long').nullable().optional(),
  note: z.string(text('Note')).trim().max(500, 'Note is too long').nullable().optional(),
  requestId: z
    .string(text('Request id'))
    .trim()
    .min(8, 'Request id is too short')
    .max(64, 'Request id is too long')
    .regex(/^[\w-]+$/, 'Request id can only use letters, digits, - and _')
    .nullable()
    .optional(),
});

const listSchema = pagingSchema.extend({
  status: z.enum(['recorded', 'voided', 'all']).default('recorded'),
  method: z.enum(METHODS).optional(),
  q: z.string().trim().max(100).optional(),
  from: dateSchema('From').optional(),
  to: dateSchema('To').optional(),
  invoiceId: z.coerce.number().int().positive().optional(),
  customerId: z.coerce.number().int().positive().optional(),
});
const voidSchema = z.object({ reason: z.string(text('Reason')).trim().min(1, 'Say why this payment is being voided').max(300, 'Reason is too long') });

/**
 * Staff see every payment. A customer sees the payments made on their own invoices, found from the
 * session and never from an id the browser sends.
 */
export function paymentsRouter(db: DB): Router {
  const router = Router();
  const isStaff = (req: Express.Request) => req.user!.role !== 'customer';

  router.get('/', (req, res) => {
    const { page, pageSize, status, method, q, from, to, invoiceId, customerId } = parse(listSchema, req.query);
    const where: string[] = [];
    const args: Param[] = [];
    if (isStaff(req)) {
      if (status !== 'all') {
        where.push('p.status = ?');
        args.push(status);
      }
      if (customerId) {
        where.push('p.customer_id = ?');
        args.push(customerId);
      }
    } else {
      const owned = ownedCustomerIds(db, req.user!.id);
      if (owned.length === 0) return void res.json({ ...pageOf([], 0, page, pageSize), totals: { count: 0, amount: 0 } });
      where.push(`p.status = 'recorded' AND p.customer_id IN (${owned.map(() => '?').join(',')})`);
      args.push(...owned);
    }
    if (method) {
      where.push('p.method = ?');
      args.push(method);
    }
    if (invoiceId) {
      where.push('p.invoice_id = ?');
      args.push(invoiceId);
    }
    if (from) {
      where.push('p.paid_on >= ?');
      args.push(from);
    }
    if (to) {
      where.push('p.paid_on <= ?');
      args.push(to);
    }
    if (q) {
      where.push(`(i.number LIKE ? ESCAPE '\\' OR i.customer_name LIKE ? ESCAPE '\\' OR i.customer_company LIKE ? ESCAPE '\\' OR p.reference LIKE ? ESCAPE '\\')`);
      args.push(likePattern(q), likePattern(q), likePattern(q), likePattern(q));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from_ = 'FROM payments p JOIN invoices i ON i.id = p.invoice_id';
    const totals = get<{ n: number; amount: number | null }>(db, `SELECT COUNT(*) AS n, SUM(p.amount_minor) AS amount ${from_} ${clause}`, ...args)!;
    const rows = all<PaymentRow & { invoice_number: string; customer_name: string; customer_company: string | null }>(
      db,
      `SELECT p.*, i.number AS invoice_number, i.customer_name, i.customer_company ${from_} ${clause} ORDER BY p.paid_on DESC, p.id DESC LIMIT ? OFFSET ?`,
      ...args,
      pageSize,
      (page - 1) * pageSize,
    );
    res.json({ ...pageOf(rows.map(presentPayment), totals.n, page, pageSize), totals: { count: totals.n, amount: fromMinor(totals.amount ?? 0) } });
  });

  router.post('/:id/void', requireRole('admin', 'staff'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !getPayment(db, id)) throw notFound('Payment');
    const { reason } = parse(voidSchema, req.body);
    const { payment } = voidPayment(db, id, reason, req.user!.id);
    res.json({ payment: presentPayment(payment) });
  });

  return router;
}

/** Money still owed, by how late it is, for chasing. */
export function receivablesRouter(db: DB): Router {
  const router = Router();
  router.use(requireRole('admin', 'staff'));
  router.get('/summary', (_req, res) => {
    res.json(receivablesSummary(db));
  });
  return router;
}
