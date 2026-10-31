import { Router } from 'express';
import { z } from 'zod';
import { type DB, all, get, isUniqueViolation, run, transaction } from '../db.js';
import { conflict, notFound, parse, text, kind } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';

interface TermsRow {
  id: number;
  name: string;
  days_due: number;
  is_default: number;
  is_active: number;
  is_demo: number;
}

const toTerms = (r: TermsRow) => ({ id: r.id, name: r.name, daysDue: r.days_due, isDefault: r.is_default === 1, isActive: r.is_active === 1, isDemo: r.is_demo === 1 });

const fields = {
  name: z.string(text('Name')).trim().min(1, 'Name is required').max(80, 'Name is too long'),
  daysDue: z.number(kind('Days due must be a number', 'Days due is required')).int('Days due must be a whole number').min(0, 'Days due cannot be negative').max(365, 'Days due cannot exceed 365'),
  isDefault: z.boolean(kind('isDefault must be true or false')),
  isActive: z.boolean(kind('isActive must be true or false')),
};
const createSchema = z.object({ name: fields.name, daysDue: fields.daysDue, isDefault: fields.isDefault.default(false) });
const updateSchema = z.object(fields).partial();

const dup = () => conflict('Payment terms with this name already exist.', { name: 'This name is already used' });

/** Payment terms say how many days after the invoice date payment is due; invoices use them to work out the due date. */
export function paymentTermsRouter(db: DB): Router {
  const router = Router();

  router.get('/', requireRole('admin', 'staff'), (_req, res) => {
    res.json({ items: all<TermsRow>(db, 'SELECT * FROM payment_terms ORDER BY is_default DESC, days_due, name').map(toTerms) });
  });

  router.post('/', requireRole('admin'), (req, res) => {
    const input = parse(createSchema, req.body);
    try {
      const id = transaction(db, () => {
        if (input.isDefault) run(db, 'UPDATE payment_terms SET is_default = 0 WHERE is_default = 1');
        return run(db, 'INSERT INTO payment_terms (name, days_due, is_default) VALUES (?, ?, ?)', input.name, input.daysDue, input.isDefault ? 1 : 0).lastInsertRowid;
      });
      res.status(201).json({ terms: toTerms(get<TermsRow>(db, 'SELECT * FROM payment_terms WHERE id = ?', id)!) });
    } catch (err) {
      if (isUniqueViolation(err)) throw dup();
      throw err;
    }
  });

  router.patch('/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    const current = Number.isInteger(id) ? get<TermsRow>(db, 'SELECT * FROM payment_terms WHERE id = ?', id) : undefined;
    if (!current) throw notFound('Payment terms');
    const input = parse(updateSchema, req.body);
    const isActive = input.isActive ?? current.is_active === 1;
    const isDefault = isActive ? (input.isDefault ?? current.is_default === 1) : false;
    try {
      transaction(db, () => {
        if (isDefault) run(db, 'UPDATE payment_terms SET is_default = 0 WHERE is_default = 1 AND id <> ?', id);
        run(db, 'UPDATE payment_terms SET name = ?, days_due = ?, is_default = ?, is_active = ? WHERE id = ?', input.name ?? current.name, input.daysDue ?? current.days_due, isDefault ? 1 : 0, isActive ? 1 : 0, id);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw dup();
      throw err;
    }
    res.json({ terms: toTerms(get<TermsRow>(db, 'SELECT * FROM payment_terms WHERE id = ?', id)!) });
  });

  return router;
}
