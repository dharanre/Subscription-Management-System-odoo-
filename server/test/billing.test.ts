import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db.js';
import { runBilling, retryFailure } from '../src/lib/billing.js';
import { addDays, addPeriods } from '../src/lib/dates.js';
import { ADMIN, STAFF, type TestApp, buildTestApp, loginAs, signupCustomer } from './helpers.js';

type Agent = ReturnType<typeof request.agent>;
let t: TestApp;
let admin: Agent;
let staff: Agent;

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const longAgo = '2020-01-01';

interface World {
  product: { id: number };
  odoo: { id: number };
  monthly: { id: number };
  weekly: { id: number };
  trial: { id: number }; // weekly and closes on its own
  yearly: { id: number };
  free: { id: number };
  freeProduct: { id: number };
  customer: { id: number };
}
let w: World;

async function post(agent: Agent, url: string, body: object, status = 201) {
  const res = await agent.post(url).send(body);
  expect(res.status, `${url} ${JSON.stringify(res.body)}`).toBe(status);
  return res.body;
}

beforeEach(async () => {
  t = await buildTestApp();
  admin = await loginAs(t, ADMIN);
  staff = await loginAs(t, STAFF);
  await post(admin, '/api/taxes', { name: 'GST 18%', ratePercent: 18, isDefault: true });
  await post(admin, '/api/payment-terms', { name: 'Net 30', daysDue: 30, isDefault: true });
  const product = (await post(admin, '/api/products', { name: 'CRM Seat', type: 'software', salesPrice: 1000, costPrice: 400 })).product;
  const odoo = (await post(admin, `/api/products/${product.id}/variants`, { attribute: 'Brand', value: 'Odoo', extraPrice: 560 })).variant;
  const freeProduct = (await post(admin, '/api/products', { name: 'Free Seat', type: 'software', salesPrice: 0, costPrice: 0 })).product;
  const plan = (name: string, over: object) => post(admin, '/api/plans', { name, price: 500, billingPeriod: 'monthly', availableFrom: longAgo, allowPause: true, allowEarlyClose: true, allowRenewal: true, ...over }).then((b) => b.plan);
  w = {
    product,
    odoo,
    freeProduct,
    monthly: await plan('Monthly', {}),
    weekly: await plan('Weekly', { billingPeriod: 'weekly' }),
    trial: await plan('Trial', { billingPeriod: 'weekly', autoClose: true }),
    yearly: await plan('Yearly', { billingPeriod: 'yearly', price: 6000 }),
    free: await plan('Free Tier', { price: 0, minQuantity: 2 }),
    customer: (await post(staff, '/api/customers', { name: 'Ada Buyer', email: 'ada@buyer.example', company: 'Buyer Co', address: '1 High Street' })).customer,
  };
});

const seats = (qty = 5, withOdoo = true) => [{ productId: w.product.id, variantId: withOdoo ? w.odoo.id : null, quantity: qty }];

/** Creates an active subscription whose first period started `startedDaysAgo` days ago. */
async function activeSub(over: Record<string, unknown> = {}, startedDaysAgo = 0) {
  const body = { customerId: w.customer.id, planId: w.monthly.id, lines: seats(), startDate: iso(-startedDaysAgo), expiryDate: iso(365 - startedDaysAgo), ...over };
  const sub = (await post(staff, '/api/subscriptions', body)).subscription;
  for (const a of ['send_quote', 'confirm', 'activate']) expect((await staff.post(`/api/subscriptions/${sub.id}/actions/${a}`).send({})).status).toBe(200);
  return sub as { id: number; number: string };
}

const billingRun = async (body: object = {}) => {
  const res = await staff.post('/api/billing/run').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.run as { runId: number; asOf: string; due: number; created: { id: number; number: string; periodIndex: number; subscriptionId: number; subscriptionNumber: string }[]; failed: { subscriptionId: number; periodIndex: number; message: string }[] };
};
const invoicesOf = async (subId: number) => ((await staff.get(`/api/invoices?subscriptionId=${subId}&pageSize=100`)).body.items as { id: number; periodStart: string; periodEnd: string; status: string; total: number }[]).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
const invoiceCount = () => get<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM invoices')!.n;

