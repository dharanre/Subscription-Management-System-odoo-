import { Router } from 'express';
import { z } from 'zod';
import { type DB, all, get, isUniqueViolation, run, transaction } from '../db.js';
import { type TaxRow, toTax } from '../lib/catalog.js';
import { HttpError, conflict, notFound, pageOf, pagingSchema, parse, text, kind } from '../lib/http.js';
import { percentSchema } from '../lib/money.js';
import { requireRole } from '../middleware/auth.js';

const taxFields = {
  name: z.string(text('Name')).trim().min(1, 'Name is required').max(80, 'Name is too long'),
  ratePercent: percentSchema('Tax rate'),
  isDefault: z.boolean(kind('isDefault must be true or false')),
  isActive: z.boolean(kind('isActive must be true or false')),
};
const createSchema = z.object({
  name: taxFields.name,
  ratePercent: taxFields.ratePercent,
  isDefault: taxFields.isDefault.default(false),
});
const updateSchema = z.object(taxFields).partial();
const listSchema = pagingSchema.extend({ active: z.enum(['true', 'false']).optional() });

const dupName = () => conflict('A tax with this name already exists.', { name: 'This name is already used' });

export function taxesRouter(db: DB): Router {
  const router = Router();

  router.get('/', requireRole('admin', 'staff'), (req, res) => {
    const { page, pageSize, active } = parse(listSchema, req.query);
    const where = active ? `WHERE is_active = ${active === 'true' ? 1 : 0}` : '';
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM taxes ${where}`)!.n;
    const rows = all<TaxRow>(db, `SELECT * FROM taxes ${where} ORDER BY is_default DESC, name LIMIT ? OFFSET ?`, pageSize, (page - 1) * pageSize);
    res.json(pageOf(rows.map(toTax), total, page, pageSize));
  });

  router.post('/', requireRole('admin'), (req, res) => {
    const input = parse(createSchema, req.body);
    try {
      const id = transaction(db, () => {
        if (input.isDefault) run(db, 'UPDATE taxes SET is_default = 0 WHERE is_default = 1');
        return run(db, 'INSERT INTO taxes (name, rate_bp, is_default) VALUES (?, ?, ?)', input.name, input.ratePercent, input.isDefault ? 1 : 0).lastInsertRowid;
      });
      res.status(201).json({ tax: toTax(get<TaxRow>(db, 'SELECT * FROM taxes WHERE id = ?', id)!) });
    } catch (err) {
      if (isUniqueViolation(err)) throw dupName();
      throw err;
    }
  });

  router.patch('/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    const current = Number.isInteger(id) ? get<TaxRow>(db, 'SELECT * FROM taxes WHERE id = ?', id) : undefined;
    if (!current) throw notFound('Tax');
    const input = parse(updateSchema, req.body);

    const isActive = input.isActive ?? current.is_active === 1;
    const isDefault = isActive ? (input.isDefault ?? current.is_default === 1) : false;

    if (!isActive && current.is_active === 1) {
      const users = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM products WHERE tax_id = ? AND is_active = 1', id)!.n;
      if (users > 0) {
        throw new HttpError(409, 'in_use', `${users} active product${users === 1 ? ' still uses' : 's still use'} this tax. Move them to another tax first.`);
      }
    }

    try {
      transaction(db, () => {
        if (isDefault) run(db, 'UPDATE taxes SET is_default = 0 WHERE is_default = 1 AND id <> ?', id);
        run(
          db,
          'UPDATE taxes SET name = ?, rate_bp = ?, is_default = ?, is_active = ? WHERE id = ?',
          input.name ?? current.name,
          input.ratePercent ?? current.rate_bp,
          isDefault ? 1 : 0,
          isActive ? 1 : 0,
          id,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw dupName();
      throw err;
    }
    res.json({ tax: toTax(get<TaxRow>(db, 'SELECT * FROM taxes WHERE id = ?', id)!) });
  });

  return router;
}
