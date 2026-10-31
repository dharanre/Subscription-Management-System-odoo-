import type { Config } from '../config.js';
import { type DB, all, get, run, transaction } from '../db.js';
import { diffDays } from './dates.js';
import { HttpError } from './http.js';
import type { Mailer } from './mailer.js';
import { bpToPercent, fromMinor, today } from './money.js';

/** Invoice rules in one place: the billing run, the API and the seed all use these, so they cannot disagree. */

export type InvoiceStatus = 'draft' | 'confirmed' | 'paid' | 'cancelled';
export type InvoiceAction = 'confirm' | 'send' | 'cancel';

export interface InvoiceRow {
  id: number;
  number: string;
  subscription_id: number;
  customer_id: number;
  period_index: number;
  period_start: string;
  period_end: string;
  issue_date: string;
  due_date: string;
  status: InvoiceStatus;
  customer_name: string;
  customer_company: string | null;
  customer_email: string;
  customer_address: string | null;
  subscription_number: string;
  plan_name: string;
  payment_terms_name: string | null;
  discount_id: number | null;
  discount_name: string | null;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  sent_at: string | null;
  sent_count: number;
  confirmed_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_by: number | null;
  is_demo: number;
  created_at: string;
}

export interface InvoiceLineRow {
  id: number;
  invoice_id: number;
  position: number;
  kind: 'plan' | 'product';
  description: string;
  product_id: number | null;
  quantity: number;
  unit_price_minor: number;
  tax_name: string | null;
  tax_rate_bp: number;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
}

const ACTION_LABELS: Record<InvoiceAction, string> = { confirm: 'Confirm', send: 'Send', cancel: 'Cancel' };

export const getInvoice = (db: DB, id: number) => get<InvoiceRow>(db, 'SELECT * FROM invoices WHERE id = ?', id);

export function logInvoiceEvent(db: DB, invoiceId: number, action: string, from: InvoiceStatus | null, to: InvoiceStatus, actorId: number | null, note?: string | null) {
  run(db, 'INSERT INTO invoice_events (invoice_id, action, from_status, to_status, actor_id, note) VALUES (?, ?, ?, ?, ?, ?)', invoiceId, action, from, to, actorId, note || null);
}

export const balanceMinor = (r: Pick<InvoiceRow, 'total_minor' | 'paid_minor'>) => r.total_minor - r.paid_minor;

/** Confirmed, still owing something, and past its due date. */
export const isOverdue = (r: InvoiceRow, date: string) => r.status === 'confirmed' && r.due_date < date && balanceMinor(r) > 0;

/** What a staff member can do with this invoice right now. Customers cannot change invoices. */
export function availableInvoiceActions(r: InvoiceRow): { action: InvoiceAction; label: string }[] {
  const out: InvoiceAction[] = [];
  if (r.status === 'draft') out.push('confirm');
  if (r.status === 'confirmed' || r.status === 'paid') out.push('send');
  if ((r.status === 'draft' || r.status === 'confirmed') && r.paid_minor === 0) out.push('cancel');
  return out.map((action) => ({ action, label: ACTION_LABELS[action] }));
}

const wrongState = (r: InvoiceRow, only: string) => new HttpError(409, 'invalid_transition', `${only}; ${r.number} is ${r.status}.`);

/** Draft -> Confirmed. An invoice for nothing owes nothing, so it goes straight to Paid. */
export function confirmInvoice(db: DB, id: number, actorId: number | null): InvoiceRow {
  return transaction(db, () => {
    const inv = getInvoice(db, id);
    if (!inv) throw new HttpError(404, 'not_found', 'Invoice was not found.');
    if (inv.status !== 'draft') throw wrongState(inv, 'Only a draft invoice can be confirmed');

    run(db, `UPDATE invoices SET status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, id);
    logInvoiceEvent(db, id, 'confirm', 'draft', 'confirmed', actorId);
    if (inv.total_minor === 0) {
      run(db, `UPDATE invoices SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, id);
      logInvoiceEvent(db, id, 'paid', 'confirmed', 'paid', actorId, 'Nothing to pay on this invoice');
    }
    return getInvoice(db, id)!;
  });
}

/**
 * Cancels a draft or confirmed invoice that has no payments. The billing period stays accounted for, so a
 * later billing run will not quietly invoice it again; the reason is kept on the invoice.
 */
export function cancelInvoice(db: DB, id: number, actorId: number | null, reason?: string | null): InvoiceRow {
  return transaction(db, () => {
    const inv = getInvoice(db, id);
    if (!inv) throw new HttpError(404, 'not_found', 'Invoice was not found.');
    if (inv.status !== 'draft' && inv.status !== 'confirmed') throw wrongState(inv, 'Only a draft or confirmed invoice can be cancelled');
    if (inv.paid_minor > 0) throw new HttpError(409, 'has_payments', 'Payments have been recorded against this invoice, so it cannot be cancelled.');

    run(db, `UPDATE invoices SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), cancel_reason = ? WHERE id = ?`, reason || null, id);
    logInvoiceEvent(db, id, 'cancel', inv.status, 'cancelled', actorId, reason);
    return getInvoice(db, id)!;
  });
}