describe('creating invoices from subscriptions', () => {
  it('fills in customer, lines, tax and totals from the subscription, with nobody typing anything', async () => {
    const sub = await activeSub();
    const result = await billingRun();
    expect(result).toMatchObject({ due: 1, failed: [] });
    expect(result.created).toHaveLength(1);

    const inv = (await staff.get(`/api/invoices/${result.created[0]!.id}`)).body.invoice;
    expect(inv).toMatchObject({
      number: 'INV-00001',
      status: 'draft',
      subscription: { id: sub.id, number: sub.number },
      customerDetails: { name: 'Ada Buyer', company: 'Buyer Co', email: 'ada@buyer.example', address: '1 High Street' },
      planName: 'Monthly',
      paymentTerms: 'Net 30',
      issueDate: iso(0),
      dueDate: iso(30),
      periodStart: iso(0),
      periodEnd: addDays(addPeriods(iso(0), 'monthly', 1), -1),
    });
    expect(inv.lines.map((l: { description: string; quantity: number; unitPrice: number }) => [l.description, l.quantity, l.unitPrice])).toEqual([
      ['Monthly (monthly)', 1, 500],
      ['CRM Seat - Brand: Odoo', 5, 1560],
    ]);
    expect(inv.totals).toEqual({ subtotal: 8300, discount: 0, tax: 1494, total: 9794, paid: 0, balance: 9794 });
    expect(inv.discount).toBeNull();
    expect(inv.events[0]).toMatchObject({ action: 'create', toStatus: 'draft' });
  });

  it('moves the subscription on to its next period and records the invoice in its history', async () => {
    const sub = await activeSub();
    await billingRun();
    const detail = (await staff.get(`/api/subscriptions/${sub.id}`)).body.subscription;
    expect(detail.nextBillingDate).toBe(addPeriods(iso(0), 'monthly', 1));
    expect(detail.events.at(-1)).toMatchObject({ action: 'invoice', note: expect.stringContaining('INV-00001') });
    expect(detail.invoices).toEqual([expect.objectContaining({ number: 'INV-00001', status: 'draft', total: 9794 })]);
  });

  it('uses the customer details and prices as they were, even if they change later', async () => {
    await activeSub();
    const { created } = await billingRun();
    await staff.patch(`/api/customers/${w.customer.id}`).send({ name: 'Renamed', company: 'Other Co' });
    await admin.patch(`/api/products/${w.product.id}`).send({ salesPrice: 9999 });
    const inv = (await staff.get(`/api/invoices/${created[0]!.id}`)).body.invoice;
    expect(inv.customerDetails.company).toBe('Buyer Co');
    expect(inv.totals.total).toBe(9794);
  });

  it('only bills active subscriptions', async () => {
    const make = async (steps: string[]) => {
      const s = (await post(staff, '/api/subscriptions', { customerId: w.customer.id, planId: w.monthly.id, lines: seats() })).subscription;
      for (const a of steps) await staff.post(`/api/subscriptions/${s.id}/actions/${a}`).send({});
      return s.id as number;
    };
    await make([]); // draft
    await make(['send_quote']); // quotation
    await make(['send_quote', 'confirm']); // confirmed
    await make(['send_quote', 'cancel']); // closed
    const pausedId = await make(['send_quote', 'confirm', 'activate']);
    run(t.db, `UPDATE subscriptions SET status = 'paused', paused_at = ? WHERE id = ?`, iso(0), pausedId);
    const live = await make(['send_quote', 'confirm', 'activate']);

    const result = await billingRun();
    expect(result.due).toBe(1);
    expect(result.created.map((c) => c.subscriptionNumber)).toEqual([(await staff.get(`/api/subscriptions/${live}`)).body.subscription.number]);
  });

  it('does not bill a period that has not started', async () => {
    await activeSub({ startDate: iso(10), expiryDate: iso(375) });
    expect((await billingRun()).due).toBe(0);
    expect(invoiceCount()).toBe(0);
  });

  it('numbers invoices one after another', async () => {
    await activeSub();
    await activeSub();
    await activeSub();
    expect((await billingRun()).created.map((c) => c.number)).toEqual(['INV-00001', 'INV-00002', 'INV-00003']);
  });
});

