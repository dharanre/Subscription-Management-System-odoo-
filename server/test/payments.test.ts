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

/** An invoice for 2 seats: 500 plan fee + 2 x 1000, plus 18% tax = 2950.00 in total. */
const TOTAL = 2950;
async function newInvoice(forCustomer = customerId, confirm = true): Promise<number> {
  const sub = (await post(staff, '/api/subscriptions', { customerId: forCustomer, planId, startDate: iso(0), expiryDate: iso(365), lines: [{ productId, quantity: 2 }] })).subscription;
  for (const a of ['send_quote', 'confirm', 'activate']) await post(staff, `/api/subscriptions/${sub.id}/actions/${a}`, {}, 200);
  const res = await post(staff, '/api/billing/run', { confirm }, 200);
  return (res.run.created as { id: number; subscriptionId: number }[]).find((c) => c.subscriptionId === sub.id)!.id;
}
const pay = async (agent: Agent, invoiceId: number, body: object, status = 201) => {
  const res = await agent.post(`/api/invoices/${invoiceId}/payments`).send({ method: 'bank_transfer', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const detail = async (agent: Agent, id: number) => (await agent.get(`/api/invoices/${id}`)).body.invoice;
const fieldError = async (invoiceId: number, body: object, field: string) => {
  const res = await staff.post(`/api/invoices/${invoiceId}/payments`).send({ method: 'cash', ...body });
  expect(res.status, JSON.stringify(body)).toBe(422);
  expect(res.body.error.fields[field], JSON.stringify(res.body)).toBeTruthy();
  return res.body.error.fields[field] as string;
};

describe('recording a payment', () => {
  it('settles an invoice paid in full, with method, amount, date and a note', async () => {
    const id = await newInvoice();
    const res = await pay(staff, id, { amount: TOTAL, method: 'bank_transfer', paidOn: iso(0), reference: 'UTR-778812', note: 'Part of the March batch' });
    expect(res.invoice).toMatchObject({ status: 'paid', paid: TOTAL, balance: 0, canRecordPayment: false, paidAt: expect.any(String) });
    expect(res.invoice.payments).toEqual([
      expect.objectContaining({ amount: TOTAL, method: 'bank_transfer', methodLabel: 'Bank transfer', paidOn: iso(0), reference: 'UTR-778812', note: 'Part of the March batch', status: 'recorded' }),
    ]);
    expect(res.invoice.events.at(-1)).toMatchObject({ action: 'payment', toStatus: 'paid', note: expect.stringContaining('Paid in full') });
    expect(res.invoice.actions.map((a: { action: string }) => a.action)).toEqual(['send']); // a paid invoice can no longer be cancelled
  });

  it('accepts part payments, keeping the invoice open until the balance is cleared', async () => {
    const id = await newInvoice();
    const first = (await pay(staff, id, { amount: 1000.5, method: 'upi' })).invoice;
    expect(first).toMatchObject({ status: 'confirmed', paid: 1000.5, balance: 1949.5, canRecordPayment: true });
    expect(first.events.at(-1).note).toContain('1949.50 still owing');
    const second = (await pay(staff, id, { amount: 1949.5, method: 'cheque' })).invoice;
    expect(second).toMatchObject({ status: 'paid', paid: TOTAL, balance: 0 });
    expect(second.payments.map((p: { amount: number }) => p.amount).sort()).toEqual([1000.5, 1949.5]);
  });

  it('takes the payment date as today when none is given, and every supported method', async () => {
    const id = await newInvoice();
    for (const method of ['bank_transfer', 'cash', 'cheque', 'card', 'upi']) await pay(staff, id, { amount: 100, method });
    const inv = await detail(staff, id);
    expect(inv.payments.map((p: { method: string }) => p.method).sort()).toEqual(['bank_transfer', 'card', 'cash', 'cheque', 'upi']);
    expect(inv.payments.every((p: { paidOn: string }) => p.paidOn === iso(0))).toBe(true);
    await pay(staff, id, { amount: 100, method: 'other' });
    expect((await detail(staff, id)).paid).toBe(600);
  });

  it('records the amount exactly: no rounding drift across many small payments', async () => {
    const id = await newInvoice();
    for (let i = 0; i < 10; i++) await pay(staff, id, { amount: 0.1 });
    expect(get<{ paid_minor: number }>(t.db, 'SELECT paid_minor FROM invoices WHERE id = ?', id)!.paid_minor).toBe(100);
    expect((await detail(staff, id)).paid).toBe(1);
  });
});

describe('payments that must be refused', () => {
  it('will not take more than is owing, and records nothing when it refuses', async () => {
    const id = await newInvoice();
    const message = await fieldError(id, { amount: TOTAL + 0.01 }, 'amount');
    expect(message).toMatch(/more than the 2950\.00 still owing/);
    expect(all(t.db, 'SELECT 1 FROM payments')).toHaveLength(0);
    expect((await detail(staff, id)).paid).toBe(0);

    await pay(staff, id, { amount: 2000 });
    expect(await fieldError(id, { amount: 1000 }, 'amount')).toMatch(/950\.00 still owing/);
    expect((await detail(staff, id)).paid).toBe(2000);
  });

  it('checks the amount, method and dates field by field', async () => {
    const id = await newInvoice();
    await fieldError(id, { amount: 0 }, 'amount');
    await fieldError(id, { amount: -5 }, 'amount');
    await fieldError(id, { amount: 10.123 }, 'amount');
    await fieldError(id, { amount: '100' }, 'amount');
    await fieldError(id, {}, 'amount');
    await fieldError(id, { amount: 10, method: 'bitcoin' }, 'method');
    await fieldError(id, { amount: 10, paidOn: iso(1) }, 'paidOn');
    await fieldError(id, { amount: 10, paidOn: iso(-1) }, 'paidOn'); // before the invoice was issued
    await fieldError(id, { amount: 10, paidOn: '2026-02-30' }, 'paidOn');
    await fieldError(id, { amount: 10, reference: 'x'.repeat(101) }, 'reference');
    await fieldError(id, { amount: 10, note: 'x'.repeat(501) }, 'note');
    expect(all(t.db, 'SELECT 1 FROM payments')).toHaveLength(0);
  });

  it('only takes payments against an invoice that has been issued and still owes money', async () => {
    const draft = await newInvoice(customerId, false);
    expect((await pay(staff, draft, { amount: 10 }, 409)).error.message).toMatch(/Confirm INV-\d+ before recording a payment/);

    const cancelled = await newInvoice();
    await staff.post(`/api/invoices/${cancelled}/actions/cancel`).send({});
    expect((await pay(staff, cancelled, { amount: 10 }, 409)).error.message).toMatch(/is cancelled/);

    const paid = await newInvoice();
    await pay(staff, paid, { amount: TOTAL });
    expect((await pay(staff, paid, { amount: 1 }, 409)).error.message).toMatch(/already paid in full/);

    expect((await staff.post('/api/invoices/99999/payments').send({ amount: 1, method: 'cash' })).status).toBe(404);
  });

  it('lets only staff record payments', async () => {
    const id = await newInvoice();
    const alice = await signupCustomer(t, 'alice@shop.example');
    expect((await alice.post(`/api/invoices/${id}/payments`).send({ amount: 10, method: 'cash' })).status).toBe(403);
    expect((await request(t.app).post(`/api/invoices/${id}/payments`).send({ amount: 10, method: 'cash' })).status).toBe(401);
    expect(all(t.db, 'SELECT 1 FROM payments')).toHaveLength(0);
  });
});

describe('retrying a request safely', () => {
  it('answers a repeated request with the payment it already made, instead of recording it twice', async () => {
    const id = await newInvoice();
    const requestId = 'req-0001-abcdef';
    const first = await pay(staff, id, { amount: 1000, requestId });
    const again = await pay(staff, id, { amount: 1000, requestId }, 200);
    expect(again).toMatchObject({ duplicate: true, paymentId: first.paymentId });
    expect(first.duplicate).toBe(false);
    expect((await detail(staff, id)).paid).toBe(1000);
    expect(all(t.db, 'SELECT 1 FROM payments')).toHaveLength(1);
  });

  it('refuses a request id that was used for a different invoice, and malformed ids', async () => {
    const a = await newInvoice();
    const b = await newInvoice();
    await pay(staff, a, { amount: 10, requestId: 'req-shared-0001' });
    expect((await pay(staff, b, { amount: 10, requestId: 'req-shared-0001' }, 409)).error.code).toBe('request_id_reused');
    await fieldError(a, { amount: 10, requestId: 'short' }, 'requestId');
    await fieldError(a, { amount: 10, requestId: 'has spaces and symbols!' }, 'requestId');
  });
});

describe('voiding a payment', () => {
  it('takes it back out, reopens the invoice, and keeps the record with its reason', async () => {
    const id = await newInvoice();
    const { paymentId } = await pay(staff, id, { amount: TOTAL, reference: 'WRONG-REF' });
    const res = await staff.post(`/api/payments/${paymentId}/void`).send({ reason: 'Entered against the wrong customer' });
    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({ status: 'voided', voidReason: 'Entered against the wrong customer', voidedAt: expect.any(String) });

    const inv = await detail(staff, id);
    expect(inv).toMatchObject({ status: 'confirmed', paid: 0, balance: TOTAL, paidAt: null, canRecordPayment: true });
    expect(inv.payments).toHaveLength(1); // staff still see the voided entry
    expect(inv.events.at(-1)).toMatchObject({ action: 'payment_void', note: expect.stringContaining('Entered against the wrong customer') });

    // the invoice can be paid properly now, and cancelled if need be
    await pay(staff, id, { amount: TOTAL });
    expect((await detail(staff, id)).status).toBe('paid');
  });

  it('only reduces the invoice by the payment voided', async () => {
    const id = await newInvoice();
    const first = await pay(staff, id, { amount: 1000 });
    await pay(staff, id, { amount: 500 });
    await staff.post(`/api/payments/${first.paymentId}/void`).send({ reason: 'Bounced' });
    expect((await detail(staff, id))).toMatchObject({ paid: 500, status: 'confirmed' });
  });

  it('needs a reason, cannot be repeated, and is for staff only', async () => {
    const id = await newInvoice();
    const { paymentId } = await pay(staff, id, { amount: 100 });
    const noReason = await staff.post(`/api/payments/${paymentId}/void`).send({});
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.fields.reason).toBeTruthy();
    expect((await staff.post(`/api/payments/${paymentId}/void`).send({ reason: '   ' })).status).toBe(422);

    const alice = await signupCustomer(t, 'alice@shop.example');
    expect((await alice.post(`/api/payments/${paymentId}/void`).send({ reason: 'x' })).status).toBe(403);
    expect((await request(t.app).post(`/api/payments/${paymentId}/void`).send({ reason: 'x' })).status).toBe(401);

    expect((await staff.post(`/api/payments/${paymentId}/void`).send({ reason: 'Duplicate' })).status).toBe(200);
    expect((await staff.post(`/api/payments/${paymentId}/void`).send({ reason: 'Again' })).status).toBe(409);
    expect((await staff.post('/api/payments/9999/void').send({ reason: 'x' })).status).toBe(404);
  });

  it('lets an invoice be cancelled once its only payment has been voided', async () => {
    const id = await newInvoice();
    const { paymentId } = await pay(staff, id, { amount: 100 });
    expect((await staff.post(`/api/invoices/${id}/actions/cancel`).send({})).status).toBe(409);
    await staff.post(`/api/payments/${paymentId}/void`).send({ reason: 'Mistake' });
    expect((await staff.post(`/api/invoices/${id}/actions/cancel`).send({})).status).toBe(200);
  });
});

describe('the figures always agree', () => {
  it('keeps each invoice’s paid amount equal to its recorded payments through any sequence of changes', async () => {
    const ids = [await newInvoice(), await newInvoice(), await newInvoice()];
    const payments: number[] = [];
    for (const [i, id] of ids.entries()) {
      payments.push((await pay(staff, id, { amount: 700 + i * 100 })).paymentId);
      payments.push((await pay(staff, id, { amount: 250.25 })).paymentId);
    }
    await staff.post(`/api/payments/${payments[1]}/void`).send({ reason: 'x' });
    await pay(staff, ids[2]!, { amount: TOTAL - 900 - 250.25 }); // clears the third
    await staff.post(`/api/payments/${payments[2]}/void`).send({ reason: 'y' });

    for (const inv of all<{ id: number; status: string; total_minor: number; paid_minor: number; paid_at: string | null }>(t.db, 'SELECT * FROM invoices')) {
      const sum = get<{ s: number | null }>(t.db, `SELECT SUM(amount_minor) AS s FROM payments WHERE invoice_id = ? AND status = 'recorded'`, inv.id)!.s ?? 0;
      expect(inv.paid_minor, `invoice ${inv.id}`).toBe(sum);
      expect(inv.paid_minor).toBeLessThanOrEqual(inv.total_minor);
      expect(inv.status === 'paid', `invoice ${inv.id} status ${inv.status}`).toBe(inv.paid_minor === inv.total_minor);
      expect(inv.paid_at === null, `invoice ${inv.id} paid_at`).toBe(inv.status !== 'paid');
    }
  });

  it('is enforced by the database too, not only by the code', async () => {
    const id = await newInvoice();
    expect(() => run(t.db, 'UPDATE invoices SET paid_minor = total_minor + 1 WHERE id = ?', id)).toThrow(/CHECK/);
    const insert = (amount: number, method: string, status = 'recorded', extra = '') =>
      run(t.db, `INSERT INTO payments (invoice_id, customer_id, amount_minor, method, paid_on, status ${extra ? ', voided_at' : ''}) VALUES (?, ?, ?, ?, ?, ?${extra ? ', NULL' : ''})`, id, customerId, amount, method, iso(0), status);
    expect(() => insert(0, 'cash')).toThrow(/CHECK/);
    expect(() => insert(-100, 'cash')).toThrow(/CHECK/);
    expect(() => insert(100, 'gold')).toThrow(/CHECK/);
    expect(() => insert(100, 'cash', 'voided', 'x')).toThrow(/CHECK/); // a voided payment must say when and why
  });
});

describe('seeing payments', () => {
  it('lists payments with filters, a running total, and pagination', async () => {
    const other = (await post(staff, '/api/customers', { name: 'Zed Other', email: 'zed@other.example', company: 'Zebra Works' })).customer;
    const a = await newInvoice();
    const b = await newInvoice(other.id);
    await pay(staff, a, { amount: 1000, method: 'bank_transfer', reference: 'UTR-AAA' });
    await pay(staff, a, { amount: 500, method: 'cash' });
    const last = await pay(staff, b, { amount: 750.5, method: 'upi', reference: 'UPI-ZZZ' });
    run(t.db, 'UPDATE payments SET paid_on = ? WHERE id = (SELECT MIN(id) FROM payments)', iso(0)); // keep the dates inside the invoice window

    const all_ = (await staff.get('/api/payments')).body;
    expect(all_).toMatchObject({ total: 3, totals: { count: 3, amount: 2250.5 } });
    expect((await staff.get('/api/payments?method=upi')).body.items.map((p: { id: number }) => p.id)).toEqual([last.paymentId]);
    expect((await staff.get('/api/payments?q=zebra')).body.totals).toEqual({ count: 1, amount: 750.5 });
    expect((await staff.get('/api/payments?q=UTR-AAA')).body.total).toBe(1);
    expect((await staff.get(`/api/payments?invoiceId=${a}`)).body.totals.amount).toBe(1500);
    expect((await staff.get(`/api/payments?customerId=${other.id}`)).body.total).toBe(1);
    expect((await staff.get('/api/payments?q=%25')).body.total).toBe(0);
    expect((await staff.get(`/api/payments?from=${iso(1)}`)).body.total).toBe(0);
    expect((await staff.get(`/api/payments?to=${iso(0)}&from=${iso(0)}`)).body.total).toBe(3);
    const page = (await staff.get('/api/payments?pageSize=2&page=2')).body;
    expect(page).toMatchObject({ page: 2, total: 3 });
    expect(page.items).toHaveLength(1);
    expect(all_.items[0]).toMatchObject({ invoiceNumber: expect.stringMatching(/^INV-/), customer: expect.objectContaining({ name: expect.any(String) }) });
    expect((await staff.get('/api/payments?method=gold')).status).toBe(422);
  });

  it('leaves voided payments out of the totals unless asked', async () => {
    const id = await newInvoice();
    const keep = await pay(staff, id, { amount: 300 });
    const gone = await pay(staff, id, { amount: 200 });
    await staff.post(`/api/payments/${gone.paymentId}/void`).send({ reason: 'Bounced' });
    expect((await staff.get('/api/payments')).body.totals).toEqual({ count: 1, amount: 300 });
    expect((await staff.get('/api/payments?status=voided')).body.items.map((p: { id: number }) => p.id)).toEqual([gone.paymentId]);
    expect((await staff.get('/api/payments?status=all')).body.total).toBe(2);
    expect(keep.paymentId).toBeTruthy();
  });

  it('shows a customer only the payments on their own invoices, and never a voided one', async () => {
    const alice = await signupCustomer(t, 'alice@shop.example');
    const bob = await signupCustomer(t, 'bob@shop.example');
    const customerOf = (email: string) => get<{ id: number }>(t.db, 'SELECT id FROM customers WHERE email = ?', email)!.id;
    const mine = await newInvoice(customerOf('alice@shop.example'));
    const theirs = await newInvoice(customerOf('bob@shop.example'));
    const good = await pay(staff, mine, { amount: 400 });
    const bad = await pay(staff, mine, { amount: 100 });
    await staff.post(`/api/payments/${bad.paymentId}/void`).send({ reason: 'Wrong invoice' });
    await pay(staff, theirs, { amount: 999 });

    const list = (await alice.get('/api/payments?status=all&customerId=1')).body;
    expect(list.items.map((p: { id: number }) => p.id)).toEqual([good.paymentId]);
    expect(list.totals).toEqual({ count: 1, amount: 400 });
    const onInvoice = (await alice.get(`/api/invoices/${mine}`)).body.invoice;
    expect(onInvoice.payments).toHaveLength(1);
    expect(onInvoice.payments[0]).toMatchObject({ amount: 400, status: 'recorded' });
    expect(onInvoice.canRecordPayment).toBe(false);
    expect((await bob.get('/api/payments')).body.totals.amount).toBe(999);
    expect((await request(t.app).get('/api/payments')).status).toBe(401);
  });
});

describe('chasing overdue invoices', () => {
  /** An invoice whose due date is `daysAgo` days in the past (negative for the future). */
  async function dueIn(daysAgo: number, forCustomer = customerId) {
    const id = await newInvoice(forCustomer);
    run(t.db, 'UPDATE invoices SET issue_date = ?, due_date = ? WHERE id = ?', iso(-daysAgo - 30), iso(-daysAgo), id);
    return id;
  }

  it('splits what is owed by how late it is', async () => {
    const current = await dueIn(-5);
    await dueIn(10);
    const mid = await dueIn(45);
    await dueIn(75);
    await dueIn(120);
    await dueIn(200);
    await pay(staff, mid, { amount: 450, paidOn: iso(0) }); // part-paid: only the remainder is owed
    const paid = await dueIn(20);
    await pay(staff, paid, { amount: TOTAL }); // settled: not owed
    await newInvoice(customerId, false); // a draft: not owed yet

    const s = (await staff.get('/api/receivables/summary')).body;
    expect(s.buckets.map((b: { key: string; count: number; amount: number }) => [b.key, b.count, b.amount])).toEqual([
      ['current', 1, TOTAL],
      ['d1_30', 1, TOTAL],
      ['d31_60', 1, TOTAL - 450],
      ['d61_90', 1, TOTAL],
      ['d90_plus', 2, TOTAL * 2],
    ]);
    expect(s.outstanding).toEqual({ count: 6, amount: TOTAL * 5 + (TOTAL - 450) });
    expect(s.overdue).toMatchObject({ count: 5, amount: TOTAL * 4 + (TOTAL - 450), oldestDaysOverdue: 200 });
    expect(current).toBeTruthy();
  });

  it('is empty and calm when nothing is owed', async () => {
    const s = (await staff.get('/api/receivables/summary')).body;
    expect(s.outstanding).toEqual({ count: 0, amount: 0 });
    expect(s.overdue).toMatchObject({ count: 0, amount: 0, oldestDueDate: null, oldestDaysOverdue: 0 });
    expect(s.buckets).toHaveLength(5);
  });

  it('is for staff only', async () => {
    const alice = await signupCustomer(t, 'alice@shop.example');
    expect((await alice.get('/api/receivables/summary')).status).toBe(403);
    expect((await request(t.app).get('/api/receivables/summary')).status).toBe(401);
  });

  it('lists the longest-overdue invoices first, and drops an invoice off the list once it is paid', async () => {
    const newer = await dueIn(5);
    const oldest = await dueIn(60);
    const middle = await dueIn(20);
    await dueIn(-10); // not due yet

    const ids = (await staff.get('/api/invoices?status=overdue&sort=due')).body.items.map((i: { id: number }) => i.id);
    expect(ids).toEqual([oldest, middle, newer]);
    const first = (await staff.get('/api/invoices?status=overdue&sort=due')).body.items[0];
    expect(first).toMatchObject({ isOverdue: true, daysOverdue: 60, balance: TOTAL });

    await pay(staff, oldest, { amount: 1000, paidOn: iso(0) });
    const afterPart = (await staff.get('/api/invoices?status=overdue&sort=due')).body.items[0];
    expect(afterPart).toMatchObject({ id: oldest, balance: TOTAL - 1000, isOverdue: true }); // still overdue until cleared

    await pay(staff, oldest, { amount: TOTAL - 1000 });
    expect((await staff.get('/api/invoices?status=overdue&sort=due')).body.items.map((i: { id: number }) => i.id)).toEqual([middle, newer]);
    expect((await detail(staff, oldest))).toMatchObject({ status: 'paid', isOverdue: false });
    expect((await staff.get('/api/invoices/counts')).body.counts).toMatchObject({ overdue: 2, paid: 1 });
  });

  it('sends an overdue invoice as a reminder, not as a fresh invoice', async () => {
    const late = await dueIn(12);
    const fine = await dueIn(-5);
    await staff.post(`/api/invoices/${late}/actions/send`).send({});
    await staff.post(`/api/invoices/${fine}/actions/send`).send({});
    const [reminder, normal] = t.mailer.sent;
    expect(reminder!.subject).toMatch(/^Reminder: invoice INV-\d+ is overdue$/);
    expect(reminder!.text).toMatch(/was due on .* and is 12 days overdue/);
    expect(reminder!.text).toContain('Amount due');
    expect(normal!.subject).toMatch(/^Invoice INV-\d+ from Brightloop$/);
    expect(normal!.text).not.toMatch(/overdue/i);
    expect((await detail(staff, late)).events.at(-1).note).toMatch(/Overdue reminder emailed/);
  });

  it('shows how much a part-paid invoice still owes in the reminder', async () => {
    const id = await dueIn(3);
    await pay(staff, id, { amount: 1000, paidOn: iso(0) });
    await staff.post(`/api/invoices/${id}/actions/send`).send({});
    expect(t.mailer.sent[0]!.text).toMatch(/Amount due: .*1,950\.00/);
  });
});
