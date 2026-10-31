import { Router } from 'express';
import { z } from 'zod';
import { type DB, all, get } from '../db.js';
import { assertNotFuture, duePeriodsOf, retryFailure, runBilling, selectDue } from '../lib/billing.js';
import { notFound, pageOf, pagingSchema, parse } from '../lib/http.js';
import { dateSchema, fromMinor, today } from '../lib/money.js';
import { priceLines } from '../lib/pricing.js';
import { loadLines, toLineInputs } from '../lib/subscriptions.js';
import { requireRole } from '../middleware/auth.js';

const runSchema = z.object({
  asOf: dateSchema('Billing date').optional(),
  confirm: z.boolean({ invalid_type_error: 'confirm must be true or false' }).optional(),
});
const dueSchema = pagingSchema.extend({ asOf: dateSchema('Billing date').optional() });
const failuresSchema = pagingSchema.extend({ status: z.enum(['open', 'resolved']).default('open') });

/** Billing day: see what is due, run it, look at past runs, and chase anything that could not be billed. */
export function billingRouter(db: DB): Router {
  const router = Router();
  router.use(requireRole('admin', 'staff'));

  /** What a run would bill right now, without billing anything. */
  router.get('/due', (req, res) => {
    const { page, pageSize, asOf = today() } = parse(dueSchema, req.query);
    assertNotFuture(asOf);
    const due = selectDue(db, asOf);
    const periods = due.reduce((n, r) => n + duePeriodsOf(r, asOf), 0);
    const slice = due.slice((page - 1) * pageSize, page * pageSize);

    const lines = loadLines(db, slice.map((r) => r.id));
    const details = slice.length
      ? new Map(
          all<{ id: number; company: string | null; customer: string; plan: string; next_billing_date: string }>(
            db,
            `SELECT s.id, c.company, c.name AS customer, p.name AS plan, s.next_billing_date
               FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id
              WHERE s.id IN (${slice.map(() => '?').join(',')})`,
            ...slice.map((r) => r.id),
          ).map((d) => [d.id, d]),
        )
      : new Map();
    const items = slice.map((r) => {
      const d = details.get(r.id)!;
      return {
        subscriptionId: r.id,
        number: r.number,
        customer: d.company || d.customer,
        plan: d.plan,
        nextPeriodStart: d.next_billing_date,
        periodsDue: duePeriodsOf(r, asOf),
        // One period before any discount; the invoice applies discounts and tax rounding exactly as billing does.
        perPeriod: fromMinor(priceLines(toLineInputs(lines.get(r.id) ?? [])).totalMinor),
      };
    });
    res.json({ asOf, subscriptionsDue: due.length, periodsDue: periods, ...pageOf(items, due.length, page, pageSize) });
  });

  router.post('/run', async (req, res) => {
    const { asOf, confirm } = parse(runSchema, req.body);
    const result = await runBilling(db, { asOf, confirm: confirm ?? false, triggeredBy: req.user!.id });
    res.json({ run: result });
  });

  router.get('/runs', (req, res) => {
    const { page, pageSize } = parse(pagingSchema, req.query);
    const total = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM billing_runs')!.n;
    const rows = all<{ id: number; as_of: string; auto_confirm: number; started_at: string; finished_at: string | null; due_count: number; created_count: number; failed_count: number; by: string | null }>(
      db,
      `SELECT r.*, u.name AS by FROM billing_runs r LEFT JOIN users u ON u.id = r.triggered_by ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      pageSize,
      (page - 1) * pageSize,
    );
    res.json(
      pageOf(
        rows.map((r) => ({ id: r.id, asOf: r.as_of, autoConfirm: r.auto_confirm === 1, startedAt: r.started_at, finishedAt: r.finished_at, due: r.due_count, created: r.created_count, failed: r.failed_count, by: r.by })),
        total,
        page,
        pageSize,
      ),
    );
  });

  router.get('/failures', (req, res) => {
    const { page, pageSize, status } = parse(failuresSchema, req.query);
    const cond = status === 'open' ? 'f.resolved_at IS NULL' : 'f.resolved_at IS NOT NULL';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM billing_failures f WHERE ${cond}`)!.n;
    const rows = all<{ id: number; subscription_id: number; number: string; company: string | null; customer: string; period_index: number; message: string; attempts: number; first_failed_at: string; last_failed_at: string; resolved_at: string | null }>(
      db,
      `SELECT f.id, f.subscription_id, s.number, c.company, c.name AS customer, f.period_index, f.message, f.attempts, f.first_failed_at, f.last_failed_at, f.resolved_at
         FROM billing_failures f JOIN subscriptions s ON s.id = f.subscription_id JOIN customers c ON c.id = s.customer_id
        WHERE ${cond} ORDER BY f.last_failed_at DESC, f.id DESC LIMIT ? OFFSET ?`,
      pageSize,
      (page - 1) * pageSize,
    );
    res.json(
      pageOf(
        rows.map((r) => ({
          id: r.id,
          subscription: { id: r.subscription_id, number: r.number },
          customer: r.company || r.customer,
          periodIndex: r.period_index,
          message: r.message,
          attempts: r.attempts,
          firstFailedAt: r.first_failed_at,
          lastFailedAt: r.last_failed_at,
          resolvedAt: r.resolved_at,
        })),
        total,
        page,
        pageSize,
      ),
    );
  });

  router.post('/failures/:id/retry', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw notFound('Failure');
    const { confirm } = parse(z.object({ confirm: z.boolean().optional() }), req.body);
    const result = await retryFailure(db, id, { confirm: confirm ?? false, triggeredBy: req.user!.id });
    res.json({ run: result, resolved: result.failureResolved });
  });

  return router;
}