describe('billing is never done twice', () => {
  it('creates nothing when run again for the same period', async () => {
    const sub = await activeSub();
    expect((await billingRun()).created).toHaveLength(1);
    const again = await billingRun();
    expect(again).toMatchObject({ due: 0, created: [], failed: [] });
    expect(await invoicesOf(sub.id)).toHaveLength(1);
  });

  it('survives two runs that overlap, so nothing is invoiced twice', async () => {
    // A run hands control back to the server every few subscriptions, so with enough of them two runs
    // genuinely interleave. Each period must still be billed exactly once, by whichever run gets there first.
    const subs: { id: number }[] = [];
    for (let i = 0; i < 60; i++) subs.push(await activeSub());
    const [a, b] = await Promise.all([admin.post('/api/billing/run').send({}), staff.post('/api/billing/run').send({})]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const createdA = a.body.run.created as { id: number }[];
    const createdB = b.body.run.created as { id: number }[];
    expect(createdA.length).toBeGreaterThan(0);
    expect(createdB.length).toBeGreaterThan(0); // proof the runs really did share the work
    expect(createdA.length + createdB.length).toBe(60);
    expect(new Set([...createdA, ...createdB].map((c) => c.id)).size).toBe(60);
    expect(invoiceCount()).toBe(60);
    expect(all(t.db, 'SELECT subscription_id, period_index FROM invoices GROUP BY 1, 2 HAVING COUNT(*) > 1')).toHaveLength(0);
    expect((await staff.get('/api/billing/failures')).body.total).toBe(0);
  }, 60_000);

  it('is backed by the database: a second invoice for a period is rejected outright', async () => {
    const sub = await activeSub();
    await billingRun();
    const insert = () =>
      run(
        t.db,
        `INSERT INTO invoices (number, subscription_id, customer_id, period_index, period_start, period_end, issue_date, due_date, status, customer_name, customer_email,
                               subscription_number, plan_name, subtotal_minor, discount_minor, tax_minor, total_minor)
         VALUES ('INV-DUP', ?, ?, 0, ?, ?, ?, ?, 'draft', 'x', 'x@y.example', 'x', 'x', 100, 0, 0, 100)`,
        sub.id,
        w.customer.id,
        iso(0),
        iso(1),
        iso(0),
        iso(0),
      );
    expect(insert).toThrow(/UNIQUE/);
  });

  it('rejects invoices whose figures do not add up', async () => {
    const sub = await activeSub();
    const bad = () =>
      run(
        t.db,
        `INSERT INTO invoices (number, subscription_id, customer_id, period_index, period_start, period_end, issue_date, due_date, status, customer_name, customer_email,
                               subscription_number, plan_name, subtotal_minor, discount_minor, tax_minor, total_minor)
         VALUES ('INV-BAD', ?, ?, 7, ?, ?, ?, ?, 'draft', 'x', 'x@y.example', 'x', 'x', 100, 0, 18, 999)`,
        sub.id,
        w.customer.id,
        iso(0),
        iso(1),
        iso(0),
        iso(0),
      );
    expect(bad).toThrow(/CHECK/);
  });

  it('repairs a schedule that fell out of step without inventing a second invoice', async () => {
    const sub = await activeSub();
    await billingRun();
    run(t.db, 'UPDATE subscriptions SET next_period = 0, next_billing_date = ? WHERE id = ?', iso(0), sub.id);
    const result = await billingRun();
    expect(result).toMatchObject({ created: [], failed: [] });
    expect(await invoicesOf(sub.id)).toHaveLength(1);
    expect((await staff.get(`/api/subscriptions/${sub.id}`)).body.subscription.nextBillingDate).toBe(addPeriods(iso(0), 'monthly', 1));
  });
});

describe('billing is never skipped', () => {
  it('catches up every period that is due, in order, with no gaps or overlaps', async () => {
    const sub = await activeSub({}, 75);
    const result = await billingRun();
    expect(result.created.map((c) => c.periodIndex)).toEqual([0, 1, 2]);
    const list = await invoicesOf(sub.id);
    expect(list).toHaveLength(3);
    for (let i = 1; i < list.length; i++) expect(addDays(list[i - 1]!.periodEnd, 1)).toBe(list[i]!.periodStart);
    expect(list[0]!.periodStart).toBe(iso(-75));
    expect((await staff.get(`/api/subscriptions/${sub.id}`)).body.subscription.nextBillingDate).toBe(addPeriods(iso(-75), 'monthly', 3));
  });

  it('keeps month-end billing dates from drifting', async () => {
    const sub = await activeSub();
    run(t.db, `UPDATE subscriptions SET start_date = '2024-01-31', expiry_date = '2026-12-31', next_period = 0, next_billing_date = '2024-01-31' WHERE id = ?`, sub.id);
    const result = await billingRun({ asOf: '2024-04-30' });
    expect(result.created).toHaveLength(4);
    expect((await invoicesOf(sub.id)).map((i) => i.periodStart)).toEqual(['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
  });

  it('bills a final short period in full and stops at the expiry date', async () => {
    const sub = await activeSub({ expiryDate: iso(10) }, 40);
    const result = await billingRun();
    expect(result.created).toHaveLength(2);
    const list = await invoicesOf(sub.id);
    expect(list.at(-1)!.periodEnd).toBe(iso(10)); // clipped to the expiry, not the usual month end
    expect((await billingRun()).created).toHaveLength(0);
  });

  it('also bills the earlier periods a late run missed, when run for a past date', async () => {
    const sub = await activeSub({}, 75);
    expect((await billingRun({ asOf: iso(-40) })).created.map((c) => c.periodIndex)).toEqual([0, 1]);
    expect((await billingRun()).created.map((c) => c.periodIndex)).toEqual([2]);
    expect(await invoicesOf(sub.id)).toHaveLength(3);
  });

  it('refuses to bill for a date in the future', async () => {
    const res = await staff.post('/api/billing/run').send({ asOf: iso(5) });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.asOf).toBeTruthy();
    expect((await staff.post('/api/billing/run').send({ asOf: '2026-02-30' })).status).toBe(422);
  });

  it('runs a large billing day in one go', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) ids.push((await activeSub()).id);
    const started = Date.now();
    const result = await billingRun();
    expect(result.created).toHaveLength(40);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(new Set(result.created.map((c) => c.number)).size).toBe(40);
  });
});

