import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { get, run } from '../src/db.js';
import { addDays } from '../src/lib/dates.js';
import { ADMIN, STAFF, type TestApp, buildTestApp, loginAs, signupCustomer } from './helpers.js';

type Agent = ReturnType<typeof request.agent>;
let t: TestApp;
let admin: Agent;
let staff: Agent;
let productId: number;
let customerId: number;
const plans: Record<string, number> = {};

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

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
  productId = (await post(admin, '/api/products', { name: 'CRM Seat', type: 'software', salesPrice: 1000, costPrice: 400 })).product.id;
  const plan = async (name: string, billingPeriod: string, price: number) => {
    plans[name] = (await post(admin, '/api/plans', { name, price, billingPeriod, availableFrom: '2020-01-01', allowPause: true, allowEarlyClose: true, allowRenewal: true })).plan.id;
  };
  await plan('monthly', 'monthly', 500);
  await plan('yearly', 'yearly', 12000);
  await plan('weekly', 'weekly', 120);
  await plan('daily', 'daily', 30);
  customerId = (await post(staff, '/api/customers', { name: 'Ada Buyer', email: 'ada@buyer.example', company: 'Buyer Co' })).customer.id;
});

/** Creates a subscription; leaves it as a draft unless `steps` takes it further. Monthly gets 2 seats (list price 2500/month ex tax). */
async function sub(planName: string, steps: string[] = ['send_quote', 'confirm', 'activate'], over: Record<string, unknown> = {}, forCustomer = customerId) {
  const lines = planName === 'monthly' ? [{ productId, quantity: 2 }] : [];
  const s = (await post(staff, '/api/subscriptions', { customerId: forCustomer, planId: plans[planName], startDate: iso(0), expiryDate: iso(365), lines, ...over })).subscription;
  for (const a of steps) await post(staff, `/api/subscriptions/${s.id}/actions/${a}`, {}, 200);
  return s.id as number;
}
const bill = async (confirm = true) => (await post(staff, '/api/billing/run', { confirm }, 200)).run;
const dash = async (qs = '', agent: Agent = staff) => (await agent.get(`/api/dashboard${qs}`)).body;
const pay = (invoiceId: number, amount: number, extra: object = {}) => post(staff, `/api/invoices/${invoiceId}/payments`, { amount, method: 'bank_transfer', ...extra });

describe('an empty system', () => {
  it('reports zeros rather than failing, over the last 30 days by default', async () => {
    const d = await dash();
    expect(d.range).toEqual({ from: iso(-29), to: iso(0) });
    expect(d.subscriptions).toMatchObject({ active: 0, paused: 0, total: 0 });
    expect(d.recurring).toMatchObject({ mrr: 0, arr: 0, activeSubscriptions: 0 });
    expect(d.revenue).toEqual({ collected: 0, collectedCount: 0, invoiced: 0, invoicedCount: 0 });
    expect(d.receivables.outstanding).toEqual({ count: 0, amount: 0 });
    expect(d.receivables.overdue).toMatchObject({ count: 0, amount: 0 });
    expect(d.attention).toEqual({ billingDue: 0, billingFailures: 0, draftInvoices: 0, expiringSoon: 0, expiredQuotes: 0 });
    expect(d.trend.granularity).toBe('day');
    expect(d.trend.points).toHaveLength(30);
    expect(d.trend.points.every((p: { invoiced: number; collected: number }) => p.invoiced === 0 && p.collected === 0)).toBe(true);
  });
});

describe('recurring revenue', () => {
  it('counts only active subscriptions, at list price before tax, as a monthly figure', async () => {
    await sub('monthly'); // 500 + 2 x 1000 = 2500 a month
    await sub('monthly', ['send_quote']); // a quotation: not revenue yet
    await sub('monthly', []); // a draft: not revenue
    expect((await dash()).recurring).toMatchObject({ mrr: 2500, arr: 30000, activeSubscriptions: 1 });
  });

  it('turns every billing period into the same monthly basis', async () => {
    await sub('monthly'); // 2500
    await sub('yearly'); // 12000 / 12 = 1000
    await sub('weekly'); // 120 x 52 / 12 = 520
    await sub('daily'); // 30 x 365 / 12 = 912.50
    const d = await dash();
    expect(d.recurring.mrr).toBe(4932.5);
    expect(d.recurring.arr).toBe(59190);
    expect(d.recurring.activeSubscriptions).toBe(4);
  });

  it('leaves out paused and closed subscriptions', async () => {
    const a = await sub('monthly');
    const b = await sub('monthly');
    await sub('monthly');
    await bill(); // everything due is invoiced, so they can be paused or closed
    await post(staff, `/api/subscriptions/${a}/actions/pause`, {}, 200);
    await post(staff, `/api/subscriptions/${b}/actions/close`, {}, 200);
    const d = await dash();
    expect(d.subscriptions).toMatchObject({ active: 1, paused: 1 });
    expect(d.subscriptions.byStatus).toMatchObject({ active: 1, paused: 1, closed: 1 });
    expect(d.recurring.mrr).toBe(2500);
  });
});

