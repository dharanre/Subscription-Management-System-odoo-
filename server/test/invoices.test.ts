import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db.js';
import { ADMIN, STAFF, type TestApp, buildTestApp, loginAs, signupCustomer } from './helpers.js';

type Agent = ReturnType<typeof request.agent>;
let t: TestApp;
let admin: Agent;
let staff: Agent;
let productId: number;
let planId: number;
let customerId: number;

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
  planId = (await post(admin, '/api/plans', { name: 'Monthly', price: 500, billingPeriod: 'monthly', availableFrom: '2020-01-01' })).plan.id;
  customerId = (await post(staff, '/api/customers', { name: 'Ada Buyer', email: 'ada@buyer.example', company: 'Buyer Co' })).customer.id;
});

/** Creates a subscription for the customer, bills it, and returns the new invoice's id. */
async function newInvoice(forCustomer = customerId, opts: { confirm?: boolean; qty?: number } = {}): Promise<number> {
  const sub = (await post(staff, '/api/subscriptions', { customerId: forCustomer, planId, startDate: iso(0), expiryDate: iso(365), lines: [{ productId, quantity: opts.qty ?? 2 }] })).subscription;
  for (const a of ['send_quote', 'confirm', 'activate']) await post(staff, `/api/subscriptions/${sub.id}/actions/${a}`, {}, 200);
  const res = await post(staff, '/api/billing/run', { confirm: opts.confirm ?? false }, 200);
  const created = (res.run.created as { id: number; subscriptionId: number }[]).find((c) => c.subscriptionId === sub.id);
  expect(created, 'billing should have invoiced the new subscription').toBeTruthy();
  return created!.id;
}
const act = async (agent: Agent, id: number, action: string, status = 200, body: object = {}) => {
  const res = await agent.post(`/api/invoices/${id}/actions/${action}`).send(body);
  expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(status);
  return res.body;
};
const detail = async (agent: Agent, id: number) => (await agent.get(`/api/invoices/${id}`)).body.invoice;

describe('confirming an invoice', () => {
  it('moves Draft to Confirmed, once', async () => {
    const id = await newInvoice();
    expect((await detail(staff, id)).actions.map((a: { action: string }) => a.action)).toEqual(['confirm', 'cancel']);
    const confirmed = (await act(staff, id, 'confirm')).invoice;
    expect(confirmed).toMatchObject({ status: 'confirmed', confirmedAt: expect.any(String), paid: 0 });
    expect(confirmed.actions.map((a: { action: string }) => a.action)).toEqual(['send', 'cancel']);
    const again = await act(staff, id, 'confirm', 409);
    expect(again.error.code).toBe('invalid_transition');
    expect(again.error.message).toMatch(/Only a draft invoice can be confirmed/);
    expect(confirmed.events.map((e: { action: string }) => e.action)).toEqual(['create', 'confirm']);
  });

  it('confirms every draft at once for billing day, or just the ones named', async () => {
    const ids = [await newInvoice(), await newInvoice(), await newInvoice(), await newInvoice()];
    const some = (await post(staff, '/api/invoices/confirm-drafts', { ids: [ids[0]!, ids[1]!] }, 200)).confirmed;
    expect(some).toBe(2);
    expect((await detail(staff, ids[2]!)).status).toBe('draft');
    const rest = await post(staff, '/api/invoices/confirm-drafts', {}, 200);
    expect(rest).toEqual({ confirmed: 2, failed: [] });
    expect((await post(staff, '/api/invoices/confirm-drafts', {}, 200)).confirmed).toBe(0);
    expect((await staff.get('/api/invoices/counts')).body.counts).toMatchObject({ draft: 0, confirmed: 4 });
  });
});

describe('sending an invoice', () => {
  it('emails the customer, records it, and never claims anything was charged', async () => {
    const id = await newInvoice(customerId, { confirm: true });
    const sent = (await act(staff, id, 'send')).invoice;
    expect(sent).toMatchObject({ sentCount: 1, sentAt: expect.any(String) });
    expect(sent.events.at(-1)).toMatchObject({ action: 'send', note: 'Emailed to ada@buyer.example' });

    expect(t.mailer.sent).toHaveLength(1);
    const mail = t.mailer.sent[0]!;
    expect(mail.to).toBe('ada@buyer.example');
    expect(mail.subject).toContain('INV-00001');
    expect(mail.text).toContain('Amount due');
    expect(mail.text).toContain(`by ${iso(30)}`);
    expect(mail.text).toContain(`/invoices/${id}`);
    expect(mail.text).not.toMatch(/charged|payment received|has been paid/i);

    expect((await act(staff, id, 'send')).invoice.sentCount).toBe(2);
  });

  it('refuses to send a draft or cancelled invoice', async () => {
    const id = await newInvoice();
    expect((await act(staff, id, 'send', 409)).error.message).toMatch(/Confirm INV-00001 before sending/);
    await act(staff, id, 'cancel');
    expect((await act(staff, id, 'send', 409)).error.code).toBe('invalid_transition');
    expect(t.mailer.sent).toHaveLength(0);
  });

  it('does not mark it sent when the email could not be delivered', async () => {
    const id = await newInvoice(customerId, { confirm: true });
    t.mailer.send = async () => {
      throw new Error('smtp down');
    };
    const res = await act(staff, id, 'send', 502);
    expect(res.error.code).toBe('send_failed');
    const inv = await detail(staff, id);
    expect(inv).toMatchObject({ sentAt: null, sentCount: 0 });
    expect(inv.events.map((e: { action: string }) => e.action)).not.toContain('send');
  });
});