describe('discounts on invoices', () => {
  const volume = (over: object = {}) => post(admin, '/api/discounts', { name: '5+ seats', kind: 'percent', value: 10, scope: 'products', productIds: [w.product.id], minQuantity: 5, startDate: longAgo, ...over }).then((b) => b.discount);

  it('appears on the next invoice on its own, before tax, and counts as one use', async () => {
    const d = await volume();
    await activeSub();
    const { created } = await billingRun();
    const inv = (await staff.get(`/api/invoices/${created[0]!.id}`)).body.invoice;
    expect(inv.discount).toMatchObject({ id: d.id, name: '5+ seats', amount: 780 });
    expect(inv.totals).toEqual({ subtotal: 8300, discount: 780, tax: 1353.6, total: 8873.6, paid: 0, balance: 8873.6 });
    expect(inv.lines.find((l: { kind: string }) => l.kind === 'plan').discount).toBe(0);
    expect(get<{ usage_count: number }>(t.db, 'SELECT usage_count FROM discounts WHERE id = ?', d.id)!.usage_count).toBe(1);
  });

  it('stops when it runs out: a limit of two is used twice, never three times', async () => {
    const d = await volume({ usageLimit: 2 });
    for (let i = 0; i < 3; i++) await activeSub();
    const { created } = await billingRun();
    const discounts = [];
    for (const c of created) discounts.push((await staff.get(`/api/invoices/${c.id}`)).body.invoice.totals.discount);
    expect(discounts.filter((x) => x > 0)).toHaveLength(2);
    expect(discounts.filter((x) => x === 0)).toHaveLength(1);
    expect(get<{ usage_count: number }>(t.db, 'SELECT usage_count FROM discounts WHERE id = ?', d.id)!.usage_count).toBe(2);
    expect((await admin.get(`/api/discounts/${d.id}`)).body.discount.status).toBe('used_up');
  });

  it('does not apply one that has expired, has not started, or is switched off', async () => {
    await volume({ name: 'Ended', endDate: iso(-1) });
    await volume({ name: 'Soon', startDate: iso(1) });
    const off = await volume({ name: 'Off' });
    await admin.patch(`/api/discounts/${off.id}`).send({ isActive: false });
    await activeSub();
    const { created } = await billingRun();
    expect((await staff.get(`/api/invoices/${created[0]!.id}`)).body.invoice.totals.discount).toBe(0);
    expect(all(t.db, 'SELECT 1 FROM discounts WHERE usage_count > 0')).toHaveLength(0);
  });

  it('takes the best qualifying discount when several apply', async () => {
    await volume({ name: 'Ten percent' }); // 780
    await post(admin, '/api/discounts', { name: 'Flat 1000', kind: 'fixed', value: 1000, scope: 'subscription', startDate: longAgo });
    await activeSub();
    const { created } = await billingRun();
    expect((await staff.get(`/api/invoices/${created[0]!.id}`)).body.invoice.discount).toMatchObject({ name: 'Flat 1000', amount: 1000 });
    expect(get<{ usage_count: number }>(t.db, `SELECT usage_count FROM discounts WHERE name = 'Ten percent'`)!.usage_count).toBe(0);
  });

  it('is not used up by an invoice that fails to be created', async () => {
    const d = await volume({ usageLimit: 1 });
    const sub = await activeSub();
    const failing = await runBilling(t.db, {
      triggeredBy: null,
      beforeInvoice: () => {
        throw new Error('boom');
      },
    });
    expect(failing.failed).toHaveLength(1);
    expect(get<{ usage_count: number }>(t.db, 'SELECT usage_count FROM discounts WHERE id = ?', d.id)!.usage_count).toBe(0);
    expect(get<{ last_value: number }>(t.db, `SELECT last_value FROM sequences WHERE name = 'invoice'`)).toBeUndefined();
    const retry = await billingRun();
    expect(retry.created[0]!.number).toBe('INV-00001'); // the failed attempt did not use up a number
    expect((await invoicesOf(sub.id))).toHaveLength(1);
  });
});