describe('the numbers follow real operations', () => {
  it('moves with every step of a billing day, a payment, a late invoice and a correction', async () => {
    const before = await dash();
    expect(before.subscriptions.active).toBe(0);

    // a new subscription goes live
    const id = await sub('monthly');
    let d = await dash();
    expect(d.subscriptions).toMatchObject({ active: 1, activatedInRange: 1 });
    expect(d.recurring.mrr).toBe(2500);
    expect(d.attention.billingDue).toBe(1); // it is due to be billed today

    // billing day: an invoice appears as a draft, then is confirmed
    const run1 = await bill(false);
    const invoiceId = run1.created[0].id as number;
    d = await dash();
    expect(d.attention).toMatchObject({ billingDue: 0, draftInvoices: 1 });
    expect(d.receivables.outstanding.count).toBe(0); // a draft is not owed yet
    expect(d.revenue).toMatchObject({ invoiced: 0, invoicedCount: 0 });
    await post(staff, `/api/invoices/${invoiceId}/actions/confirm`, {}, 200);
    d = await dash();
    expect(d.attention.draftInvoices).toBe(0);
    expect(d.revenue).toMatchObject({ invoiced: 2950, invoicedCount: 1, collected: 0 });
    expect(d.receivables.outstanding).toEqual({ count: 1, amount: 2950 });
    expect(d.receivables.dueSoon).toEqual({ count: 0, amount: 0 }); // Net 30: not due within a week

    // part of it is paid
    const first = await pay(invoiceId, 1000);
    d = await dash();
    expect(d.revenue).toMatchObject({ collected: 1000, collectedCount: 1 });
    expect(d.receivables.outstanding).toEqual({ count: 1, amount: 1950 });

    // it becomes due this week, then late
    run(t.db, 'UPDATE invoices SET issue_date = ?, due_date = ? WHERE id = ?', iso(-25), iso(5), invoiceId);
    d = await dash();
    expect(d.receivables.dueSoon).toEqual({ count: 1, amount: 1950 });
    expect(d.receivables.overdue).toMatchObject({ count: 0, amount: 0 });
    run(t.db, 'UPDATE invoices SET issue_date = ?, due_date = ? WHERE id = ?', iso(-40), iso(-10), invoiceId);
    d = await dash();
    expect(d.receivables.overdue).toMatchObject({ count: 1, amount: 1950, oldestDaysOverdue: 10 });
    expect(d.receivables.dueSoon.count).toBe(0);
    expect(d.receivables.buckets.find((b: { key: string }) => b.key === 'd1_30')).toMatchObject({ count: 1, amount: 1950 });

    // the rest arrives: nothing owed, nothing overdue
    await pay(invoiceId, 1950);
    d = await dash();
    expect(d.revenue).toMatchObject({ collected: 2950, collectedCount: 2 });
    expect(d.receivables.outstanding).toEqual({ count: 0, amount: 0 });
    expect(d.receivables.overdue).toMatchObject({ count: 0, amount: 0 });

    // a payment entered by mistake is voided: the money is owed again and the revenue falls back
    await post(staff, `/api/payments/${first.paymentId}/void`, { reason: 'Entered twice' }, 200);
    d = await dash();
    expect(d.revenue).toMatchObject({ collected: 1950, collectedCount: 1 });
    expect(d.receivables.outstanding).toEqual({ count: 1, amount: 1000 });
    expect(d.receivables.overdue).toMatchObject({ count: 1, amount: 1000 });

    // the subscription is paused and then closed
    await post(staff, `/api/subscriptions/${id}/actions/pause`, {}, 200);
    d = await dash();
    expect(d.subscriptions).toMatchObject({ active: 0, paused: 1 });
    expect(d.recurring.mrr).toBe(0);
    await post(staff, `/api/subscriptions/${id}/actions/close`, {}, 200);
    d = await dash();
    expect(d.subscriptions).toMatchObject({ paused: 0, closedInRange: 1 });
    expect(d.subscriptions.byStatus.closed).toBe(1);
  });

  it('tells you what needs doing: failed billing, expiring subscriptions and expired quotations', async () => {
    const broken = await sub('monthly');
    run(t.db, 'DELETE FROM subscription_lines WHERE subscription_id = ?', broken);
    await bill();
    expect((await dash()).attention.billingFailures).toBe(1);

    await sub('monthly', ['send_quote', 'confirm', 'activate'], { expiryDate: iso(10) });
    const quote = await sub('monthly', ['send_quote']);
    run(t.db, 'UPDATE subscriptions SET quote_valid_until = ? WHERE id = ?', iso(-2), quote);
    const a = (await dash()).attention;
    expect(a.expiringSoon).toBe(1);
    expect(a.expiredQuotes).toBe(1);
  });
});

