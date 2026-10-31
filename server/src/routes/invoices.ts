import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { type DB, type Param, all, get } from '../db.js';
import { HttpError, likePattern, notFound, pageOf, pagingSchema, parse, text } from '../lib/http.js';
import {
  type InvoiceRow,
  cancelInvoice,
  confirmInvoice,
  getInvoice,
  presentInvoice,
  presentInvoiceSummary,
  sendInvoice,
} from '../lib/invoices.js';
import type { Mailer } from '../lib/mailer.js';
import { dateSchema, today } from '../lib/money.js';
import { ownedCustomerIds } from '../lib/subscriptions.js';
import { requireRole } from '../middleware/auth.js';

const STATUS_FILTERS = ['draft', 'confirmed', 'paid', 'cancelled', 'overdue', 'outstanding'] as const;

const listSchema = pagingSchema.extend({
  status: z.enum(STATUS_FILTERS).optional(),
  q: z.string().trim().max(100).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  subscriptionId: z.coerce.number().int().positive().optional(),
  from: dateSchema('From').optional(),
  to: dateSchema('To').optional(),
});
const actionSchema = z.object({ note: z.string(text('Note')).trim().max(500, 'Note is too long').nullable().optional() });
const bulkSchema = z.object({ ids: z.array(z.number().int().positive()).max(5000).optional() });

/**
 * Staff manage invoices. A customer can read their own issued invoices (confirmed or paid), found from the
 * session and never from an id the browser sends; drafts and cancelled invoices are not theirs to see.
 */
export function invoicesRouter(db: DB, config: Config, mailer: Mailer): Router {
  const router = Router();
  const staffOnly = requireRole('admin', 'staff');

  const isStaff = (req: Express.Request) => req.user!.role !== 'customer';

  /** WHERE fragments that confine a customer to their own issued invoices. */
  function scope(req: Express.Request): { sql: string; args: Param[]; none: boolean } {
    if (isStaff(req)) return { sql: '', args: [], none: false };
    const owned = ownedCustomerIds(db, req.user!.id);
    if (owned.length === 0) return { sql: '', args: [], none: true };
    return { sql: `i.customer_id IN (${owned.map(() => '?').join(',')}) AND i.status IN ('confirmed', 'paid')`, args: owned, none: false };
  }

  function visible(req: Express.Request, rawId: string): InvoiceRow {
    const invId = Number(rawId);
    const row = Number.isInteger(invId) ? getInvoice(db, invId) : undefined;
    if (!row) throw notFound('Invoice');
    if (!isStaff(req) && (row.status === 'draft' || row.status === 'cancelled' || !ownedCustomerIds(db, req.user!.id).includes(row.customer_id))) throw notFound('Invoice');
    return row;
  }

  router.get('/', (req, res) => {
    const { page, pageSize, status, q, customerId, subscriptionId, from, to } = parse(listSchema, req.query);
    const mine = scope(req);
    if (mine.none) return void res.json(pageOf([], 0, page, pageSize));

    const date = today();
    const where: string[] = [];
    const args: Param[] = [];
    if (mine.sql) {
      where.push(mine.sql);
      args.push(...mine.args);
    }
    if (status === 'overdue') {
      where.push(`i.status = 'confirmed' AND i.due_date < ? AND i.total_minor > i.paid_minor`);
      args.push(date);
    } else if (status === 'outstanding') {
      where.push(`i.status = 'confirmed' AND i.total_minor > i.paid_minor`);
    } else if (status) {
      where.push('i.status = ?');
      args.push(status);
    }
    if (customerId && isStaff(req)) {
      where.push('i.customer_id = ?');
      args.push(customerId);
    }
    if (subscriptionId) {
      where.push('i.subscription_id = ?');
      args.push(subscriptionId);
    }
    if (from) {
      where.push('i.issue_date >= ?');
      args.push(from);
    }
    if (to) {
      where.push('i.issue_date <= ?');
      args.push(to);
    }
    if (q) {
      where.push(`(i.number LIKE ? ESCAPE '\\' OR i.customer_name LIKE ? ESCAPE '\\' OR i.customer_company LIKE ? ESCAPE '\\' OR i.subscription_number LIKE ? ESCAPE '\\')`);
      args.push(likePattern(q), likePattern(q), likePattern(q), likePattern(q));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM invoices i ${clause}`, ...args)!.n;
    const rows = all<InvoiceRow>(db, `SELECT i.* FROM invoices i ${clause} ORDER BY i.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);
    res.json(pageOf(rows.map((r) => presentInvoiceSummary(r, date)), total, page, pageSize));
  });

  /** Counts for the tabs above the list. `overdue` and `outstanding` overlap with `confirmed`. */
  router.get('/counts', (req, res) => {
    const mine = scope(req);
    const counts = { draft: 0, confirmed: 0, paid: 0, cancelled: 0, overdue: 0, outstanding: 0 };
    if (!mine.none) {
      const base = mine.sql ? `WHERE ${mine.sql}` : '';
      for (const r of all<{ status: keyof typeof counts; n: number }>(db, `SELECT i.status, COUNT(*) AS n FROM invoices i ${base} GROUP BY i.status`, ...mine.args)) counts[r.status] = r.n;
      const confirmedWhere = `${mine.sql ? `${mine.sql} AND ` : ''}i.status = 'confirmed' AND i.total_minor > i.paid_minor`;
      counts.outstanding = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM invoices i WHERE ${confirmedWhere}`, ...mine.args)!.n;
      counts.overdue = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM invoices i WHERE ${confirmedWhere} AND i.due_date < ?`, ...mine.args, today())!.n;
    }
    res.json({ counts, total: counts.draft + counts.confirmed + counts.paid + counts.cancelled });
  });

  /** Confirms every draft (or just the listed ones) in one go, for billing day. */
  router.post('/confirm-drafts', staffOnly, (req, res) => {
    const { ids } = parse(bulkSchema, req.body);
    const drafts = ids?.length
      ? all<{ id: number }>(db, `SELECT id FROM invoices WHERE status = 'draft' AND id IN (${ids.map(() => '?').join(',')})`, ...ids)
      : all<{ id: number }>(db, `SELECT id FROM invoices WHERE status = 'draft' ORDER BY id`);
    let confirmed = 0;
    const failed: { id: number; message: string }[] = [];
    for (const d of drafts) {
      try {
        confirmInvoice(db, d.id, req.user!.id);
        confirmed += 1;
      } catch (err) {
        failed.push({ id: d.id, message: err instanceof Error ? err.message : 'Could not confirm' });
      }
    }
    res.json({ confirmed, failed });
  });

  router.get('/:id', (req, res) => {
    const row = visible(req, String(req.params.id));
    res.json({ invoice: presentInvoice(db, row, isStaff(req) ? 'staff' : 'customer') });
  });

  router.post('/:id/actions/:action', staffOnly, async (req, res) => {
    const action = (['confirm', 'send', 'cancel'] as const).find((a) => a === req.params.action);
    if (!action) throw new HttpError(404, 'not_found', 'Unknown action.');
    const row = visible(req, String(req.params.id));
    const { note } = parse(actionSchema, req.body);
    const actorId = req.user!.id;

    if (action === 'confirm') confirmInvoice(db, row.id, actorId);
    else if (action === 'cancel') cancelInvoice(db, row.id, actorId, note);
    else await sendInvoice(db, mailer, config, row.id, actorId);
    res.json({ invoice: presentInvoice(db, getInvoice(db, row.id)!, 'staff') });
  });

  return router;
}
