import { type DB, all, get, run, transaction } from '../db.js';
import { loadDiscountStates } from './catalog.js';
import { type BillingPeriod, addDays } from './dates.js';
import { HttpError } from './http.js';
import { confirmInvoice, logInvoiceEvent } from './invoices.js';
import { fromMinor, today } from './money.js';
import { type LineInput, chooseBestDiscount, priceLines } from './pricing.js';
import { countDue, periodEnd, periodStart } from './schedule.js';
import { type SubRow, getPlan, loadLines, logEvent, nextNumber, sweepExpired, toLineInputs } from './subscriptions.js';

/**
 * Recurring billing. For every active subscription with a billing period that has started and not yet been
 * invoiced, create an invoice from the subscription: customer details, lines, the best qualifying discount,
 * tax and totals, all filled in from saved data.
 *
 * The guarantees, and what enforces them:
 *  - Never twice: invoices are UNIQUE per (subscription, period) in the database, and each invoice is created
 *    in the same transaction that moves the subscription on to its next period.
 *  - Never skipped: every due subscription is attempted. One that cannot be billed is recorded as a failure,
 *    stays visible, and is attempted again by the next run or by a retry. Later periods are never billed ahead
 *    of an earlier failed one.
 *  - Re-running is safe: with nothing new due, a run creates nothing.
 */

export class BillingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RunOptions {
  /** Bill every period that started on or before this date. Defaults to today; never in the future. */
  asOf?: string;
  /** Confirm each invoice as it is created instead of leaving it as a draft for review. */
  confirm?: boolean;
  /** Limit the run to one subscription (used to retry a failure). */
  subscriptionId?: number;
  triggeredBy: number | null;
  isDemo?: boolean;
  /** Test seam: called inside the transaction just before the invoice is written, so a test can make billing fail. */
  beforeInvoice?: (sub: SubRow, periodIndex: number) => void;
}

export interface CreatedInvoice {
  id: number;
  number: string;
  subscriptionId: number;
  subscriptionNumber: string;
  periodIndex: number;
  total: number;
}

export interface BillingFailure {
  subscriptionId: number;
  subscriptionNumber: string;
  periodIndex: number;
  message: string;
}

export interface RunResult {
  runId: number;
  asOf: string;
  /** Subscriptions that had something due when the run started. */
  due: number;
  created: CreatedInvoice[];
  failed: BillingFailure[];
}

interface DueRow {
  id: number;
  number: string;
  start_date: string;
  expiry_date: string;
  next_period: number;
  period: BillingPeriod;
}

const MAX_PERIODS_PER_SUBSCRIPTION = 240;
const YIELD_EVERY = 25;

const DUE_SQL = `
  SELECT s.id, s.number, s.start_date, s.expiry_date, s.next_period, p.billing_period AS period
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
   WHERE s.status = 'active' AND s.next_billing_date IS NOT NULL
     AND s.next_billing_date <= ? AND s.next_billing_date < s.expiry_date`;

export function selectDue(db: DB, asOf: string, subscriptionId?: number): DueRow[] {
  return subscriptionId
    ? all<DueRow>(db, `${DUE_SQL} AND s.id = ? ORDER BY s.next_billing_date, s.id`, asOf, subscriptionId)
    : all<DueRow>(db, `${DUE_SQL} ORDER BY s.next_billing_date, s.id`, asOf);
}

export const duePeriodsOf = (r: DueRow, asOf: string) => countDue({ startDate: r.start_date, expiryDate: r.expiry_date, period: r.period }, r.next_period, asOf);

export function assertNotFuture(asOf: string): void {
  if (asOf > today()) throw new HttpError(422, 'validation_failed', 'Please correct the highlighted fields.', { asOf: 'Billing cannot run for a date in the future' });
}

/* ---------- one invoice ---------- */

interface Billed {
  created?: CreatedInvoice;
}

/**
 * Bills the subscription's next period if it is due. Returns null when nothing is due. The whole step is one
 * transaction: the invoice, its lines, the discount's usage count and the subscription's move to the next
 * period all happen together or not at all.
 */
