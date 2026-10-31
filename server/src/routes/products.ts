import { Router } from 'express';
import { z } from 'zod';
import { type DB, type Param, all, get, isUniqueViolation, run, transaction } from '../db.js';
import { type ProductRow, type TaxRow, type VariantRow, loadVariants, toProduct, toVariant } from '../lib/catalog.js';
import { conflict, invalidField, likePattern, notFound, pageOf, pagingSchema, parse, text } from '../lib/http.js';
import { moneySchema } from '../lib/money.js';
import { requireRole } from '../middleware/auth.js';

const TYPES = ['software', 'add_on', 'service', 'goods'] as const;

const name = z.string(text('Name')).trim().min(1, 'Name is required').max(120, 'Name is too long');
const variantFields = {
  attribute: z.string(text('Attribute')).trim().min(1, 'Attribute is required (for example Brand)').max(60, 'Attribute is too long'),
  value: z.string(text('Value')).trim().min(1, 'Value is required (for example Odoo)').max(60, 'Value is too long'),
  extraPrice: moneySchema('Extra price'),
};
const variantSchema = z.object(variantFields);
const variantUpdateSchema = z.object({ ...variantFields, isActive: z.boolean() }).partial();

const productFields = {
  name,
  type: z.enum(TYPES, { errorMap: () => ({ message: `Type must be one of: ${TYPES.join(', ')}` }) }),
  salesPrice: moneySchema('Sales price'),
  costPrice: moneySchema('Cost price'),
  taxId: z.number({ invalid_type_error: 'Choose a tax' }).int().positive().nullable(),
  notes: z.string(text('Notes')).trim().max(2000, 'Notes are too long').nullable(),
};
const createSchema = z.object({
  ...productFields,
  taxId: productFields.taxId.optional(),
  notes: productFields.notes.optional(),
  variants: z.array(variantSchema).max(50, 'At most 50 variants').optional(),
});
const updateSchema = z.object({ ...productFields, isActive: z.boolean() }).partial();
const listSchema = pagingSchema.extend({
  q: z.string().trim().max(100).optional(),
  type: z.enum(TYPES).optional(),
  active: z.enum(['true', 'false']).optional(),
});

function assertActiveTax(db: DB, taxId: number | null | undefined) {
  if (taxId == null) return;
  const tax = get<TaxRow>(db, 'SELECT * FROM taxes WHERE id = ?', taxId);
  if (!tax || !tax.is_active) invalidField('taxId', 'Choose an existing, active tax');
}

const dupProduct = () => conflict('A product with this name already exists.', { name: 'This name is already used' });
const dupVariant = () => conflict('That option already exists on this product.', { value: 'This option already exists' });

function present(db: DB, row: ProductRow) {
  const variants = loadVariants(db, [row.id]).get(row.id) ?? [];
  const tax = row.tax_id ? get<TaxRow>(db, 'SELECT * FROM taxes WHERE id = ?', row.tax_id) : undefined;
  return toProduct(row, variants, tax);
}

