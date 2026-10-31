import { type DB, all, get, run, transaction } from '../db.js';
import { diffDays } from './dates.js';
import { HttpError, invalidField } from './http.js';
import { type InvoiceRow, getInvoice, logInvoiceEvent } from './invoices.js';
import { METHOD_LABELS, type PaymentMethod, type PaymentRow, getPayment } from './paymentRows.js';
import { fromMinor, today } from './money.js';

/**
 * Recording money received against invoices.
 *
 * The invoice's `paid_minor` is always the sum of its recorded (not voided) payments, and it can never
 * exceed the invoice total: the code checks it, and a CHECK constraint on the invoice enforces it again.
 * An invoice becomes Paid when the payments cover it, and goes back to Confirmed if a payment is voided.
 */

const fixed = (minor: number) => (minor / 100).toFixed(2);

export interface PaymentInput {
  amountMinor: number;
  method: PaymentMethod;
  /** Day the money arrived. Defaults to today. */
  paidOn?: string;
  reference?: string | null;
  note?: string | null;
  requestId?: string | null;
  isDemo?: boolean;
}

export interface Recorded {
  payment: PaymentRow;
  invoice: InvoiceRow;
  /** True when the same request had already been recorded, so nothing new was created. */
  duplicate: boolean;
}

export function recordPayment(db: DB, invoiceId: number, input: PaymentInput, actorId: number | null): Recorded {
  return transaction(db, (): Recorded => {
    const inv = getInvoice(db, invoiceId);
    if (!inv) throw new HttpError(404, 'not_found', 'Invoice was not found.');

    // A retried request is answered with what it already did.
    if (input.requestId) {
      const existing = get<PaymentRow>(db, 'SELECT * FROM payments WHERE request_id = ?', input.requestId);
      if (existing) {
        if (existing.invoice_id !== invoiceId) throw new HttpError(409, 'request_id_reused', 'That request id was already used for a different invoice.');
        return { payment: existing, invoice: inv, duplicate: true };
      }
    }

    if (inv.status === 'draft') throw new HttpError(409, 'not_payable', `Confirm ${inv.number} before recording a payment against it.`);
    if (inv.status === 'cancelled') throw new HttpError(409, 'not_payable', `${inv.number} is cancelled, so it cannot take a payment.`);
    if (inv.status === 'paid') throw new HttpError(409, 'not_payable', `${inv.number} is already paid in full.`);

    const balance = inv.total_minor - inv.paid_minor;
    if (input.amountMinor > balance) {
      invalidField('amount', `Cannot be more than the ${fixed(balance)} still owing on ${inv.number}`);
    }
    const paidOn = input.paidOn ?? today();
    if (paidOn > today()) invalidField('paidOn', 'Cannot be in the future');
    if (paidOn < inv.issue_date) invalidField('paidOn', `Cannot be before the invoice was issued (${inv.issue_date})`);

    const id = run(
      db,
      `INSERT INTO payments (invoice_id, customer_id, amount_minor, method, paid_on, reference, note, request_id, recorded_by, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      invoiceId,
      inv.customer_id,
      input.amountMinor,
      input.method,
      paidOn,
      input.reference || null,
      input.note || null,
      input.requestId || null,
      actorId,
      input.isDemo ? 1 : 0,
    ).lastInsertRowid;

    const paid = inv.paid_minor + input.amountMinor;
    const settled = paid === inv.total_minor;
    run(
      db,
      `UPDATE invoices SET paid_minor = ?, status = ?, paid_at = ${settled ? `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` : 'NULL'} WHERE id = ?`,
      paid,
      settled ? 'paid' : 'confirmed',
      invoiceId,
    );
    logInvoiceEvent(db, invoiceId, 'payment', inv.status, settled ? 'paid' : 'confirmed', actorId, `${fixed(input.amountMinor)} received by ${METHOD_LABELS[input.method].toLowerCase()} on ${paidOn}${input.reference ? ` (ref ${input.reference})` : ''}${settled ? '. Paid in full.' : `. ${fixed(inv.total_minor - paid)} still owing.`}`);

    return { payment: getPayment(db, id)!, invoice: getInvoice(db, invoiceId)!, duplicate: false };
  });
}

/** Takes a wrongly recorded payment back out. The payment stays on record, marked void with the reason. */
export function voidPayment(db: DB, paymentId: number, reason: string, actorId: number | null): { payment: PaymentRow; invoice: InvoiceRow } {
  return transaction(db, () => {
    const payment = getPayment(db, paymentId);
    if (!payment) throw new HttpError(404, 'not_found', 'Payment was not found.');
    if (payment.status === 'voided') throw new HttpError(409, 'already_voided', 'This payment has already been voided.');
    const inv = getInvoice(db, payment.invoice_id)!;

    run(db, `UPDATE payments SET status = 'voided', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), voided_by = ?, void_reason = ? WHERE id = ?`, actorId, reason, paymentId);
    const paid = inv.paid_minor - payment.amount_minor;
    run(db, `UPDATE invoices SET paid_minor = ?, status = 'confirmed', paid_at = NULL WHERE id = ?`, paid, inv.id);
    logInvoiceEvent(db, inv.id, 'payment_void', inv.status, 'confirmed', actorId, `Payment of ${fixed(payment.amount_minor)} from ${payment.paid_on} voided: ${reason}`);
    return { payment: getPayment(db, paymentId)!, invoice: getInvoice(db, inv.id)! };
  });
}

/* ---------- receivables ---------- */

export const AGING_BUCKETS = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd1_30', label: '1–30 days overdue' },
  { key: 'd31_60', label: '31–60 days overdue' },
  { key: 'd61_90', label: '61–90 days overdue' },
  { key: 'd90_plus', label: 'Over 90 days overdue' },
] as const;

/** Money still owed on confirmed invoices, split by how late it is. */
export function receivablesSummary(db: DB, asOf = today()) {
  const rows = all<{ bucket: string; n: number; amount: number; oldest: string }>(
    db,
    `SELECT CASE
              WHEN due_date >= ?1 THEN 'current'
              WHEN julianday(?1) - julianday(due_date) <= 30 THEN 'd1_30'
              WHEN julianday(?1) - julianday(due_date) <= 60 THEN 'd31_60'
              WHEN julianday(?1) - julianday(due_date) <= 90 THEN 'd61_90'
              ELSE 'd90_plus' END AS bucket,
            COUNT(*) AS n, SUM(total_minor - paid_minor) AS amount, MIN(due_date) AS oldest
       FROM invoices WHERE status = 'confirmed' AND total_minor > paid_minor GROUP BY bucket`,
    asOf,
  );
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  const buckets = AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: byKey.get(b.key)?.n ?? 0, amount: fromMinor(byKey.get(b.key)?.amount ?? 0) }));
  const overdue = buckets.filter((b) => b.key !== 'current');
  const oldest = rows.filter((r) => r.bucket !== 'current').map((r) => r.oldest).sort()[0] ?? null;
  return {
    asOf,
    outstanding: { count: buckets.reduce((n, b) => n + b.count, 0), amount: round2(buckets.reduce((n, b) => n + b.amount, 0)) },
    overdue: { count: overdue.reduce((n, b) => n + b.count, 0), amount: round2(overdue.reduce((n, b) => n + b.amount, 0)), oldestDueDate: oldest, oldestDaysOverdue: oldest ? diffDays(oldest, asOf) : 0 },
    buckets,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
