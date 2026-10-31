import { type DB, all, get } from '../db.js';
import { addDays, diffDays } from './dates.js';
import { fromMinor, today } from './money.js';
import { receivablesSummary } from './payments.js';

/**
 * Everything on the finance dashboard, worked out from the current records on every request: nothing is cached
 * or stored, so a payment, an invoice or a status change shows up the next time the dashboard is read.
 */

const STATUSES = ['draft', 'quotation', 'confirmed', 'active', 'paused', 'closed'] as const;
const MAX_RANGE_DAYS = 1100;

/** How many of each plan period make up a month, for turning every plan's price into a monthly figure. */
const PERIODS_PER_MONTH: Record<string, number> = { daily: 365 / 12, weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };

export interface Range {
  from: string;
  to: string;
}

export function defaultRange(date = today()): Range {
  return { from: addDays(date, -29), to: date };
}

export function checkRange(r: Range): string | null {
  if (r.from > r.to) return 'The start date must be on or before the end date';
  if (diffDays(r.from, r.to) > MAX_RANGE_DAYS) return 'Choose a range of three years or less';
  return null;
}

const monthKey = (iso: string) => iso.slice(0, 7);
const monthLabel = (key: string) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Buckets for the trend chart: a bar per day for short ranges, per month for longer ones. */
function buckets(r: Range): { granularity: 'day' | 'month'; keys: string[]; label(key: string): string } {
  if (diffDays(r.from, r.to) <= 45) {
    const keys: string[] = [];
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) keys.push(d);
    return { granularity: 'day', keys, label: dayLabel };
  }
  const keys: string[] = [];
  for (let k = monthKey(r.from); k <= monthKey(r.to); ) {
    keys.push(k);
    const [y, m] = k.split('-').map(Number) as [number, number];
    k = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return { granularity: 'month', keys, label: monthLabel };
}