describe('the date range', () => {
  /** An invoice that was issued `daysAgo` days ago and fully paid `paidDaysAgo` days ago. */
  async function paidInvoice(forCustomer: number, daysAgo: number, paidDaysAgo: number) {
    const s = await sub('monthly', undefined, undefined, forCustomer);
    const { created } = await bill();
    const invoiceId = created.find((c: { subscriptionId: number }) => c.subscriptionId === s)!.id as number;
    run(t.db, 'UPDATE invoices SET issue_date = ?, due_date = ? WHERE id = ?', iso(-daysAgo), iso(-daysAgo + 30), invoiceId);
    await pay(invoiceId, 2950, { paidOn: iso(-paidDaysAgo) });
    return invoiceId;
  }

  it('counts invoices and payments by the dates they fall on', async () => {
    await paidInvoice(customerId, 100, 90); // outside the last 30 days
    await paidInvoice(customerId, 10, 5);
    const recent = await dash();
    expect(recent.revenue).toEqual({ collected: 2950, collectedCount: 1, invoiced: 2950, invoicedCount: 1 });
    const wide = await dash(`?from=${iso(-120)}&to=${iso(0)}`);
    expect(wide.revenue).toEqual({ collected: 5900, collectedCount: 2, invoiced: 5900, invoicedCount: 2 });
    const none = await dash(`?from=${iso(-60)}&to=${iso(-40)}`);
    expect(none.revenue).toEqual({ collected: 0, collectedCount: 0, invoiced: 0, invoicedCount: 0 });
  });

  it('does not let the range change what is owed right now', async () => {
    const id = await paidInvoice(customerId, 10, 5);
    await post(staff, `/api/payments/${get<{ id: number }>(t.db, 'SELECT id FROM payments WHERE invoice_id = ?', id)!.id}/void`, { reason: 'x' }, 200);
    const narrow = await dash(`?from=${iso(-60)}&to=${iso(-50)}`);
    expect(narrow.receivables.outstanding).toEqual({ count: 1, amount: 2950 });
  });

  it('draws a bar per day for short ranges and per month for long ones, with the total unchanged', async () => {
    await paidInvoice(customerId, 100, 90);
    await paidInvoice(customerId, 40, 20);
    await paidInvoice(customerId, 10, 5);

    const daily = await dash(`?from=${iso(-44)}&to=${iso(0)}`);
    expect(daily.trend.granularity).toBe('day');
    expect(daily.trend.points).toHaveLength(45);
    expect(daily.trend.points.find((p: { key: string }) => p.key === iso(-5))).toMatchObject({ collected: 2950 });

    const monthly = await dash(`?from=${iso(-120)}&to=${iso(0)}`);
    expect(monthly.trend.granularity).toBe('month');
    const months = monthly.trend.points as { key: string; collected: number; invoiced: number }[];
    expect(months.length).toBeGreaterThanOrEqual(4);
    expect(new Set(months.map((m) => m.key)).size).toBe(months.length); // no month twice
    expect([...months].map((m) => m.key)).toEqual([...months].map((m) => m.key).sort());
    expect(months.reduce((n, m) => n + m.collected, 0)).toBeCloseTo(monthly.revenue.collected, 2);
    expect(months.reduce((n, m) => n + m.invoiced, 0)).toBeCloseTo(monthly.revenue.invoiced, 2);
    expect(months.some((m) => m.collected === 0)).toBe(true); // quiet months are drawn, not skipped
  });

  it('checks the dates it is given', async () => {
    for (const qs of [`?from=${iso(0)}&to=${iso(-5)}`, `?from=${iso(-1200)}&to=${iso(0)}`, '?from=2026-02-30', '?to=nonsense']) {
      const res = await staff.get(`/api/dashboard${qs}`);
      expect(res.status, qs).toBe(422);
    }
    // an end date before the default start moves the start back with it, instead of failing
    const early = await dash(`?to=${iso(-60)}`);
    expect(early.range.to).toBe(iso(-60));
    expect(early.range.from <= early.range.to).toBe(true);
  });

  it('is for staff only', async () => {
    const alice = await signupCustomer(t, 'alice@shop.example');
    expect((await alice.get('/api/dashboard')).status).toBe(403);
    expect((await request(t.app).get('/api/dashboard')).status).toBe(401);
  });
});