describe('failures are visible and can be retried', () => {
  /** A subscription whose lines have gone missing, so there is nothing to put on an invoice. */
  async function brokenSub() {
    const sub = await activeSub();
    run(t.db, 'DELETE FROM subscription_lines WHERE subscription_id = ?', sub.id);
    return sub;
  }

  it('records a subscription that cannot be billed, and still bills all the others', async () => {
    const broken = await brokenSub();
    const good1 = await activeSub();
    const good2 = await activeSub();
    const result = await billingRun();
    expect(result.due).toBe(3);
    expect(result.created.map((c) => c.subscriptionNumber).sort()).toEqual([good1.number, good2.number].sort());
    expect(result.failed).toEqual([expect.objectContaining({ subscriptionId: broken.id, periodIndex: 0, message: expect.stringContaining('no lines') })]);
    expect(await invoicesOf(broken.id)).toHaveLength(0);

    const open = (await staff.get('/api/billing/failures')).body;
    expect(open.total).toBe(1);
    expect(open.items[0]).toMatchObject({ subscription: { id: broken.id, number: broken.number }, customer: 'Buyer Co', periodIndex: 0, attempts: 1, resolvedAt: null });
  });

  it('keeps it visible and counts attempts until it is fixed, then closes it when billing succeeds', async () => {
    const broken = await brokenSub();
    await billingRun();
    expect((await billingRun()).failed).toHaveLength(1); // a rerun tries it again
    const failure = (await staff.get('/api/billing/failures')).body.items[0];
    expect(failure.attempts).toBe(2);

    const stillBroken = await staff.post(`/api/billing/failures/${failure.id}/retry`).send({});
    expect(stillBroken.body).toMatchObject({ resolved: false });
    expect((await staff.get('/api/billing/failures')).body.items[0].attempts).toBe(3);

    run(t.db, `INSERT INTO subscription_lines (subscription_id, position, kind, description, quantity, unit_price_minor, tax_rate_bp) VALUES (?, 0, 'plan', 'Plan fee', 1, 50000, 1800)`, broken.id);
    const fixed = await staff.post(`/api/billing/failures/${failure.id}/retry`).send({});
    expect(fixed.body).toMatchObject({ resolved: true });
    expect(fixed.body.run.created).toHaveLength(1);
    expect((await staff.get('/api/billing/failures')).body.total).toBe(0);
    expect((await staff.get('/api/billing/failures?status=resolved')).body.items[0]).toMatchObject({ subscription: { id: broken.id }, resolvedAt: expect.any(String) });
    expect(await invoicesOf(broken.id)).toHaveLength(1);
  });

  it('turns an unexpected error into a recorded failure and leaves no half-made invoice behind', async () => {
    const victim = await activeSub();
    const fine = await activeSub();
    const result = await runBilling(t.db, {
      triggeredBy: null,
      beforeInvoice: (sub) => {
        if (sub.id === victim.id) throw new Error('disk on fire');
      },
    });
    expect(result.created.map((c) => c.subscriptionId)).toEqual([fine.id]);
    expect(result.failed).toEqual([expect.objectContaining({ subscriptionId: victim.id, message: expect.stringContaining('disk on fire') })]);
    expect(await invoicesOf(victim.id)).toHaveLength(0);
    const sub = get<{ next_period: number }>(t.db, 'SELECT next_period FROM subscriptions WHERE id = ?', victim.id)!;
    expect(sub.next_period).toBe(0); // still waiting to be billed, not silently moved on

    const second = await billingRun();
    expect(second.created.map((c) => c.subscriptionId)).toEqual([victim.id]);
    expect((await staff.get('/api/billing/failures')).body.total).toBe(0);
  });

  it('never bills a later period ahead of an earlier one that failed', async () => {
    const sub = await activeSub({}, 75); // periods 0, 1 and 2 are due
    const first = await runBilling(t.db, { triggeredBy: null, beforeInvoice: (_s, k) => { if (k === 1) throw new Error('period one is stuck'); } });
    expect(first.created.map((c) => c.periodIndex)).toEqual([0]);
    expect(first.failed).toEqual([expect.objectContaining({ periodIndex: 1 })]);
    expect((await invoicesOf(sub.id)).map((i) => i.periodStart)).toEqual([iso(-75)]);

    const second = await billingRun();
    expect(second.created.map((c) => c.periodIndex)).toEqual([1, 2]);
  });

  it('closes a failure for a subscription that is no longer billable, saying so', async () => {
    const broken = await brokenSub();
    await billingRun();
    run(t.db, `UPDATE subscriptions SET status = 'closed', close_reason = 'cancelled', closed_at = ? WHERE id = ?`, new Date().toISOString(), broken.id);
    const failure = get<{ id: number }>(t.db, 'SELECT id FROM billing_failures')!;
    const result = await retryFailure(t.db, failure.id, { triggeredBy: null });
    expect(result.failureResolved).toBe(true);
    const row = get<{ resolved_at: string | null; message: string }>(t.db, 'SELECT resolved_at, message FROM billing_failures WHERE id = ?', failure.id)!;
    expect(row.resolved_at).not.toBeNull();
    expect(row.message).toMatch(/No longer billable.*closed/);
    expect((await staff.post(`/api/billing/failures/${failure.id}/retry`).send({})).status).toBe(409);
    expect((await staff.post('/api/billing/failures/9999/retry').send({})).status).toBe(404);
  });
});

