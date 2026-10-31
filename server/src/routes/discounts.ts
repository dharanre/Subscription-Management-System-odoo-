import { Router } from 'express';
import { z } from 'zod';
import { type DB, type Param, all, get, isUniqueViolation, run, transaction } from '../db.js';
import { type DiscountRow, loadDiscountProducts, toDiscount } from '../lib/catalog.js';
import { conflict, invalidField, likePattern, notFound, pageOf, pagingSchema, parse, parseAt, text, kind } from '../lib/http.js';
import { dateSchema, moneySchema, percentSchema, today } from '../lib/money.js';
import { requireRole } from '../middleware/auth.js';

const int = (label: string, min: number, max: number) =>
  z
    .number(kind(`${label} must be a number`))
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} is too large`);

const discountFields = {
  name: z.string(text('Name')).trim().min(1, 'Name is required').max(120, 'Name is too long'),
  kind: z.enum(['fixed', 'percent'], { error: 'Choose a fixed amount or a percentage' }),
  value: z.number(kind('Value must be a number', 'Value is required')),
  scope: z.enum(['products', 'subscription'], { error: 'Choose specific products or the whole subscription' }),
  productIds: z.array(z.number().int().positive(), kind('productIds must be a list')).max(100, 'Too many products'),
  minPurchase: moneySchema('Minimum purchase'),
  minQuantity: int('Minimum quantity', 0, 1_000_000),
  startDate: dateSchema('Start date'),
  endDate: dateSchema('End date').nullable(),
  usageLimit: int('Usage limit', 1, 1_000_000).nullable(),
  isActive: z.boolean(kind('isActive must be true or false')),
};
// New discounts are always created switched on, so `isActive` is only accepted on update.
const { isActive: _discountActive, ...discountCreateFields } = discountFields;
const createSchema = z.object({
  ...discountCreateFields,
  productIds: discountFields.productIds.default([]),
  minPurchase: discountFields.minPurchase.default(0),
  minQuantity: discountFields.minQuantity.default(0),
  endDate: discountFields.endDate.optional(),
  usageLimit: discountFields.usageLimit.optional(),
});
const updateSchema = z.object(discountFields).partial();
const listSchema = pagingSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'scheduled', 'expired', 'used_up', 'inactive']).optional(),
});

/** Converts the API `value` (major units or percent) to its stored form and enforces > 0. */
function normalizeValue(kind: 'fixed' | 'percent', value: number): number {
  const stored = kind === 'fixed' ? parseAt('value', moneySchema('Discount amount'), value) : parseAt('value', percentSchema('Discount percentage'), value);
  if (stored <= 0) invalidField('value', 'Must be greater than zero');
  return stored;
}

function assertProducts(db: DB, ids: number[]) {
  for (const id of new Set(ids)) {
    if (!get(db, 'SELECT 1 AS x FROM products WHERE id = ?', id)) invalidField('productIds', `Product ${id} does not exist`);
  }
}

const dupName = () => conflict('A discount with this name already exists.', { name: 'This name is already used' });

function present(db: DB, row: DiscountRow) {
  return toDiscount(row, loadDiscountProducts(db, [row.id]).get(row.id) ?? [], today());
}

export function discountsRouter(db: DB): Router {
  const router = Router();
  // Staff can see the rules (they need them to quote); only the admin may create or change them.
  const read = requireRole('admin', 'staff');
  const write = requireRole('admin');

  router.get('/', read, (req, res) => {
    const { page, pageSize, q, status } = parse(listSchema, req.query);
    const date = today();
    const where: string[] = [];
    const args: Param[] = [];
    if (q) {
      where.push(`name LIKE ? ESCAPE '\\'`);
      args.push(likePattern(q));
    }
    // Status is derived from dates, usage and the active flag, so it is filtered in SQL with the same rules.
    const statusSql: Record<string, [string, Param[]]> = {
      inactive: ['is_active = 0', []],
      scheduled: ['is_active = 1 AND start_date > ?', [date]],
      expired: ['is_active = 1 AND start_date <= ? AND end_date IS NOT NULL AND end_date < ?', [date, date]],
      used_up: ['is_active = 1 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?) AND usage_limit IS NOT NULL AND usage_count >= usage_limit', [date, date]],
      active: ['is_active = 1 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?) AND (usage_limit IS NULL OR usage_count < usage_limit)', [date, date]],
    };
    if (status) {
      const [sql, params] = statusSql[status]!;
      where.push(sql);
      args.push(...params);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM discounts ${clause}`, ...args)!.n;
    const rows = all<DiscountRow>(db, `SELECT * FROM discounts ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);
    const products = loadDiscountProducts(db, rows.map((r) => r.id));
    res.json(pageOf(rows.map((r) => toDiscount(r, products.get(r.id) ?? [], date)), total, page, pageSize));
  });

  router.get('/:id', read, (req, res) => {
    const row = get<DiscountRow>(db, 'SELECT * FROM discounts WHERE id = ?', Number(req.params.id));
    if (!row) throw notFound('Discount');
    res.json({ discount: present(db, row) });
  });

  router.post('/', write, (req, res) => {
    const input = parse(createSchema, req.body);
    const value = normalizeValue(input.kind, input.value);
    if (input.endDate && input.endDate < input.startDate) invalidField('endDate', 'Must be on or after the start date');
    if (input.scope === 'products' && input.productIds.length === 0) invalidField('productIds', 'Choose at least one product');
    assertProducts(db, input.productIds);
    const productIds = input.scope === 'products' ? [...new Set(input.productIds)] : [];

    try {
      const id = transaction(db, () => {
        const discountId = run(
          db,
          `INSERT INTO discounts (name, kind, value, scope, min_purchase_minor, min_quantity, start_date, end_date, usage_limit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.name,
          input.kind,
          value,
          input.scope,
          input.minPurchase,
          input.minQuantity,
          input.startDate,
          input.endDate ?? null,
          input.usageLimit ?? null,
        ).lastInsertRowid;
        for (const p of productIds) run(db, 'INSERT INTO discount_products (discount_id, product_id) VALUES (?, ?)', discountId, p);
        return discountId;
      });
      res.status(201).json({ discount: present(db, get<DiscountRow>(db, 'SELECT * FROM discounts WHERE id = ?', id)!) });
    } catch (err) {
      if (isUniqueViolation(err)) throw dupName();
      throw err;
    }
  });

  router.patch('/:id', write, (req, res) => {
    const id = Number(req.params.id);
    const current = Number.isInteger(id) ? get<DiscountRow>(db, 'SELECT * FROM discounts WHERE id = ?', id) : undefined;
    if (!current) throw notFound('Discount');
    const input = parse(updateSchema, req.body);

    const kind = input.kind ?? current.kind;
    const scope = input.scope ?? current.scope;
    // If the kind changes, the old value is meaningless, so a new one must come with it.
    if (input.kind && input.kind !== current.kind && input.value === undefined) invalidField('value', 'Enter a value for the new discount type');
    const value = input.value === undefined ? current.value : normalizeValue(kind, input.value);
    const start = input.startDate ?? current.start_date;
    const end = input.endDate === undefined ? current.end_date : input.endDate;
    if (end !== null && end < start) invalidField('endDate', 'Must be on or after the start date');

    const existingProducts = (loadDiscountProducts(db, [id]).get(id) ?? []).map((p) => p.id);
    const productIds = scope === 'products' ? [...new Set(input.productIds ?? existingProducts)] : [];
    if (scope === 'products' && productIds.length === 0) invalidField('productIds', 'Choose at least one product');
    assertProducts(db, productIds);

    const usageLimit = input.usageLimit === undefined ? current.usage_limit : input.usageLimit;
    if (usageLimit !== null && usageLimit < current.usage_count) {
      invalidField('usageLimit', `Already used ${current.usage_count} time${current.usage_count === 1 ? '' : 's'}; the limit cannot be lower`);
    }

    try {
      transaction(db, () => {
        run(
          db,
          `UPDATE discounts SET name = ?, kind = ?, value = ?, scope = ?, min_purchase_minor = ?, min_quantity = ?,
                  start_date = ?, end_date = ?, usage_limit = ?, is_active = ? WHERE id = ?`,
          input.name ?? current.name,
          kind,
          value,
          scope,
          input.minPurchase ?? current.min_purchase_minor,
          input.minQuantity ?? current.min_quantity,
          start,
          end,
          usageLimit,
          input.isActive === undefined ? current.is_active : input.isActive ? 1 : 0,
          id,
        );
        run(db, 'DELETE FROM discount_products WHERE discount_id = ?', id);
        for (const p of productIds) run(db, 'INSERT INTO discount_products (discount_id, product_id) VALUES (?, ?)', id, p);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw dupName();
      throw err;
    }
    res.json({ discount: present(db, get<DiscountRow>(db, 'SELECT * FROM discounts WHERE id = ?', id)!) });
  });

  return router;
}