export function dashboard(db: DB, range: Range, date = today()) {
  const { from, to } = range;

  /* subscriptions */
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const r of all<{ status: (typeof STATUSES)[number]; n: number }>(db, 'SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status')) byStatus[r.status] = r.n;
  const activated = get<{ n: number }>(db, `SELECT COUNT(DISTINCT subscription_id) AS n FROM subscription_events WHERE action = 'activate' AND at >= ? AND at < ?`, from, addDays(to, 1))!.n;
  const closed = get<{ n: number }>(db, `SELECT COUNT(DISTINCT subscription_id) AS n FROM subscription_events WHERE action IN ('close', 'auto_close') AND at >= ? AND at < ?`, from, addDays(to, 1))!.n;

  /* recurring revenue: what active subscriptions bill each period, turned into a monthly figure */
  const perPeriod = all<{ period: string; gross: number; n: number }>(
    db,
    `SELECT p.billing_period AS period, SUM(l.quantity * l.unit_price_minor) AS gross, COUNT(DISTINCT s.id) AS n
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN subscription_lines l ON l.subscription_id = s.id
      WHERE s.status = 'active' GROUP BY p.billing_period`,
  );
  const mrrMinor = Math.round(perPeriod.reduce((sum, r) => sum + r.gross * (PERIODS_PER_MONTH[r.period] ?? 0), 0));

  /* money in the range */
  const collected = get<{ n: number; amount: number | null }>(db, `SELECT COUNT(*) AS n, SUM(amount_minor) AS amount FROM payments WHERE status = 'recorded' AND paid_on BETWEEN ? AND ?`, from, to)!;
  const invoiced = get<{ n: number; amount: number | null }>(db, `SELECT COUNT(*) AS n, SUM(total_minor) AS amount FROM invoices WHERE status IN ('confirmed', 'paid') AND issue_date BETWEEN ? AND ?`, from, to)!;

  /* what is owed right now (not range-dependent) */
  const owed = receivablesSummary(db, date);
  const dueSoon = get<{ n: number; amount: number | null }>(db, `SELECT COUNT(*) AS n, SUM(total_minor - paid_minor) AS amount FROM invoices WHERE status = 'confirmed' AND total_minor > paid_minor AND due_date BETWEEN ? AND ?`, date, addDays(date, 7))!;

  /* things that need someone to act */
  const one = (sql: string, ...args: (string | number)[]) => get<{ n: number }>(db, sql, ...args)!.n;
  const attention = {
    billingDue: one(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND next_billing_date IS NOT NULL AND next_billing_date <= ? AND next_billing_date < expiry_date`, date),
    billingFailures: one('SELECT COUNT(*) AS n FROM billing_failures WHERE resolved_at IS NULL'),
    draftInvoices: one(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'draft'`),
    expiringSoon: one(`SELECT COUNT(*) AS n FROM subscriptions WHERE status IN ('active', 'paused') AND expiry_date BETWEEN ? AND ?`, date, addDays(date, 30)),
    expiredQuotes: one(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'quotation' AND quote_valid_until < ?`, date),
  };

  /* trend */
  const b = buckets(range);
  const bucketOf = (col: string) => (b.granularity === 'day' ? col : `substr(${col}, 1, 7)`);
  const sums = (table: string, col: string, amount: string, where: string) =>
    new Map(all<{ k: string; amount: number }>(db, `SELECT ${bucketOf(col)} AS k, SUM(${amount}) AS amount FROM ${table} WHERE ${where} AND ${col} BETWEEN ? AND ? GROUP BY k`, from, to).map((r) => [r.k, r.amount]));
  const invoicedBy = sums('invoices', 'issue_date', 'total_minor', `status IN ('confirmed', 'paid')`);
  const collectedBy = sums('payments', 'paid_on', 'amount_minor', `status = 'recorded'`);
  const trend = b.keys.map((k) => ({ key: k, label: b.label(k), invoiced: fromMinor(invoicedBy.get(k) ?? 0), collected: fromMinor(collectedBy.get(k) ?? 0) }));

  return {
    range,
    asOf: date,
    subscriptions: { active: byStatus.active, paused: byStatus.paused, total: Object.values(byStatus).reduce((a, c) => a + c, 0), byStatus, activatedInRange: activated, closedInRange: closed },
    recurring: {
      mrr: fromMinor(mrrMinor),
      arr: fromMinor(mrrMinor * 12),
      activeSubscriptions: perPeriod.reduce((n, r) => n + r.n, 0),
      note: 'Active subscriptions at list price, before discounts and tax, shown per month.',
    },
    revenue: {
      collected: fromMinor(collected.amount ?? 0),
      collectedCount: collected.n,
      invoiced: fromMinor(invoiced.amount ?? 0),
      invoicedCount: invoiced.n,
    },
    receivables: {
      outstanding: owed.outstanding,
      overdue: owed.overdue,
      dueSoon: { count: dueSoon.n, amount: fromMinor(dueSoon.amount ?? 0) },
      buckets: owed.buckets,
    },
    attention,
    trend: { granularity: b.granularity, points: trend },
  };
}

/** A customer's own picture: their subscriptions, what they owe, what they have paid. Everything is scoped by customer ids from the session. */
export function portalSummary(db: DB, customerIds: number[], date = today()) {
  if (customerIds.length === 0) return null;
  const marks = customerIds.map(() => '?').join(',');
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const r of all<{ status: (typeof STATUSES)[number]; n: number }>(db, `SELECT status, COUNT(*) AS n FROM subscriptions WHERE customer_id IN (${marks}) GROUP BY status`, ...customerIds)) byStatus[r.status] = r.n;

  const subs = all<{ id: number; number: string; status: string; plan: string; period: string; next_billing_date: string | null; expiry_date: string; per_period: number | null }>(
    db,
    `SELECT s.id, s.number, s.status, p.name AS plan, p.billing_period AS period, s.next_billing_date, s.expiry_date,
            (SELECT SUM(l.quantity * l.unit_price_minor + (l.quantity * l.unit_price_minor * l.tax_rate_bp + 5000) / 10000) FROM subscription_lines l WHERE l.subscription_id = s.id) AS per_period
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.customer_id IN (${marks}) AND s.status IN ('active', 'paused', 'quotation') ORDER BY s.status, s.id LIMIT 6`,
    ...customerIds,
  );

  // Customers only ever see issued invoices, never drafts or cancelled ones.
  const issued = `customer_id IN (${marks}) AND status IN ('confirmed', 'paid')`;
  const owed = get<{ n: number; amount: number | null }>(db, `SELECT COUNT(*) AS n, SUM(total_minor - paid_minor) AS amount FROM invoices WHERE customer_id IN (${marks}) AND status = 'confirmed' AND total_minor > paid_minor`, ...customerIds)!;
  const overdue = get<{ n: number; amount: number | null }>(db, `SELECT COUNT(*) AS n, SUM(total_minor - paid_minor) AS amount FROM invoices WHERE customer_id IN (${marks}) AND status = 'confirmed' AND total_minor > paid_minor AND due_date < ?`, ...customerIds, date)!;
  const next = get<{ id: number; number: string; due_date: string; balance: number }>(
    db,
    `SELECT id, number, due_date, total_minor - paid_minor AS balance FROM invoices WHERE customer_id IN (${marks}) AND status = 'confirmed' AND total_minor > paid_minor ORDER BY due_date, id LIMIT 1`,
    ...customerIds,
  );
  const recentInvoices = all<{ id: number; number: string; status: string; issue_date: string; due_date: string; total_minor: number; paid_minor: number }>(
    db,
    `SELECT id, number, status, issue_date, due_date, total_minor, paid_minor FROM invoices WHERE ${issued} ORDER BY id DESC LIMIT 5`,
    ...customerIds,
  );
  const paidTotal = get<{ n: number; amount: number | null }>(db, `SELECT COUNT(*) AS n, SUM(amount_minor) AS amount FROM payments WHERE customer_id IN (${marks}) AND status = 'recorded'`, ...customerIds)!;
  const recentPayments = all<{ id: number; invoice_id: number; number: string; amount_minor: number; method: string; paid_on: string }>(
    db,
    `SELECT p.id, p.invoice_id, i.number, p.amount_minor, p.method, p.paid_on FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.customer_id IN (${marks}) AND p.status = 'recorded' ORDER BY p.paid_on DESC, p.id DESC LIMIT 5`,
    ...customerIds,
  );

  return {
    subscriptions: {
      byStatus,
      active: byStatus.active,
      items: subs.map((s) => ({ id: s.id, number: s.number, status: s.status, plan: s.plan, billingPeriod: s.period, nextBillingDate: s.status === 'active' ? s.next_billing_date : null, expiryDate: s.expiry_date, perPeriod: fromMinor(s.per_period ?? 0) })),
    },
    invoices: {
      outstanding: { count: owed.n, amount: fromMinor(owed.amount ?? 0) },
      overdue: { count: overdue.n, amount: fromMinor(overdue.amount ?? 0) },
      next: next ? { id: next.id, number: next.number, dueDate: next.due_date, balance: fromMinor(next.balance), isOverdue: next.due_date < date } : null,
      recent: recentInvoices.map((i) => ({ id: i.id, number: i.number, status: i.status, issueDate: i.issue_date, dueDate: i.due_date, total: fromMinor(i.total_minor), balance: fromMinor(i.total_minor - i.paid_minor) })),
    },
    payments: {
      totalPaid: fromMinor(paidTotal.amount ?? 0),
      count: paidTotal.n,
      recent: recentPayments.map((p) => ({ id: p.id, invoiceId: p.invoice_id, invoiceNumber: p.number, amount: fromMinor(p.amount_minor), method: p.method, paidOn: p.paid_on })),
    },
  };
}