export function productsRouter(db: DB): Router {
  const router = Router();
  const read = requireRole('admin', 'staff');
  const write = requireRole('admin');

  router.get('/', read, (req, res) => {
    const { page, pageSize, q, type, active } = parse(listSchema, req.query);
    const where: string[] = [];
    const args: Param[] = [];
    if (q) {
      where.push(`p.name LIKE ? ESCAPE '\\'`);
      args.push(likePattern(q));
    }
    if (type) {
      where.push('p.type = ?');
      args.push(type);
    }
    if (active) where.push(`p.is_active = ${active === 'true' ? 1 : 0}`);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM products p ${clause}`, ...args)!.n;
    const rows = all<ProductRow>(db, `SELECT p.* FROM products p ${clause} ORDER BY p.name LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);

    const variants = loadVariants(db, rows.map((r) => r.id));
    const taxes = new Map(all<TaxRow>(db, 'SELECT * FROM taxes').map((t) => [t.id, t]));
    res.json(pageOf(rows.map((r) => toProduct(r, variants.get(r.id) ?? [], r.tax_id ? taxes.get(r.tax_id) : undefined)), total, page, pageSize));
  });

  router.get('/:id', read, (req, res) => {
    const row = get<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', Number(req.params.id));
    if (!row) throw notFound('Product');
    res.json({ product: present(db, row) });
  });

  router.post('/', write, (req, res) => {
    const input = parse(createSchema, req.body);
    assertActiveTax(db, input.taxId);
    const seen = new Set<string>();
    for (const [i, v] of (input.variants ?? []).entries()) {
      const key = `${v.attribute.toLowerCase()}|${v.value.toLowerCase()}`;
      if (seen.has(key)) invalidField(`variants.${i}.value`, 'This option is listed twice');
      seen.add(key);
    }
    try {
      const id = transaction(db, () => {
        const productId = run(
          db,
          `INSERT INTO products (name, type, sales_price_minor, cost_price_minor, tax_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
          input.name,
          input.type,
          input.salesPrice,
          input.costPrice,
          input.taxId ?? null,
          input.notes || null,
        ).lastInsertRowid;
        for (const v of input.variants ?? []) {
          run(db, 'INSERT INTO product_variants (product_id, attribute, value, extra_price_minor) VALUES (?, ?, ?, ?)', productId, v.attribute, v.value, v.extraPrice);
        }
        return productId;
      });
      res.status(201).json({ product: present(db, get<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', id)!) });
    } catch (err) {
      if (isUniqueViolation(err)) throw dupProduct();
      throw err;
    }
  });

  router.patch('/:id', write, (req, res) => {
    const id = Number(req.params.id);
    const current = Number.isInteger(id) ? get<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', id) : undefined;
    if (!current) throw notFound('Product');
    const input = parse(updateSchema, req.body);
    if (input.taxId !== undefined) assertActiveTax(db, input.taxId);

    try {
      run(
        db,
        `UPDATE products SET name = ?, type = ?, sales_price_minor = ?, cost_price_minor = ?, tax_id = ?, notes = ?, is_active = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        input.name ?? current.name,
        input.type ?? current.type,
        input.salesPrice ?? current.sales_price_minor,
        input.costPrice ?? current.cost_price_minor,
        input.taxId === undefined ? current.tax_id : input.taxId,
        input.notes === undefined ? current.notes : input.notes || null,
        input.isActive === undefined ? current.is_active : input.isActive ? 1 : 0,
        id,
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw dupProduct();
      throw err;
    }
    res.json({ product: present(db, get<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', id)!) });
  });

  router.post('/:id/variants', write, (req, res) => {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || !get(db, 'SELECT 1 AS x FROM products WHERE id = ?', productId)) throw notFound('Product');
    const input = parse(variantSchema, req.body);
    try {
      const id = run(db, 'INSERT INTO product_variants (product_id, attribute, value, extra_price_minor) VALUES (?, ?, ?, ?)', productId, input.attribute, input.value, input.extraPrice).lastInsertRowid;
      res.status(201).json({ variant: toVariant(get<VariantRow>(db, 'SELECT * FROM product_variants WHERE id = ?', id)!) });
    } catch (err) {
      if (isUniqueViolation(err)) throw dupVariant();
      throw err;
    }
  });

  router.patch('/:id/variants/:variantId', write, (req, res) => {
    const productId = Number(req.params.id);
    const variantId = Number(req.params.variantId);
    const current = get<VariantRow>(db, 'SELECT * FROM product_variants WHERE id = ? AND product_id = ?', variantId, productId);
    if (!current) throw notFound('Variant');
    const input = parse(variantUpdateSchema, req.body);
    try {
      run(
        db,
        'UPDATE product_variants SET attribute = ?, value = ?, extra_price_minor = ?, is_active = ? WHERE id = ?',
        input.attribute ?? current.attribute,
        input.value ?? current.value,
        input.extraPrice ?? current.extra_price_minor,
        input.isActive === undefined ? current.is_active : input.isActive ? 1 : 0,
        variantId,
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw dupVariant();
      throw err;
    }
    res.json({ variant: toVariant(get<VariantRow>(db, 'SELECT * FROM product_variants WHERE id = ?', variantId)!) });
  });

  return router;
}
