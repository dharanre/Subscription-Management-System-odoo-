import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { checkRange, dashboard, defaultRange, portalSummary } from '../lib/dashboard.js';
import { invalidField, parse } from '../lib/http.js';
import { dateSchema } from '../lib/money.js';
import { ownedCustomerIds } from '../lib/subscriptions.js';
import { requireRole } from '../middleware/auth.js';

const querySchema = z.object({ from: dateSchema('From').optional(), to: dateSchema('To').optional() });

/** The finance lead's one place: subscriptions, revenue, payments and overdue invoices, for a date range. */
export function dashboardRouter(db: DB): Router {
  const router = Router();
  router.get('/', requireRole('admin', 'staff'), (req, res) => {
    const q = parse(querySchema, req.query);
    const base = defaultRange();
    const range = { from: q.from ?? (q.to && q.to < base.from ? q.to : base.from), to: q.to ?? base.to };
    const problem = checkRange(range);
    if (problem) invalidField('from', problem);
    res.json(dashboard(db, range));
  });
  return router;
}

/** A customer's own overview. The customer ids come from the session, never from the request. */
export function portalRouter(db: DB): Router {
  const router = Router();
  router.get('/summary', requireRole('customer'), (req, res) => {
    const summary = portalSummary(db, ownedCustomerIds(db, req.user!.id));
    res.json({ summary });
  });
  return router;
}