describe('cancelling an invoice', () => {
  it('cancels a draft or a confirmed invoice, keeping the reason', async () => {
    const draft = await newInvoice();
    const confirmed = await newInvoice(customerId, { confirm: true });
    const a = (await act(staff, draft, 'cancel', 200, { note: 'Raised by mistake' })).invoice;
    const b = (await act(staff, confirmed, 'cancel')).invoice;
    expect(a).toMatchObject({ status: 'cancelled', cancelReason: 'Raised by mistake', cancelledAt: expect.any(String), actions: [] });
    expect(b.status).toBe('cancelled');
    for (const action of ['confirm', 'send', 'cancel']) await act(staff, draft, action, 409);
  });

  it('cannot cancel once money has been recorded against it', async () => {
    const id = await newInvoice(customerId, { confirm: true });
    run(t.db, 'UPDATE invoices SET paid_minor = 100 WHERE id = ?', id);
    expect((await act(staff, id, 'cancel', 409)).error.code).toBe('has_payments');
    expect((await detail(staff, id)).actions.map((a: { action: string }) => a.action)).toEqual(['send']);
  });

  it('does not quietly invoice the cancelled period again on the next run', async () => {
    const id = await newInvoice();
    await act(staff, id, 'cancel');
    const rerun = (await post(staff, '/api/billing/run', {}, 200)).run;
    expect(rerun).toMatchObject({ due: 0, created: [] });
    expect(get<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM invoices')!.n).toBe(1);
  });
});

describe('who can see and change invoices', () => {
  let alice: Agent;
  let aliceCustomer: number;
  let bob: Agent;
  let bobCustomer: number;

  beforeEach(async () => {
    alice = await signupCustomer(t, 'alice@shop.example', 'Alice');
    bob = await signupCustomer(t, 'bob@shop.example', 'Bob');
    const id = (email: string) => get<{ id: number }>(t.db, 'SELECT id FROM customers WHERE email = ?', email)!.id;
    aliceCustomer = id('alice@shop.example');
    bobCustomer = id('bob@shop.example');
  });

  it('shows a customer only their own issued invoices: not drafts, cancelled ones or anyone else’s', async () => {
    const draft = await newInvoice(aliceCustomer);
    const issued = await newInvoice(aliceCustomer, { confirm: true });
    const cancelled = await newInvoice(aliceCustomer, { confirm: true });
    await act(staff, cancelled, 'cancel');
    const bobs = await newInvoice(bobCustomer, { confirm: true });
    const others = await newInvoice(customerId, { confirm: true });

    const list = (await alice.get('/api/invoices')).body;
    expect(list.items.map((i: { id: number }) => i.id)).toEqual([issued]);
    expect(list.total).toBe(1);
    expect((await alice.get(`/api/invoices/${issued}`)).status).toBe(200);
    for (const hidden of [draft, cancelled, bobs, others]) expect((await alice.get(`/api/invoices/${hidden}`)).status, `invoice ${hidden}`).toBe(404);
    expect((await bob.get(`/api/invoices/${issued}`)).status).toBe(404);
    expect((await alice.get('/api/invoices/counts')).body.counts).toMatchObject({ draft: 0, confirmed: 1, cancelled: 0 });
  });

  it('ignores customer or status filters a customer tries to use to look further', async () => {
    await newInvoice(aliceCustomer, { confirm: true });
    await newInvoice(bobCustomer, { confirm: true });
    expect((await alice.get(`/api/invoices?customerId=${bobCustomer}`)).body.items.map((i: { customer: { id: number } }) => i.customer.id)).toEqual([aliceCustomer]);
    expect((await alice.get('/api/invoices?status=draft')).body.total).toBe(0);
    expect((await alice.get('/api/invoices?q=Bob')).body.total).toBe(0);
  });

  it('keeps invoice history and every action away from customers', async () => {
    const id = await newInvoice(aliceCustomer, { confirm: true });
    const seen = (await alice.get(`/api/invoices/${id}`)).body.invoice;
    expect(seen.events).toEqual([]);
    expect(seen.actions).toEqual([]);
    for (const action of ['confirm', 'send', 'cancel']) expect((await alice.post(`/api/invoices/${id}/actions/${action}`).send({})).status, action).toBe(403);
    expect((await alice.post('/api/invoices/confirm-drafts').send({})).status).toBe(403);
    expect((await request(t.app).get(`/api/invoices/${id}`)).status).toBe(401);
    expect((await request(t.app).post(`/api/invoices/${id}/actions/cancel`).send({})).status).toBe(401);
  });

  it('gives a customer with no linked customer record nothing at all', async () => {
    await newInvoice(aliceCustomer, { confirm: true });
    run(t.db, 'UPDATE customers SET user_id = NULL WHERE id = ?', aliceCustomer);
    expect((await alice.get('/api/invoices')).body).toMatchObject({ items: [], total: 0 });
  });
});

describe('finding and filtering invoices', () => {
  it('flags confirmed invoices that are past due, and only those', async () => {
    const late = await newInvoice(customerId, { confirm: true });
    const onTime = await newInvoice(customerId, { confirm: true });
    const paid = await newInvoice(customerId, { confirm: true });
    const draft = await newInvoice();
    run(t.db, 'UPDATE invoices SET due_date = ?, issue_date = ? WHERE id IN (?, ?, ?)', iso(-1), iso(-31), late, paid, draft);
    run(t.db, `UPDATE invoices SET status = 'paid', paid_minor = total_minor, paid_at = ? WHERE id = ?`, new Date().toISOString(), paid);

    const lateInv = await detail(staff, late);
    expect(lateInv).toMatchObject({ isOverdue: true, daysOverdue: 1 });
    expect((await detail(staff, onTime)).isOverdue).toBe(false);
    expect((await detail(staff, paid)).isOverdue).toBe(false);
    expect((await detail(staff, draft)).isOverdue).toBe(false);

    expect((await staff.get('/api/invoices?status=overdue')).body.items.map((i: { id: number }) => i.id)).toEqual([late]);
    expect((await staff.get('/api/invoices?status=outstanding')).body.items.map((i: { id: number }) => i.id).sort()).toEqual([late, onTime].sort());
    expect((await staff.get('/api/invoices/counts')).body.counts).toMatchObject({ overdue: 1, outstanding: 2, paid: 1, draft: 1 });
  });

  it('filters by status, text and issue date, and paginates', async () => {
    const other = (await post(staff, '/api/customers', { name: 'Zed Other', email: 'zed@other.example', company: 'Zebra Works' })).customer;
    const a = await newInvoice();
    const b = await newInvoice(other.id, { confirm: true });
    await newInvoice();
    run(t.db, 'UPDATE invoices SET issue_date = ? WHERE id = ?', iso(-40), a);

    expect((await staff.get('/api/invoices?status=confirmed')).body.items.map((i: { id: number }) => i.id)).toEqual([b]);
    expect((await staff.get('/api/invoices?q=zebra')).body.total).toBe(1);
    expect((await staff.get('/api/invoices?q=INV-00001')).body.items[0].id).toBe(a);
    expect((await staff.get('/api/invoices?q=SUB-00002')).body.items[0].id).toBe(b);
    expect((await staff.get('/api/invoices?q=%25')).body.total).toBe(0);
    expect((await staff.get(`/api/invoices?to=${iso(-30)}`)).body.items.map((i: { id: number }) => i.id)).toEqual([a]);
    expect((await staff.get(`/api/invoices?from=${iso(-30)}`)).body.total).toBe(2);
    const page = (await staff.get('/api/invoices?pageSize=2&page=2')).body;
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page.items).toHaveLength(1);
    expect((await staff.get('/api/invoices?status=nonsense')).status).toBe(422);
    expect((await staff.get('/api/invoices?from=2026-02-30')).status).toBe(422);
    expect((await staff.get('/api/invoices/9999')).status).toBe(404);
    expect((await staff.get('/api/invoices/abc')).status).toBe(404);
  });
});

