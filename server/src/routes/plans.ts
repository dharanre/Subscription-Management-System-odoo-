import { Router } from 'express';
import { z } from 'zod';
import { type DB, type Param, all, get, isUniqueViolation, run } from '../db.js';
import { type PlanRow, toPlan } from '../lib/catalog.js';
import { conflict, invalidField, likePattern, notFound, pageOf, pagingSchema, parse, text, kind } from '../lib/http.js';
import { dateSchema, moneySchema, today } from '../lib/money.js';
import { requireRole } from '../middleware/auth.js';

const PERIODS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
const flag = (label: string) => z.boolean(kind(`${label} must be true or false`));

const planFields = {
  name: z.string(text('Name')).trim().min(1, 'Name is required').max(120, 'Name is too long'),
  description: z.string(text('Description')).trim().max(1000, 'Description is too long').nullable(),
  price: moneySchema('Price'),
  billingPeriod: z.enum(PERIODS, { error: `Billing period must be one of: ${PERIODS.join(', ')}` }),
  minQuantity: z.number(kind('Minimum quantity must be a number')).int('Minimum quantity must be a whole number').min(1, 'Minimum quantity must be at least 1').max(100_000, 'Minimum quantity is too large'),
  availableFrom: dateSchema('Available from'),
  availableTo: dateSchema('Available to').nullable(),
  autoClose: flag('autoClose'),
  allowEarlyClose: flag('allowEarlyClose'),
  allowPause: flag('allowPause'),
  allowRenewal: flag('allowRenewal'),
  isActive: flag('isActive'),
};
// New plans are always created active, so `isActive` is only accepted on update.
const { isActive: _planActive, ...planCreateFields } = planFields;
const createSchema = z.object({
  ...planCreateFields,
  description: planFields.description.optional(),
  minQuantity: planFields.minQuantity.default(1),
  availableTo: planFields.availableTo.optional(),
  autoClose: planFields.autoClose.default(false),
  allowEarlyClose: planFields.allowEarlyClose.default(false),
  allowPause: planFields.allowPause.default(false),
  allowRenewal: planFields.allowRenewal.default(false),
});
const updateSchema = z.object(planFields).partial();
const listSchema = pagingSchema.extend({
  q: z.string().trim().max(100).optional(),
  period: z.enum(PERIODS).optional(),
  active: z.enum(['true', 'false']).optional(),
});

const dupName = () => conflict('A plan with this name already exists.', { name: 'This name is already used' });

function checkWindow(from: string, to: string | null) {
  if (to !== null && to < from) invalidField('availableTo', 'Must be on or after the start date');
}

export function plansRouter(db: DB): Router {
  const router = Router();
  const read = requireRole('admin', 'staff');
  const write = requireRole('admin');

  router.get('/', read, (req, res) => {
    const { page, pageSize, q, period, active } = parse(listSchema, req.query);
    const where: string[] = [];
    const args: Param[] = [];
    if (q) {
      where.push(`name LIKE ? ESCAPE '\\'`);
      args.push(likePattern(q));
    }
    if (period) {
      where.push('billing_period = ?');
      args.push(period);
    }
    if (active) where.push(`is_active = ${active === 'true' ? 1 : 0}`);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM plans ${clause}`, ...args)!.n;
    const rows = all<PlanRow>(db, `SELECT * FROM plans ${clause} ORDER BY name LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);
    const date = today();
    res.json(pageOf(rows.map((r) => toPlan(r, date)), total, page, pageSize));
  });

  router.get('/:id', read, (req, res) => {
    const row = get<PlanRow>(db, 'SELECT * FROM plans WHERE id = ?', Number(req.params.id));
    if (!row) throw notFound('Plan');
    res.json({ plan: toPlan(row, today()) });
  });

  router.post('/', write, (req, res) => {
    const input = parse(createSchema, req.body);
    checkWindow(input.availableFrom, input.availableTo ?? null);
    try {
      const id = run(
        db,
        `INSERT INTO plans (name, description, price_minor, billing_period, min_quantity, available_from, available_to,
                            auto_close, allow_early_close, allow_pause, allow_renewal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.name,
        input.description || null,
        input.price,
        input.billingPeriod,
        input.minQuantity,
        input.availableFrom,
        input.availableTo ?? null,
        input.autoClose ? 1 : 0,
        input.allowEarlyClose ? 1 : 0,
        input.allowPause ? 1 : 0,
        input.allowRenewal ? 1 : 0,
      ).lastInsertRowid;
      res.status(201).json({ plan: toPlan(get<PlanRow>(db, 'SELECT * FROM plans WHERE id = ?', id)!, today()) });
    } catch (err) {
      if (isUniqueViolation(err)) throw dupName();
      throw err;
    }
  });

  router.patch('/:id', write, (req, res) => {
    const id = Number(req.params.id);
    const current = Number.isInteger(id) ? get<PlanRow>(db, 'SELECT * FROM plans WHERE id = ?', id) : undefined;
    if (!current) throw notFound('Plan');
    const input = parse(updateSchema, req.body);

    const from = input.availableFrom ?? current.available_from;
    const to = input.availableTo === undefined ? current.available_to : input.availableTo;
    checkWindow(from, to);
    const bool = (v: boolean | undefined, old: number) => (v === undefined ? old : v ? 1 : 0);

    try {
      run(
        db,
        `UPDATE plans SET name = ?, description = ?, price_minor = ?, billing_period = ?, min_quantity = ?, available_from = ?,
                available_to = ?, auto_close = ?, allow_early_close = ?, allow_pause = ?, allow_renewal = ?, is_active = ? WHERE id = ?`,
        input.name ?? current.name,
        input.description === undefined ? current.description : input.description || null,
        input.price ?? current.price_minor,
        input.billingPeriod ?? current.billing_period,
        input.minQuantity ?? current.min_quantity,
        from,
        to,
        bool(input.autoClose, current.auto_close),
        bool(input.allowEarlyClose, current.allow_early_close),
        bool(input.allowPause, current.allow_pause),
        bool(input.allowRenewal, current.allow_renewal),
        bool(input.isActive, current.is_active),
        id,
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw dupName();
      throw err;
    }
    res.json({ plan: toPlan(get<PlanRow>(db, 'SELECT * FROM plans WHERE id = ?', id)!, today()) });
  });

  return router;
}