/**
 * Emails the invoice to the customer. Nothing is recorded as sent unless the mailer accepted it. This
 * only tells the customer an invoice exists: it does not charge anything, because no payment provider
 * is connected.
 */
export async function sendInvoice(db: DB, mailer: Mailer, config: Config, id: number, actorId: number | null): Promise<InvoiceRow> {
  const inv = getInvoice(db, id);
  if (!inv) throw new HttpError(404, 'not_found', 'Invoice was not found.');
  if (inv.status === 'draft') throw new HttpError(409, 'invalid_transition', `Confirm ${inv.number} before sending it.`);
  if (inv.status === 'cancelled') throw wrongState(inv, 'A cancelled invoice cannot be sent');

  const money = new Intl.NumberFormat(config.locale, { style: 'currency', currency: config.currency });
  const owing = balanceMinor(inv);
  try {
    await mailer.send({
      to: inv.customer_email,
      subject: `Invoice ${inv.number} from Brightloop`,
      text:
        `Hi ${inv.customer_name},\n\n` +
        `Invoice ${inv.number} for ${inv.plan_name} (${inv.period_start} to ${inv.period_end}) is ready.\n` +
        `Total: ${money.format(fromMinor(inv.total_minor))}\n` +
        (owing > 0 ? `Amount due: ${money.format(fromMinor(owing))} by ${inv.due_date}\n` : 'Nothing is owing on this invoice.\n') +
        `\nView it here: ${config.appUrl}/invoices/${inv.id}\n`,
    });
  } catch (err) {
    console.error('[invoices] could not send invoice email', err);
    throw new HttpError(502, 'send_failed', 'The email could not be sent, so the invoice was not marked as sent. Try again.');
  }

  return transaction(db, () => {
    run(db, `UPDATE invoices SET sent_count = sent_count + 1, sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, id);
    logInvoiceEvent(db, id, 'send', inv.status, inv.status, actorId, `Emailed to ${inv.customer_email}`);
    return getInvoice(db, id)!;
  });
}

/* ---------- presentation ---------- */

export function presentInvoiceSummary(r: InvoiceRow, date = today()) {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    customer: { id: r.customer_id, name: r.customer_name, company: r.customer_company },
    subscription: { id: r.subscription_id, number: r.subscription_number },
    periodStart: r.period_start,
    periodEnd: r.period_end,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    isOverdue: isOverdue(r, date),
    daysOverdue: isOverdue(r, date) ? diffDays(r.due_date, date) : 0,
    total: fromMinor(r.total_minor),
    paid: fromMinor(r.paid_minor),
    balance: fromMinor(balanceMinor(r)),
    sentAt: r.sent_at,
    isDemo: r.is_demo === 1,
  };
}

export function presentInvoice(db: DB, r: InvoiceRow, viewer: 'staff' | 'customer') {
  const lines = all<InvoiceLineRow>(db, 'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position', r.id);
  const events =
    viewer === 'staff'
      ? all<{ id: number; action: string; from_status: string | null; to_status: string; actor_name: string | null; note: string | null; at: string }>(
          db,
          `SELECT e.id, e.action, e.from_status, e.to_status, u.name AS actor_name, e.note, e.at
             FROM invoice_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.invoice_id = ? ORDER BY e.id`,
          r.id,
        )
      : [];
  return {
    ...presentInvoiceSummary(r),
    customerDetails: { name: r.customer_name, company: r.customer_company, email: r.customer_email, address: r.customer_address },
    planName: r.plan_name,
    paymentTerms: r.payment_terms_name,
    discount: r.discount_id ? { id: r.discount_id, name: r.discount_name, amount: fromMinor(r.discount_minor) } : null,
    lines: lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      description: l.description,
      quantity: l.quantity,
      unitPrice: fromMinor(l.unit_price_minor),
      taxName: l.tax_name,
      taxRatePercent: bpToPercent(l.tax_rate_bp),
      subtotal: fromMinor(l.subtotal_minor),
      discount: fromMinor(l.discount_minor),
      tax: fromMinor(l.tax_minor),
      total: fromMinor(l.total_minor),
    })),
    totals: {
      subtotal: fromMinor(r.subtotal_minor),
      discount: fromMinor(r.discount_minor),
      tax: fromMinor(r.tax_minor),
      total: fromMinor(r.total_minor),
      paid: fromMinor(r.paid_minor),
      balance: fromMinor(balanceMinor(r)),
    },
    confirmedAt: r.confirmed_at,
    paidAt: r.paid_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    sentCount: r.sent_count,
    events: events.map((e) => ({ id: e.id, action: e.action, fromStatus: e.from_status, toStatus: e.to_status, actor: e.actor_name, note: e.note, at: e.at })),
    actions: viewer === 'staff' ? availableInvoiceActions(r) : [],
  };
}