function billNext(db: DB, subId: number, asOf: string, opts: RunOptions, runId: number): Billed | null {
  return transaction(db, (): Billed | null => {
    // Re-read inside the transaction: another run may have billed this period since the due list was made.
    const sub = get<SubRow>(db, 'SELECT * FROM subscriptions WHERE id = ?', subId);
    if (!sub || sub.status !== 'active') return null;
    const plan = getPlan(db, sub.plan_id)!;
    const schedule = { startDate: sub.start_date, expiryDate: sub.expiry_date, period: plan.billing_period };
    const k = sub.next_period;
    const start = periodStart(schedule, k);
    if (start > asOf || start >= sub.expiry_date) return null;
    const nextStart = periodStart(schedule, k + 1);

    const advance = () => {
      run(db, `UPDATE subscriptions SET next_period = ?, next_billing_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, k + 1, nextStart, subId);
    };

    // If this period already has an invoice (the schedule was out of step), move on without making another.
    if (get(db, 'SELECT 1 AS x FROM invoices WHERE subscription_id = ? AND period_index = ?', subId, k)) {
      advance();
      return {};
    }

    const lines = loadLines(db, [subId]).get(subId) ?? [];
    if (lines.length === 0) {
      throw new BillingError('nothing_to_bill', `${sub.number} has no lines, so there is nothing to invoice. Add lines or close the subscription, then retry.`);
    }
    const customer = get<{ name: string; company: string | null; email: string; address: string | null }>(db, 'SELECT name, company, email, address FROM customers WHERE id = ?', sub.customer_id);
    if (!customer) throw new BillingError('customer_missing', `The customer for ${sub.number} could not be found.`);
    const terms = sub.payment_terms_id ? get<{ name: string; days_due: number }>(db, 'SELECT name, days_due FROM payment_terms WHERE id = ?', sub.payment_terms_id) : undefined;

    // Pick the discount that saves the most and claim one use of it. If it ran out a moment ago, try the next.
    const inputs: LineInput[] = toLineInputs(lines);
    const states = loadDiscountStates(db);
    const skipped = new Set<number>();
    let applied: { id: number; name: string } | null = null;
    let priced = priceLines(inputs);
    for (;;) {
      const best = chooseBestDiscount(states.filter((s) => !skipped.has(s.id)), inputs, asOf);
      if (!best) break;
      const claimed = run(db, 'UPDATE discounts SET usage_count = usage_count + 1 WHERE id = ? AND (usage_limit IS NULL OR usage_count < usage_limit)', best.rule.id).changes === 1;
      if (claimed) {
        priced = priceLines(inputs, best.evaluation);
        applied = { id: best.rule.id, name: best.rule.name };
        break;
      }
      skipped.add(best.rule.id);
    }

    // Test seam, after the discount has been claimed: a failure here must undo everything above it.
    opts.beforeInvoice?.(sub, k);

    const issueDate = asOf;
    const dueDate = addDays(issueDate, terms?.days_due ?? 0);
    const number = nextNumber(db, 'invoice', 'INV');
    const pEnd = periodEnd(schedule, k);
    const invoiceId = run(
      db,
      `INSERT INTO invoices (number, subscription_id, customer_id, period_index, period_start, period_end, issue_date, due_date, status,
                             customer_name, customer_company, customer_email, customer_address, subscription_number, plan_name, payment_terms_name,
                             discount_id, discount_name, subtotal_minor, discount_minor, tax_minor, total_minor, created_by, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      number,
      subId,
      sub.customer_id,
      k,
      start,
      pEnd,
      issueDate,
      dueDate,
      customer.name,
      customer.company,
      customer.email,
      customer.address,
      sub.number,
      plan.name,
      terms?.name ?? null,
      applied?.id ?? null,
      applied?.name ?? null,
      priced.subtotalMinor,
      priced.discountMinor,
      priced.taxMinor,
      priced.totalMinor,
      opts.triggeredBy,
      opts.isDemo ? 1 : 0,
    ).lastInsertRowid;

    priced.lines.forEach((l, i) => {
      const src = lines[i]!;
      run(
        db,
        `INSERT INTO invoice_lines (invoice_id, position, kind, description, product_id, quantity, unit_price_minor, tax_name, tax_rate_bp,
                                    subtotal_minor, discount_minor, tax_minor, total_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        invoiceId,
        i,
        src.kind,
        src.description,
        src.product_id,
        src.quantity,
        src.unit_price_minor,
        src.tax_name,
        src.tax_rate_bp,
        l.subtotalMinor,
        l.discountMinor,
        l.taxMinor,
        l.totalMinor,
      );
    });

    advance();
    logInvoiceEvent(db, invoiceId, 'create', null, 'draft', opts.triggeredBy, `Created by billing run #${runId} for ${start} to ${pEnd}`);
    logEvent(db, subId, 'invoice', 'active', 'active', opts.triggeredBy, `Invoice ${number} created for ${start} to ${pEnd}`);
    run(db, 'UPDATE billing_failures SET resolved_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE subscription_id = ? AND period_index = ? AND resolved_at IS NULL', subId, k);
    if (opts.confirm) confirmInvoice(db, invoiceId, opts.triggeredBy);

    return { created: { id: invoiceId, number, subscriptionId: subId, subscriptionNumber: sub.number, periodIndex: k, total: fromMinor(priced.totalMinor) } };
  });
}

function recordFailure(db: DB, subId: number, periodIndex: number, message: string, runId: number) {
  run(
    db,
    `INSERT INTO billing_failures (subscription_id, period_index, message, last_run_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (subscription_id, period_index) DO UPDATE SET
       message = excluded.message, attempts = attempts + 1, last_run_id = excluded.last_run_id,
       last_failed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), resolved_at = NULL`,
    subId,
    periodIndex,
    message.slice(0, 400),
    runId,
  );
}

/* ---------- a run ---------- */

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Bills everything due. Subscriptions are handled one at a time, each in its own transactions, so a problem
 * with one never blocks or rolls back the others. The loop yields now and then so the server keeps answering
 * other requests during a large run.
 */
export async function runBilling(db: DB, opts: RunOptions): Promise<RunResult> {
  const asOf = opts.asOf ?? today();
  assertNotFuture(asOf);
  const due = selectDue(db, asOf, opts.subscriptionId);
  const runId = run(db, 'INSERT INTO billing_runs (as_of, auto_confirm, triggered_by, due_count) VALUES (?, ?, ?, ?)', asOf, opts.confirm ? 1 : 0, opts.triggeredBy, due.length).lastInsertRowid;

  const created: CreatedInvoice[] = [];
  const failed: BillingFailure[] = [];
  try {
    let handled = 0;
    for (const row of due) {
      try {
        for (let n = 0; n < MAX_PERIODS_PER_SUBSCRIPTION; n++) {
          const billed = billNext(db, row.id, asOf, opts, runId);
          if (!billed) break;
          if (billed.created) created.push(billed.created);
        }
      } catch (err) {
        const message = err instanceof BillingError ? err.message : `Unexpected error while billing ${row.number}: ${err instanceof Error ? err.message : String(err)}`;
        if (!(err instanceof BillingError)) console.error(`[billing] unexpected failure for ${row.number}`, err);
        // The transaction rolled back, so next_period still points at the period that failed.
        const periodIndex = get<{ next_period: number }>(db, 'SELECT next_period FROM subscriptions WHERE id = ?', row.id)?.next_period ?? row.next_period;
        recordFailure(db, row.id, periodIndex, message, runId);
        failed.push({ subscriptionId: row.id, subscriptionNumber: row.number, periodIndex, message });
      }
      if (++handled % YIELD_EVERY === 0) await nextTick();
    }
  } finally {
    run(db, `UPDATE billing_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), created_count = ?, failed_count = ? WHERE id = ?`, created.length, failed.length, runId);
  }
  // Subscriptions whose plan ends may now close, since their last invoices have been issued.
  sweepExpired(db, asOf);
  return { runId, asOf, due: due.length, created, failed };
}

/**
 * Tries again for one failed period. If the subscription is no longer billable at all (closed, say), the
 * failure is closed with a note saying so, rather than being left open for ever.
 */
export async function retryFailure(db: DB, failureId: number, opts: RunOptions): Promise<RunResult & { failureResolved: boolean }> {
  const failure = get<{ id: number; subscription_id: number; resolved_at: string | null }>(db, 'SELECT id, subscription_id, resolved_at FROM billing_failures WHERE id = ?', failureId);
  if (!failure) throw new HttpError(404, 'not_found', 'Failure was not found.');
  if (failure.resolved_at) throw new HttpError(409, 'already_resolved', 'This failure has already been resolved.');

  const result = await runBilling(db, { ...opts, subscriptionId: failure.subscription_id });
  let resolved = get<{ resolved_at: string | null }>(db, 'SELECT resolved_at FROM billing_failures WHERE id = ?', failureId)!.resolved_at !== null;
  if (!resolved && result.due === 0) {
    const status = get<{ status: string }>(db, 'SELECT status FROM subscriptions WHERE id = ?', failure.subscription_id)?.status;
    run(
      db,
      `UPDATE billing_failures SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), message = ? WHERE id = ?`,
      `No longer billable: the subscription is ${status ?? 'gone'}, so nothing is due. Closed by a retry.`,
      failureId,
    );
    resolved = true;
  }
  return { ...result, failureResolved: resolved };
}