describe('invoice arithmetic', () => {
  it('always adds up: lines to totals, and totals to total, with discounts and tax', async () => {
    await post(admin, '/api/discounts', { name: 'Seats', kind: 'percent', value: 12.5, scope: 'products', productIds: [productId], minQuantity: 3, startDate: '2020-01-01' });
    for (const qty of [1, 3, 7, 11, 13]) await newInvoice(customerId, { qty });
    const invoices = all<{ id: number; subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number }>(t.db, 'SELECT * FROM invoices');
    expect(invoices).toHaveLength(5);
    for (const inv of invoices) {
      const lines = all<{ subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number }>(t.db, 'SELECT * FROM invoice_lines WHERE invoice_id = ?', inv.id);
      const sum = (f: 'subtotal_minor' | 'discount_minor' | 'tax_minor' | 'total_minor') => lines.reduce((n, l) => n + l[f], 0);
      expect(sum('subtotal_minor'), `invoice ${inv.id} subtotal`).toBe(inv.subtotal_minor);
      expect(sum('discount_minor'), `invoice ${inv.id} discount`).toBe(inv.discount_minor);
      expect(sum('tax_minor'), `invoice ${inv.id} tax`).toBe(inv.tax_minor);
      expect(sum('total_minor'), `invoice ${inv.id} total`).toBe(inv.total_minor);
      expect(inv.total_minor).toBe(inv.subtotal_minor - inv.discount_minor + inv.tax_minor);
      for (const l of lines) expect(l.total_minor).toBe(l.subtotal_minor - l.discount_minor + l.tax_minor);
    }
    // only the invoices with 3 or more seats earned the discount
    expect(invoices.filter((i) => i.discount_minor > 0)).toHaveLength(4);
  });
});
