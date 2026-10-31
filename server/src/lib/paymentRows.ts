import { type DB, all, get } from '../db.js';
import { fromMinor } from './money.js';

/** Payment rows and how they are shown. Kept apart from the rules in payments.ts so invoices can show payments too. */

export const METHODS = ['bank_transfer', 'cash', 'cheque', 'card', 'upi', 'other'] as const;
export type PaymentMethod = (typeof METHODS)[number];

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  cheque: 'Cheque',
  card: 'Card',
  upi: 'UPI',
  other: 'Other',
};

export interface PaymentRow {
  id: number;
  invoice_id: number;
  customer_id: number;
  amount_minor: number;
  method: PaymentMethod;
  paid_on: string;
  reference: string | null;
  note: string | null;
  request_id: string | null;
  status: 'recorded' | 'voided';
  recorded_by: number | null;
  voided_at: string | null;
  void_reason: string | null;
  is_demo: number;
  created_at: string;
}

export const getPayment = (db: DB, id: number) => get<PaymentRow>(db, 'SELECT * FROM payments WHERE id = ?', id);

export const presentPayment = (r: PaymentRow & { invoice_number?: string; customer_name?: string; customer_company?: string | null }) => ({
  id: r.id,
  invoiceId: r.invoice_id,
  invoiceNumber: r.invoice_number ?? null,
  customer: r.customer_name !== undefined ? { id: r.customer_id, name: r.customer_name, company: r.customer_company ?? null } : null,
  amount: fromMinor(r.amount_minor),
  method: r.method,
  methodLabel: METHOD_LABELS[r.method],
  paidOn: r.paid_on,
  reference: r.reference,
  note: r.note,
  status: r.status,
  voidedAt: r.voided_at,
  voidReason: r.void_reason,
  isDemo: r.is_demo === 1,
  createdAt: r.created_at,
});

export const paymentsOfInvoice = (db: DB, invoiceId: number, includeVoided: boolean) =>
  all<PaymentRow>(db, `SELECT * FROM payments WHERE invoice_id = ? ${includeVoided ? '' : `AND status = 'recorded'`} ORDER BY paid_on DESC, id DESC`, invoiceId);
