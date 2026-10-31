import { type DB, all, get, run, transaction } from '../db.js';
import {
  type BuiltLine,
  type LineRequest,
  type PlanRow,
  buildLines,
  isPlanAvailable,
  loadDiscountStates,
} from './catalog.js';
import { addDays, diffDays, suggestExpiry } from './dates.js';
import { HttpError, invalidField } from './http.js';
import { type Action, type Actor, type Status, availableActions, checkTransition } from './lifecycle.js';
import { bpToPercent, fromMinor, today } from './money.js';
import { type LineInput, chooseBestDiscount, priceLines } from './pricing.js';
import { countDue, periodStart } from './schedule.js';

/**
 * Subscription business rules in one place. The routes validate input and permissions, then call
 * these functions; the demo seed calls them too, so seeded data can never be something the API
 * could not have produced.
 */

export interface SubRow {
  id: number;
  number: string;
  customer_id: number;
  plan_id: number;
  template_id: number | null;
  payment_terms_id: number | null;
  status: Status;
  start_date: string;
  expiry_date: string;
  quote_valid_until: string | null;
  next_billing_date: string | null;
  next_period: number;
  paused_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  notes: string | null;
  created_by: number | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface SubLineRow {
  id: number;
  subscription_id: number;
  position: number;
  kind: 'plan' | 'product';
  description: string;
  product_id: number | null;
  variant_id: number | null;
  quantity: number;
  unit_price_minor: number;
  tax_id: number | null;
  tax_rate_bp: number;
  tax_name: string | null;
}

const DEFAULT_QUOTE_VALIDITY_DAYS = 30;

/* ---------- small helpers ---------- */

export function nextNumber(db: DB, sequence: string, prefix: string): string {
  const row = get<{ last_value: number }>(
    db,
    `INSERT INTO sequences (name, last_value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET last_value = last_value + 1
     RETURNING last_value`,
    sequence,
  )!;
  return `${prefix}-${String(row.last_value).padStart(5, '0')}`;
}

export function logEvent(db: DB, subId: number, action: string, from: Status | null, to: Status, actorId: number | null, note?: string | null) {
  run(
    db,
    'INSERT INTO subscription_events (subscription_id, action, from_status, to_status, actor_id, note) VALUES (?, ?, ?, ?, ?, ?)',
    subId,
    action,
    from,
    to,
    actorId,
    note || null,
  );
}

function insertLines(db: DB, subId: number, built: BuiltLine[]) {
  built.forEach((l, i) => {
    run(
      db,
      `INSERT INTO subscription_lines (subscription_id, position, kind, description, product_id, variant_id, quantity, unit_price_minor, tax_id, tax_rate_bp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      subId,
      i,
      l.kind,
      l.description,
      l.productId,
      l.variantId,
      l.quantity,
      l.unitPriceMinor,
      l.taxId,
      l.taxRateBp,
    );
  });
}

export function getPlan(db: DB, id: number): PlanRow | undefined {
  return get<PlanRow>(db, 'SELECT * FROM plans WHERE id = ?', id);
}

function assertPlanSellable(plan: PlanRow, start: string) {
  if (!plan.is_active) invalidField('planId', `${plan.name} is no longer sold`);
  if (!isPlanAvailable(plan, start)) {
    invalidField('planId', `${plan.name} is not available on ${start} (on sale ${plan.available_from}${plan.available_to ? ` to ${plan.available_to}` : ' onwards'})`);
  }
}

function assertDates(start: string, expiry: string) {
  if (expiry <= start) invalidField('expiryDate', 'Must be after the start date');
  if (expiry < today()) invalidField('expiryDate', 'Is already in the past');
}

function resolveTerms(db: DB, explicit: number | null | undefined, fallback: number | null): number | null {
  if (explicit != null) {
    if (!get(db, 'SELECT 1 AS x FROM payment_terms WHERE id = ? AND is_active = 1', explicit)) invalidField('paymentTermsId', 'Choose existing, active payment terms');
    return explicit;
  }
  if (fallback != null) return fallback;
  return get<{ id: number }>(db, 'SELECT id FROM payment_terms WHERE is_default = 1 AND is_active = 1')?.id ?? null;
}

interface TemplateRow {
  id: number;
  plan_id: number;
  validity_days: number;
  payment_terms_id: number | null;
  is_active: number;
}

function templateLines(db: DB, templateId: number): LineRequest[] {
  return all<{ product_id: number; variant_id: number | null; quantity: number }>(
    db,
    'SELECT product_id, variant_id, quantity FROM quotation_template_lines WHERE template_id = ? ORDER BY position',
    templateId,
  ).map((l) => ({ productId: l.product_id, variantId: l.variant_id, quantity: l.quantity }));
}

/* ---------- create and edit ---------- */

export interface CreateInput {
  customerId: number;
  templateId?: number | null;
  planId?: number | null;
  startDate?: string;
  expiryDate?: string;
  paymentTermsId?: number | null;
  notes?: string | null;
  lines?: LineRequest[];
  createdBy: number | null;
  isDemo?: boolean;
}

/** Creates a draft. A quotation template supplies the plan, lines and payment terms unless overridden. */
export function createSubscription(db: DB, input: CreateInput): number {
  if (!get(db, 'SELECT 1 AS x FROM customers WHERE id = ?', input.customerId)) invalidField('customerId', 'Choose an existing customer');

  let template: TemplateRow | undefined;
  if (input.templateId != null) {
    template = get<TemplateRow>(db, 'SELECT id, plan_id, validity_days, payment_terms_id, is_active FROM quotation_templates WHERE id = ?', input.templateId);
    if (!template || !template.is_active) invalidField('templateId', 'Choose an existing, active template');
  }

  const planId = input.planId ?? template?.plan_id;
  if (!planId) invalidField('planId', 'Choose a plan');
  const plan = getPlan(db, planId!);
  if (!plan) invalidField('planId', 'Choose an existing plan');

  const start = input.startDate ?? today();
  assertPlanSellable(plan!, start);
  const expiry = input.expiryDate ?? suggestExpiry(start, plan!.billing_period);
  assertDates(start, expiry);

  const terms = resolveTerms(db, input.paymentTermsId, template?.payment_terms_id ?? null);
  const requests = input.lines ?? (template ? templateLines(db, template.id) : []);
  const built = buildLines(db, plan!, requests);

  return transaction(db, () => {
    const number = nextNumber(db, 'subscription', 'SUB');
    const id = run(
      db,
      `INSERT INTO subscriptions (number, customer_id, plan_id, template_id, payment_terms_id, status, start_date, expiry_date, notes, created_by, is_demo)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      number,
      input.customerId,
      plan!.id,
      template?.id ?? null,
      terms,
      start,
      expiry,
      input.notes || null,
      input.createdBy,
      input.isDemo ? 1 : 0,
    ).lastInsertRowid;
    insertLines(db, id, built);
    logEvent(db, id, 'create', null, 'draft', input.createdBy, template ? 'Created from a quotation template' : null);
    return id;
  });
}

export interface UpdateInput {
  customerId?: number;
  planId?: number;
  startDate?: string;
  expiryDate?: string;
  paymentTermsId?: number | null;
  notes?: string | null;
  lines?: LineRequest[];
}

export function getSubscription(db: DB, id: number): SubRow | undefined {
  return get<SubRow>(db, 'SELECT * FROM subscriptions WHERE id = ?', id);
}

/** Only drafts can be edited; sending a quotation freezes the commercial terms. */
export function updateDraft(db: DB, id: number, patch: UpdateInput): void {
  const current = getSubscription(db, id);
  if (!current) throw new HttpError(404, 'not_found', 'Subscription was not found.');
  if (current.status !== 'draft') {
    throw new HttpError(409, 'not_editable', 'Only a draft can be edited. Move a quotation back to draft first.');
  }

  if (patch.customerId !== undefined && !get(db, 'SELECT 1 AS x FROM customers WHERE id = ?', patch.customerId)) {
    invalidField('customerId', 'Choose an existing customer');
  }
  const planId = patch.planId ?? current.plan_id;
  const plan = getPlan(db, planId);
  if (!plan) invalidField('planId', 'Choose an existing plan');
  const start = patch.startDate ?? current.start_date;
  const expiry = patch.expiryDate ?? current.expiry_date;
  assertPlanSellable(plan!, start);
  assertDates(start, expiry);

  const terms = patch.paymentTermsId === undefined ? current.payment_terms_id : resolveTerms(db, patch.paymentTermsId, null);

  // Changing the plan or the lines re-prices everything from today's catalog; other edits keep the saved prices.
  let built: BuiltLine[] | null = null;
  if (patch.lines !== undefined || patch.planId !== undefined) {
    const requests =
      patch.lines ??
      all<{ product_id: number; variant_id: number | null; quantity: number }>(
        db,
        `SELECT product_id, variant_id, quantity FROM subscription_lines WHERE subscription_id = ? AND kind = 'product' ORDER BY position`,
        id,
      ).map((l) => ({ productId: l.product_id, variantId: l.variant_id, quantity: l.quantity }));
    built = buildLines(db, plan!, requests);
  }

  transaction(db, () => {
    run(
      db,
      `UPDATE subscriptions SET customer_id = ?, plan_id = ?, start_date = ?, expiry_date = ?, payment_terms_id = ?, notes = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      patch.customerId ?? current.customer_id,
      plan!.id,
      start,
      expiry,
      terms,
      patch.notes === undefined ? current.notes : patch.notes || null,
      id,
    );
    if (built) {
      run(db, 'DELETE FROM subscription_lines WHERE subscription_id = ?', id);
      insertLines(db, id, built);
    }
  });
}

/* ---------- lifecycle ---------- */

export interface ActorInfo {
  kind: Actor;
  userId: number | null;
}

/** Pausing or closing would leave an invoice that is already due unissued, so it is refused until billing has run. */
function refuseWhileInvoicesDue(sub: SubRow, schedule: { startDate: string; expiryDate: string; period: PlanRow['billing_period'] }, upTo: string, verb: string) {
  const due = countDue(schedule, sub.next_period, upTo);
  if (due > 0) {
    throw new HttpError(409, 'billing_due', `${due} invoice${due === 1 ? ' is' : 's are'} due for ${sub.number}. Run billing first, then it can be ${verb}.`);
  }
}

export function applyAction(db: DB, id: number, action: Action, actor: ActorInfo, note?: string | null): SubRow {
  return transaction(db, () => {
    const sub = getSubscription(db, id);
    if (!sub) throw new HttpError(404, 'not_found', 'Subscription was not found.');
    const plan = getPlan(db, sub.plan_id)!;
    const to = checkTransition(
      action,
      sub.status,
      { allowPause: plan.allow_pause === 1, allowEarlyClose: plan.allow_early_close === 1, allowRenewal: plan.allow_renewal === 1 },
      actor.kind,
    );

    const date = today();
    let eventNote = note ?? null;
    const set: Record<string, string | number | null> = { status: to };
    const schedule = { startDate: sub.start_date, expiryDate: sub.expiry_date, period: plan.billing_period };

    switch (action) {
      case 'send_quote': {
        const lineCount = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM subscription_lines WHERE subscription_id = ?', id)!.n;
        if (lineCount === 0) throw new HttpError(409, 'no_lines', 'Add at least one line before sending the quotation.');
        const days = sub.template_id
          ? (get<{ validity_days: number }>(db, 'SELECT validity_days FROM quotation_templates WHERE id = ?', sub.template_id)?.validity_days ?? DEFAULT_QUOTE_VALIDITY_DAYS)
          : DEFAULT_QUOTE_VALIDITY_DAYS;
        set.quote_valid_until = addDays(date, days);
        break;
      }
      case 'revert_to_draft':
        set.quote_valid_until = null;
        break;
      case 'confirm':
        if (sub.quote_valid_until && sub.quote_valid_until < date) {
          throw new HttpError(409, 'quote_expired', `This quotation expired on ${sub.quote_valid_until}. Move it back to draft and send a new one.`);
        }
        break;
      case 'activate':
        if (sub.expiry_date < date) throw new HttpError(409, 'already_expired', `The expiry date (${sub.expiry_date}) has passed, so this cannot be activated.`);
        set.next_period = 0;
        set.next_billing_date = sub.start_date;
        break;
      case 'pause':
        // Invoices that are already due belong to the time before the pause, so they are issued first.
        refuseWhileInvoicesDue(sub, schedule, date, 'paused');
        set.paused_at = date;
        break;
      case 'resume': {
        // Billing restarts at the next period start. Periods that began while it was paused are skipped on
        // purpose, and the history says how many, so nothing disappears silently.
        let k = sub.next_period;
        let skipped = 0;
        while (sub.paused_at && periodStart(schedule, k) > sub.paused_at && periodStart(schedule, k) < date && skipped < 1000) {
          k += 1;
          skipped += 1;
        }
        set.next_period = k;
        set.next_billing_date = periodStart(schedule, k);
        set.paused_at = null;
        if (skipped > 0) eventNote = `Billing resumes on ${set.next_billing_date}; ${skipped} billing period${skipped === 1 ? '' : 's'} that began while paused ${skipped === 1 ? 'was' : 'were'} not billed${note ? `. ${note}` : ''}`;
        break;
      }
      case 'close':
        refuseWhileInvoicesDue(sub, schedule, sub.status === 'paused' ? (sub.paused_at ?? date) : date, 'closed');
        set.closed_at = new Date().toISOString();
        set.close_reason = 'closed_early';
        break;
      case 'cancel':
        set.closed_at = new Date().toISOString();
        set.close_reason = 'cancelled';
        break;
      case 'renew': {
        // Another term of the same length, counted from the current expiry.
        const term = diffDays(sub.start_date, sub.expiry_date);
        const newExpiry = addDays(sub.expiry_date, term);
        set.expiry_date = newExpiry;
        eventNote = `Expiry extended from ${sub.expiry_date} to ${newExpiry}${note ? `. ${note}` : ''}`;
        break;
      }
    }

    const columns = Object.keys(set);
    run(
      db,
      `UPDATE subscriptions SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      ...columns.map((c) => set[c] as string | number | null),
      id,
    );
    logEvent(db, id, action, sub.status, to, actor.userId, eventNote);
    return getSubscription(db, id)!;
  });
}

/**
 * Closes active or paused subscriptions whose plan closes on its own and whose expiry date has
 * passed. An active subscription with periods still to invoice waits until billing has issued them, so
 * closing never drops revenue. Cheap and idempotent, so it runs on a timer and before reads that must be current.
 */
export function sweepExpired(db: DB, date = today()): number {
  const due = all<{ id: number; status: Status; expiry_date: string }>(
    db,
    `SELECT s.id, s.status, s.expiry_date FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active', 'paused') AND s.expiry_date < ? AND p.auto_close = 1
        AND (s.status = 'paused' OR s.next_billing_date IS NULL OR s.next_billing_date >= s.expiry_date)`,
    date,
  );
  if (due.length === 0) return 0;
  transaction(db, () => {
    for (const s of due) {
      run(
        db,
        `UPDATE subscriptions SET status = 'closed', closed_at = ?, close_reason = 'expired', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        new Date().toISOString(),
        s.id,
      );
      logEvent(db, s.id, 'auto_close', s.status, 'closed', null, `Closed automatically: the plan ends and the expiry date (${s.expiry_date}) has passed`);
    }
  });
  return due.length;
}

/* ---------- reading ---------- */

export function ownedCustomerIds(db: DB, userId: number): number[] {
  return all<{ id: number }>(db, 'SELECT id FROM customers WHERE user_id = ?', userId).map((c) => c.id);
}

export function loadLines(db: DB, subIds: number[]): Map<number, SubLineRow[]> {
  const bySub = new Map<number, SubLineRow[]>();
  if (subIds.length === 0) return bySub;
  const rows = all<SubLineRow>(
    db,
    `SELECT l.*, t.name AS tax_name FROM subscription_lines l LEFT JOIN taxes t ON t.id = l.tax_id
      WHERE l.subscription_id IN (${subIds.map(() => '?').join(',')}) ORDER BY l.subscription_id, l.position`,
    ...subIds,
  );
  for (const r of rows) {
    const list = bySub.get(r.subscription_id) ?? [];
    list.push(r);
    bySub.set(r.subscription_id, list);
  }
  return bySub;
}

export const toLineInputs = (lines: SubLineRow[]): LineInput[] =>
  lines.map((l) => ({ key: l.id, productId: l.product_id, quantity: l.quantity, unitPriceMinor: l.unit_price_minor, taxRateBp: l.tax_rate_bp }));

export interface SummaryJoin extends SubRow {
  customer_name: string;
  customer_company: string | null;
  plan_name: string;
  plan_period: string;
}

export function presentSummary(row: SummaryJoin, lines: SubLineRow[], date: string) {
  const gross = priceLines(toLineInputs(lines));
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    customer: { id: row.customer_id, name: row.customer_name, company: row.customer_company },
    plan: { id: row.plan_id, name: row.plan_name, billingPeriod: row.plan_period },
    startDate: row.start_date,
    expiryDate: row.expiry_date,
    quoteValidUntil: row.quote_valid_until,
    quoteExpired: row.status === 'quotation' && row.quote_valid_until !== null && row.quote_valid_until < date,
    nextBillingDate: row.next_billing_date,
    closeReason: row.close_reason,
    // What one billing period costs before any discount, as saved on the lines.
    total: fromMinor(gross.totalMinor),
    isDemo: row.is_demo === 1,
    createdAt: row.created_at,
  };
}

export function presentDetail(db: DB, row: SubRow, actor: Actor, viewerUserId: number | null = null) {
  const date = today();
  const joined = get<SummaryJoin>(
    db,
    `SELECT s.*, c.name AS customer_name, c.company AS customer_company, p.name AS plan_name, p.billing_period AS plan_period
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`,
    row.id,
  )!;
  const lines = loadLines(db, [row.id]).get(row.id) ?? [];
  const inputs = toLineInputs(lines);

  // Estimate of the discount the next invoice would carry. It is informational: the real discount is
  // decided, and its usage counted, when the invoice is created.
  let applied: { id: number; name: string; amount: number } | null = null;
  let discountPick: { amountMinor: number; eligibleKeys: (number | string)[] } | null = null;
  if (row.status !== 'closed' && inputs.length > 0) {
    const best = chooseBestDiscount(loadDiscountStates(db), inputs, date);
    if (best) {
      discountPick = best.evaluation;
      applied = { id: best.rule.id, name: best.rule.name, amount: fromMinor(best.evaluation.amountMinor) };
    }
  }
  const priced = priceLines(inputs, discountPick);

  const plan = getPlan(db, row.plan_id)!;
  const terms = row.payment_terms_id
    ? get<{ id: number; name: string; days_due: number }>(db, 'SELECT id, name, days_due FROM payment_terms WHERE id = ?', row.payment_terms_id)
    : undefined;
  const events = all<{ id: number; action: string; from_status: string | null; to_status: string; actor_id: number | null; actor_name: string | null; note: string | null; at: string }>(
    db,
    `SELECT e.id, e.action, e.from_status, e.to_status, e.actor_id, u.name AS actor_name, e.note, e.at
       FROM subscription_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.subscription_id = ? ORDER BY e.id`,
    row.id,
  );
  const invoices = all<{ id: number; number: string; status: string; period_start: string; period_end: string; due_date: string; total_minor: number; paid_minor: number }>(
    db,
    `SELECT id, number, status, period_start, period_end, due_date, total_minor, paid_minor FROM invoices
      WHERE subscription_id = ? ${actor === 'staff' ? '' : `AND status IN ('confirmed', 'paid')`} ORDER BY period_index DESC LIMIT 12`,
    row.id,
  );
  const customer = get<{ id: number; name: string; email: string; company: string | null; phone: string | null; address: string | null }>(
    db,
    'SELECT id, name, email, company, phone, address FROM customers WHERE id = ?',
    row.customer_id,
  )!;

  return {
    ...presentSummary(joined, lines, date),
    customer,
    paymentTerms: terms ? { id: terms.id, name: terms.name, daysDue: terms.days_due } : null,
    templateId: row.template_id,
    // Internal notes stay with the team; customers see the commercial terms only.
    notes: actor === 'staff' ? row.notes : null,
    closedAt: row.closed_at,
    planRules: {
      autoClose: plan.auto_close === 1,
      allowEarlyClose: plan.allow_early_close === 1,
      allowPause: plan.allow_pause === 1,
      allowRenewal: plan.allow_renewal === 1,
      minQuantity: plan.min_quantity,
      price: fromMinor(plan.price_minor),
    },
    lines: priced.lines.map((l, i) => {
      const src = lines[i]!;
      return {
        id: src.id,
        kind: src.kind,
        description: src.description,
        productId: src.product_id,
        variantId: src.variant_id,
        quantity: src.quantity,
        unitPrice: fromMinor(src.unit_price_minor),
        taxName: src.tax_name,
        taxRatePercent: bpToPercent(src.tax_rate_bp),
        subtotal: fromMinor(l.subtotalMinor),
        discount: fromMinor(l.discountMinor),
        tax: fromMinor(l.taxMinor),
        total: fromMinor(l.totalMinor),
      };
    }),
    totals: {
      subtotal: fromMinor(priced.subtotalMinor),
      discount: fromMinor(priced.discountMinor),
      tax: fromMinor(priced.taxMinor),
      total: fromMinor(priced.totalMinor),
    },
    estimatedDiscount: applied,
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      dueDate: i.due_date,
      total: fromMinor(i.total_minor),
      paid: fromMinor(i.paid_minor),
    })),
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      // A customer sees their own actions by name and everything else the team did as "Brightloop".
      actor: e.actor_id
        ? actor === 'staff' || e.actor_id === viewerUserId
          ? { id: e.actor_id, name: e.actor_name }
          : { id: 0, name: 'Brightloop' }
        : null,
      note: e.note,
      at: e.at,
    })),
    actions: availableActions(
      row.status,
      { allowPause: plan.allow_pause === 1, allowEarlyClose: plan.allow_early_close === 1, allowRenewal: plan.allow_renewal === 1 },
      actor,
    ),
  };
}
