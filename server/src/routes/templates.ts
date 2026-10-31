import { Router } from 'express';
import { z } from 'zod';
import { type DB, type Param, all, get, isUniqueViolation, run, transaction } from '../db.js';
import { type PlanRow, buildLines } from '../lib/catalog.js';
import { conflict, invalidField, likePattern, notFound, pageOf, pagingSchema, parse, text } from '../lib/http.js';
import { fromMinor } from '../lib/money.js';
import { requireRole } from '../middleware/auth.js';

const lineSchema = z.object({
  productId: z.number({ required_error: 'Choose a product', invalid_type_error: 'Choose a product' }).int().positive('Choose a product'),
  variantId: z.number({ invalid_type_error: 'Choose a valid option' }).int().positive().nullable().optional(),
  quantity: z.number({ required_error: 'Quantity is required', invalid_type_error: 'Quantity must be a number' }).int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(100_000, 'Quantity is too large'),
});

const fields = {
  name: z.string(text('Name')).trim().min(1, 'Name is required').max(120, 'Name is too long'),
  planId: z.number({ required_error: 'Choose a plan', invalid_type_error: 'Choose a plan' }).int().positive('Choose a plan'),
  validityDays: z.number({ required_error: 'Validity is required', invalid_type_error: 'Validity must be a number' }).int('Validity must be a whole number of days').min(1, 'Validity must be at least 1 day').max(365, 'Validity cannot exceed 365 days'),
  paymentTermsId: z.number({ invalid_type_error: 'Choose payment terms' }).int().positive().nullable(),
  notes: z.string(text('Notes')).trim().max(2000, 'Notes are too long').nullable(),
  lines: z.array(lineSchema).max(50, 'At most 50 lines'),
  isActive: z.boolean({ invalid_type_error: 'isActive must be true or false' }),
};
// New templates are always created active, so `isActive` is only accepted on update.
const { isActive: _templateActive, ...createFields } = fields;
const createSchema = z.object({ ...createFields, paymentTermsId: fields.paymentTermsId.optional(), notes: fields.notes.optional() });
const updateSchema = z.object(fields).partial();
const listSchema = pagingSchema.extend({
  q: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
});

interface TemplateRow {
  id: number;
  name: string;
  plan_id: number;
  validity_days: number;
  payment_terms_id: number | null;
  notes: string | null;
  is_active: number;
  is_demo: number;
  created_at: string;
}

const dup = () => conflict('A template with this name already exists.', { name: 'This name is already used' });

/**
 * A quotation template is a reusable starting point: a plan, product lines, payment terms and how many
 * days a quotation made from it stays valid. Admins maintain them; staff pick one when quoting.
 */