describe('pausing, closing and plan ends do not lose or double revenue', () => {
  it('refuses to pause or close while invoices are due, naming the reason', async () => {
    const sub = await activeSub();
    for (const action of ['pause', 'close']) {
      const res = await staff.post(`/api/subscriptions/${sub.id}/actions/${action}`).send({});
      expect(res.status, action).toBe(409);
      expect(res.body.error.code).toBe('billing_due');
      expect(res.body.error.message).toContain('Run billing first');
    }
    await billingRun();
    expect((await staff.post(`/api/subscriptions/${sub.id}/actions/pause`).send({})).status).toBe(200);
  });

  it('resumes at the next period start and says which periods were skipped while paused', async () => {
    const sub = await activeSub({}, 100);
    await billingRun({ asOf: iso(-65) }); // periods 0 and 1 billed
    run(t.db, `UPDATE subscriptions SET status = 'paused', paused_at = ? WHERE id = ?`, iso(-65), sub.id);

    const resumed = (await staff.post(`/api/subscriptions/${sub.id}/actions/resume`).send({})).body.subscription;
    expect(resumed.status).toBe('active');
    const periodsInsidePause = [2, 3].filter((k) => addPeriods(iso(-100), 'monthly', k) < iso(0));
    expect(resumed.events.at(-1).note).toContain(`${periodsInsidePause.length} billing periods that began while paused were not billed`);
    expect(resumed.nextBillingDate).toBe(addPeriods(iso(-100), 'monthly', 4));
    expect((await billingRun()).created).toHaveLength(0);
    expect(await invoicesOf(sub.id)).toHaveLength(2);
  });

  it('can close a paused subscription once everything before the pause has been billed', async () => {
    const sub = await activeSub({}, 100);
    await billingRun({ asOf: iso(-65) });
    run(t.db, `UPDATE subscriptions SET status = 'paused', paused_at = ? WHERE id = ?`, iso(-65), sub.id);
    const res = await staff.post(`/api/subscriptions/${sub.id}/actions/close`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('keeps a plan that closes itself open until its last invoices are issued, then closes it', async () => {
    const sub = await activeSub({ planId: w.trial.id, lines: seats(1, false) }, 30);
    run(t.db, 'UPDATE subscriptions SET expiry_date = ? WHERE id = ?', iso(-1), sub.id);

    await staff.get('/api/subscriptions'); // a read triggers the sweep, but invoices are still due
    expect((await staff.get(`/api/subscriptions/${sub.id}`)).body.subscription.status).toBe('active');

    const result = await billingRun();
    expect(result.created.length).toBeGreaterThanOrEqual(4); // weekly periods starting before the expiry
    const closed = (await staff.get(`/api/subscriptions/${sub.id}`)).body.subscription;
    expect(closed).toMatchObject({ status: 'closed', closeReason: 'expired' });
    expect((await invoicesOf(sub.id)).at(-1)!.periodEnd).toBe(iso(-1));
  });

  it('continues billing after a renewal', async () => {
    const sub = await activeSub({ expiryDate: iso(40) }, 30);
    await billingRun();
    expect((await staff.post(`/api/subscriptions/${sub.id}/actions/renew`).send({})).status).toBe(200);
    expect((await staff.get(`/api/subscriptions/${sub.id}`)).body.subscription.expiryDate).toBe(addDays(iso(40), 70));
  });
});

describe('invoices with nothing to pay', () => {
  it('go straight to Paid when confirmed', async () => {
    await activeSub({ planId: w.free.id, lines: [{ productId: w.freeProduct.id, quantity: 2 }] });
    const { created } = await billingRun();
    const inv = (await staff.get(`/api/invoices/${created[0]!.id}`)).body.invoice;
    expect(inv.totals.total).toBe(0);
    const confirmed = (await staff.post(`/api/invoices/${inv.id}/actions/confirm`).send({})).body.invoice;
    expect(confirmed.status).toBe('paid');
    expect(confirmed.events.map((e: { action: string }) => e.action)).toEqual(['create', 'confirm', 'paid']);
  });
});

describe('the billing screens’ data', () => {
  it('previews what a run would bill without billing anything', async () => {
    await activeSub({}, 75);
    await activeSub();
    const res = (await staff.get('/api/billing/due')).body;
    expect(res).toMatchObject({ subscriptionsDue: 2, periodsDue: 4, total: 2 });
    expect(res.items[0]).toMatchObject({ customer: 'Buyer Co', periodsDue: 3, perPeriod: 9794 });
    expect(invoiceCount()).toBe(0);
    expect((await staff.get('/api/billing/due?pageSize=1&page=2')).body.items).toHaveLength(1);
    expect((await staff.get(`/api/billing/due?asOf=${iso(3)}`)).status).toBe(422);
  });

  it('lists past runs with their outcome', async () => {
    await activeSub();
    await billingRun();
    await billingRun();
    const runs = (await staff.get('/api/billing/runs')).body;
    expect(runs.total).toBe(2);
    expect(runs.items[0]).toMatchObject({ due: 0, created: 0, failed: 0, by: expect.any(String), finishedAt: expect.any(String) });
    expect(runs.items[1]).toMatchObject({ due: 1, created: 1, failed: 0, asOf: iso(0) });
  });

  it('can confirm each invoice as it is created', async () => {
    await activeSub();
    const { created } = await billingRun({ confirm: true });
    expect((await staff.get(`/api/invoices/${created[0]!.id}`)).body.invoice).toMatchObject({ status: 'confirmed' });
    expect((await staff.get('/api/billing/runs')).body.items[0].autoConfirm).toBe(true);
  });

  it('is for staff only', async () => {
    const customer = await signupCustomer(t, 'portal@shop.example');
    for (const [method, url] of [['get', '/api/billing/due'], ['post', '/api/billing/run'], ['get', '/api/billing/runs'], ['get', '/api/billing/failures']] as const) {
      expect((await customer[method](url).send({})).status, url).toBe(403);
      expect((await request(t.app)[method](url).send({})).status, url).toBe(401);
    }
  });
});