describe('listing subscriptions by when they start', () => {
  it('narrows the list to a date range', async () => {
    await sub('monthly', undefined, { startDate: iso(-100), expiryDate: iso(265) });
    const recent = await sub('monthly', undefined, { startDate: iso(-5), expiryDate: iso(360) });
    expect((await staff.get(`/api/subscriptions?from=${iso(-30)}`)).body.items.map((s: { id: number }) => s.id)).toEqual([recent]);
    expect((await staff.get(`/api/subscriptions?to=${iso(-30)}`)).body.total).toBe(1);
    expect((await staff.get(`/api/subscriptions?from=${iso(-200)}&to=${iso(0)}`)).body.total).toBe(2);
    expect((await staff.get('/api/subscriptions?from=2026-02-30')).status).toBe(422);
  });
});

describe('the customer portal summary', () => {
  let alice: Agent;
  let bob: Agent;
  let aliceCustomer: number;
  let bobCustomer: number;
  const customerOf = (email: string) => get<{ id: number }>(t.db, 'SELECT id FROM customers WHERE email = ?', email)!.id;
  const summary = async (agent: Agent) => (await agent.get('/api/portal/summary')).body.summary;

  beforeEach(async () => {
    alice = await signupCustomer(t, 'alice@shop.example', 'Alice');
    bob = await signupCustomer(t, 'bob@shop.example', 'Bob');
    aliceCustomer = customerOf('alice@shop.example');
    bobCustomer = customerOf('bob@shop.example');
  });

  it('shows a customer their own subscriptions, what they owe, and what they have paid', async () => {
    const mine = await sub('monthly', undefined, undefined, aliceCustomer);
    await sub('monthly', undefined, undefined, bobCustomer);
    const { created } = await bill();
    const invoiceId = created.find((c: { subscriptionId: number }) => c.subscriptionId === mine)!.id as number;

    let s = await summary(alice);
    expect(s.subscriptions).toMatchObject({ active: 1 });
    expect(s.subscriptions.items).toEqual([expect.objectContaining({ id: mine, perPeriod: 2950, status: 'active' })]);
    expect(s.invoices).toMatchObject({ outstanding: { count: 1, amount: 2950 }, overdue: { count: 0, amount: 0 }, next: expect.objectContaining({ id: invoiceId, balance: 2950, isOverdue: false }) });
    expect(s.payments).toMatchObject({ count: 0, totalPaid: 0, recent: [] });

    await pay(invoiceId, 1000, { method: 'upi', reference: 'U1' });
    run(t.db, 'UPDATE invoices SET issue_date = ?, due_date = ? WHERE id = ?', iso(-40), iso(-3), invoiceId);
    s = await summary(alice);
    expect(s.invoices).toMatchObject({ outstanding: { count: 1, amount: 1950 }, overdue: { count: 1, amount: 1950 }, next: expect.objectContaining({ balance: 1950, isOverdue: true }) });
    expect(s.payments).toMatchObject({ count: 1, totalPaid: 1000 });
    expect(s.payments.recent[0]).toMatchObject({ amount: 1000, method: 'upi', invoiceNumber: expect.stringMatching(/^INV-/) });
  });

  it('never shows another customer’s figures, however it is asked', async () => {
    const a = await sub('monthly', undefined, undefined, aliceCustomer);
    const b = await sub('monthly', undefined, undefined, bobCustomer);
    const { created } = await bill();
    const bobsInvoice = created.find((c: { subscriptionId: number }) => c.subscriptionId === b)!.id as number;
    await pay(bobsInvoice, 2950);

    const s = await summary(alice);
    expect(s.subscriptions.items.map((i: { id: number }) => i.id)).toEqual([a]);
    expect(s.payments).toMatchObject({ count: 0, totalPaid: 0 });
    const tricked = (await alice.get(`/api/portal/summary?customerId=${bobCustomer}&userId=1`)).body.summary;
    expect(tricked).toEqual(s);
    expect((await summary(bob)).payments.totalPaid).toBe(2950);
  });

  it('leaves out drafts and cancelled invoices, which are not the customer’s to see yet', async () => {
    await sub('monthly', undefined, undefined, aliceCustomer);
    await bill(false); // left as a draft
    expect((await summary(alice)).invoices).toMatchObject({ outstanding: { count: 0, amount: 0 }, next: null, recent: [] });
  });

  it('is empty for a customer with nothing yet, and null when no customer record is linked', async () => {
    expect(await summary(alice)).toMatchObject({ subscriptions: { active: 0, items: [] }, invoices: { next: null, recent: [] } });
    run(t.db, 'UPDATE customers SET user_id = NULL WHERE id = ?', aliceCustomer);
    expect(await summary(alice)).toBeNull();
  });

  it('is only for customers', async () => {
    expect((await staff.get('/api/portal/summary')).status).toBe(403);
    expect((await request(t.app).get('/api/portal/summary')).status).toBe(401);
    expect(addDays(iso(0), 0)).toBe(iso(0));
  });
});