export function templatesRouter(db: DB): Router {
  const router = Router();
  const read = requireRole('admin', 'staff');
  const write = requireRole('admin');

  function present(rows: TemplateRow[]) {
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const plans = new Map(all<PlanRow>(db, `SELECT * FROM plans WHERE id IN (${rows.map(() => '?').join(',') || 'NULL'})`, ...rows.map((r) => r.plan_id)).map((p) => [p.id, p]));
    const terms = new Map(all<{ id: number; name: string }>(db, 'SELECT id, name FROM payment_terms').map((t) => [t.id, t.name]));
    const lines = ids.length
      ? all<{ id: number; template_id: number; product_id: number; variant_id: number | null; quantity: number; product_name: string; sales_price_minor: number; attribute: string | null; value: string | null; extra: number | null }>(
          db,
          `SELECT l.id, l.template_id, l.product_id, l.variant_id, l.quantity, p.name AS product_name, p.sales_price_minor,
                  v.attribute, v.value, v.extra_price_minor AS extra
             FROM quotation_template_lines l JOIN products p ON p.id = l.product_id
             LEFT JOIN product_variants v ON v.id = l.variant_id
            WHERE l.template_id IN (${marks}) ORDER BY l.template_id, l.position`,
          ...ids,
        )
      : [];
    return rows.map((r) => {
      const plan = plans.get(r.plan_id)!;
      return {
        id: r.id,
        name: r.name,
        plan: { id: plan.id, name: plan.name, billingPeriod: plan.billing_period, price: fromMinor(plan.price_minor), minQuantity: plan.min_quantity },
        validityDays: r.validity_days,
        paymentTerms: r.payment_terms_id ? { id: r.payment_terms_id, name: terms.get(r.payment_terms_id) ?? '' } : null,
        notes: r.notes,
        isActive: r.is_active === 1,
        isDemo: r.is_demo === 1,
        lines: lines
          .filter((l) => l.template_id === r.id)
          .map((l) => ({
            id: l.id,
            productId: l.product_id,
            productName: l.product_name,
            variantId: l.variant_id,
            variantLabel: l.attribute ? `${l.attribute}: ${l.value}` : null,
            quantity: l.quantity,
            // today's unit price, for display; quotations made from the template take their own snapshot
            unitPrice: fromMinor(l.sales_price_minor + (l.extra ?? 0)),
          })),
      };
    });
  }

  /** Validates plan, references and quantities with the same code that prices real lines. */
  function validate(planId: number, lines: { productId: number; variantId?: number | null; quantity: number }[], paymentTermsId: number | null | undefined) {
    const plan = get<PlanRow>(db, 'SELECT * FROM plans WHERE id = ?', planId);
    if (!plan || !plan.is_active) invalidField('planId', 'Choose an existing, active plan');
    if (paymentTermsId != null && !get(db, 'SELECT 1 AS x FROM payment_terms WHERE id = ? AND is_active = 1', paymentTermsId)) {
      invalidField('paymentTermsId', 'Choose existing, active payment terms');
    }
    buildLines(db, plan!, lines);
  }

  function replaceLines(templateId: number, lines: { productId: number; variantId?: number | null; quantity: number }[]) {
    run(db, 'DELETE FROM quotation_template_lines WHERE template_id = ?', templateId);
    lines.forEach((l, i) => run(db, 'INSERT INTO quotation_template_lines (template_id, position, product_id, variant_id, quantity) VALUES (?, ?, ?, ?, ?)', templateId, i, l.productId, l.variantId ?? null, l.quantity));
  }

  router.get('/', read, (req, res) => {
    const { page, pageSize, q, active } = parse(listSchema, req.query);
    const where: string[] = [];
    const args: Param[] = [];
    if (q) {
      where.push(`name LIKE ? ESCAPE '\\'`);
      args.push(likePattern(q));
    }
    if (active) where.push(`is_active = ${active === 'true' ? 1 : 0}`);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM quotation_templates ${clause}`, ...args)!.n;
    const rows = all<TemplateRow>(db, `SELECT * FROM quotation_templates ${clause} ORDER BY name LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);
    res.json(pageOf(present(rows), total, page, pageSize));
  });

  router.get('/:id', read, (req, res) => {
    const row = get<TemplateRow>(db, 'SELECT * FROM quotation_templates WHERE id = ?', Number(req.params.id));
    if (!row) throw notFound('Template');
    res.json({ template: present([row])[0] });
  });

  router.post('/', write, (req, res) => {
    const input = parse(createSchema, req.body);
    validate(input.planId, input.lines, input.paymentTermsId);
    try {
      const id = transaction(db, () => {
        const templateId = run(db, 'INSERT INTO quotation_templates (name, plan_id, validity_days, payment_terms_id, notes) VALUES (?, ?, ?, ?, ?)', input.name, input.planId, input.validityDays, input.paymentTermsId ?? null, input.notes || null).lastInsertRowid;
        replaceLines(templateId, input.lines);
        return templateId;
      });
      res.status(201).json({ template: present([get<TemplateRow>(db, 'SELECT * FROM quotation_templates WHERE id = ?', id)!])[0] });
    } catch (err) {
      if (isUniqueViolation(err)) throw dup();
      throw err;
    }
  });

  router.patch('/:id', write, (req, res) => {
    const id = Number(req.params.id);
    const current = Number.isInteger(id) ? get<TemplateRow>(db, 'SELECT * FROM quotation_templates WHERE id = ?', id) : undefined;
    if (!current) throw notFound('Template');
    const input = parse(updateSchema, req.body);

    const planId = input.planId ?? current.plan_id;
    const lines =
      input.lines ??
      all<{ product_id: number; variant_id: number | null; quantity: number }>(db, 'SELECT product_id, variant_id, quantity FROM quotation_template_lines WHERE template_id = ? ORDER BY position', id).map((l) => ({
        productId: l.product_id,
        variantId: l.variant_id,
        quantity: l.quantity,
      }));
    const terms = input.paymentTermsId === undefined ? current.payment_terms_id : input.paymentTermsId;
    // Only re-validate the plan and lines when they change, so an old template can still be switched off after its plan ends.
    if (input.planId !== undefined || input.lines !== undefined) validate(planId, lines, terms);
    else if (input.paymentTermsId != null) validate(planId, [], terms);

    try {
      transaction(db, () => {
        run(
          db,
          'UPDATE quotation_templates SET name = ?, plan_id = ?, validity_days = ?, payment_terms_id = ?, notes = ?, is_active = ? WHERE id = ?',
          input.name ?? current.name,
          planId,
          input.validityDays ?? current.validity_days,
          terms,
          input.notes === undefined ? current.notes : input.notes || null,
          input.isActive === undefined ? current.is_active : input.isActive ? 1 : 0,
          id,
        );
        if (input.lines !== undefined) replaceLines(id, input.lines);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw dup();
      throw err;
    }
    res.json({ template: present([get<TemplateRow>(db, 'SELECT * FROM quotation_templates WHERE id = ?', id)!])[0] });
  });

  return router;
}
