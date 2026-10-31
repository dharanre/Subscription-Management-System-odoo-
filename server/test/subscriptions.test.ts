import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db.js';
import { ADMIN, STAFF, type TestApp, buildTestApp, loginAs, signupCustomer } from './helpers.js';

type Agent = ReturnType<typeof request.agent>;
let t: TestApp;
let admin: Agent;
let staff: Agent;

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const longAgo = '2020-01-01';

interface World {
  tax: { id: number };
  product: { id: number; variants: { id: number }[] };
  odoo: { id: number };
  flex: { id: number }; // pause, early close and renewal all allowed
  fixed: { id: number }; // nothing allowed
  trial: { id: number }; // closes on its own
  free: { id: number }; // no plan fee
  terms: { id: number };
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

  const tax = (await post(admin, '/api/taxes', { name: 'GST 18%', ratePercent: 18, isDefault: true })).tax;
  const product = (await post(admin, '/api/products', { name: 'CRM Seat', type: 'software', salesPrice: 1000, costPrice: 400 })).product;
  const odoo = (await post(admin, `/api/products/${product.id}/variants`, { attribute: 'Brand', value: 'Odoo', extraPrice: 560 })).variant;
  const plan = (name: string, over: object) => post(admin, '/api/plans', { name, price: 500, billingPeriod: 'monthly', availableFrom: longAgo, ...over }).then((b) => b.plan);
  const flex = await plan('Flex Monthly', { allowPause: true, allowEarlyClose: true, allowRenewal: true });
  const fixed = await plan('Fixed Yearly', { billingPeriod: 'yearly' });
  const trial = await plan('Trial', { billingPeriod: 'weekly', autoClose: true });
  const free = await plan('Free Tier', { price: 0, minQuantity: 2 });
  const terms = (await post(admin, '/api/payment-terms', { name: 'Net 30', daysDue: 30, isDefault: true })).terms;
  const customer = (await post(staff, '/api/customers', { name: 'Ada Buyer', email: 'ada@buyer.example', company: 'Buyer Co' })).customer;
  w = { tax, product, odoo, flex, fixed, trial, free, terms, customer };
});

const lines = (qty = 2) => [{ productId: w.product.id, quantity: qty }];
const create = (over: object = {}) => post(staff, '/api/subscriptions', { customerId: w.customer.id, planId: w.flex.id, lines: lines(), ...over }).then((b) => b.subscription);
const act = async (agent: Agent, id: number, action: string, status = 200, body: object = {}) => {
  const res = await agent.post(`/api/subscriptions/${id}/actions/${action}`).send(body);
  expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(status);
  return res.body;
};
const toActive = async (id: number) => {
  for (const a of ['send_quote', 'confirm', 'activate']) await act(staff, id, a);
};
/** Issues the invoices that are due. A subscription must be billed up to date before it is paused or closed. */
const bill = async () => {
  const res = await admin.post('/api/billing/run').send({ confirm: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.run;
};

describe('creating a subscription', () => {
  it('numbers each one uniquely and prices the lines from the catalog', async () => {
    const a = await create({ lines: [{ productId: w.product.id, variantId: w.odoo.id, quantity: 5 }] });
    const b = await create();
    expect([a.number, b.number]).toEqual(['SUB-00001', 'SUB-00002']);
    expect(a).toMatchObject({ status: 'draft', startDate: iso(0), customer: { name: 'Ada Buyer' }, plan: { name: 'Flex Monthly' }, paymentTerms: { name: 'Net 30', daysDue: 30 } });
    const seat = a.lines.find((l: { kind: string }) => l.kind === 'product');
    expect(seat).toMatchObject({ unitPrice: 1560, quantity: 5, subtotal: 7800, taxRatePercent: 18, tax: 1404, total: 9204 });
    expect(a.lines.find((l: { kind: string }) => l.kind === 'plan')).toMatchObject({ unitPrice: 500, quantity: 1 });
    expect(a.totals).toEqual({ subtotal: 8300, discount: 0, tax: 1494, total: 9794 });
    expect(a.events).toEqual([expect.objectContaining({ action: 'create', toStatus: 'draft', actor: expect.objectContaining({ name: expect.any(String) }) })]);
  });

  it('does not use up a number when creation fails', async () => {
    await post(staff, '/api/subscriptions', { customerId: 9999, planId: w.flex.id, lines: lines() }, 422);
    expect((await create()).number).toBe('SUB-00001');
  });

  it('defaults the expiry from the plan period and the payment terms from the default', async () => {
    const a = await create();
    expect(a.expiryDate).toBe(iso(0).replace(/^(\d{4})/, (y) => String(Number(y) + 1)));
    const yearly = await create({ planId: w.fixed.id, lines: [] });
    expect(yearly.paymentTerms.name).toBe('Net 30');
  });

  it('starts from a quotation template, which supplies plan, lines and terms', async () => {
    const template = (
      await post(admin, '/api/quotation-templates', {
        name: 'Standard offer',
        planId: w.flex.id,
        validityDays: 14,
        paymentTermsId: w.terms.id,
        lines: [{ productId: w.product.id, variantId: w.odoo.id, quantity: 3 }],
      })
    ).template;
    const sub = (await post(staff, '/api/subscriptions', { customerId: w.customer.id, templateId: template.id })).subscription;
    expect(sub).toMatchObject({ templateId: template.id, plan: { name: 'Flex Monthly' } });
    expect(sub.lines.map((l: { description: string; quantity: number }) => [l.description, l.quantity])).toEqual([
      ['Flex Monthly (monthly)', 1],
      ['CRM Seat - Brand: Odoo', 3],
    ]);
    // the template's validity decides how long the quotation stays valid once sent
    const sent = (await act(staff, sub.id, 'send_quote')).subscription;
    expect(sent.quoteValidUntil).toBe(iso(14));
  });

  it('lets the sales rep override what the template provides', async () => {
    const template = (await post(admin, '/api/quotation-templates', { name: 'T', planId: w.flex.id, validityDays: 30, lines: lines(4) })).template;
    const sub = (await post(staff, '/api/subscriptions', { customerId: w.customer.id, templateId: template.id, lines: lines(9) })).subscription;
    expect(sub.lines.find((l: { kind: string }) => l.kind === 'product').quantity).toBe(9);
  });

  it('validates references, dates and quantities with field-level errors', async () => {
    const bad = async (over: object, field: string) => {
      const res = await staff.post('/api/subscriptions').send({ customerId: w.customer.id, planId: w.flex.id, lines: lines(), ...over });
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(res.body.error.fields[field], JSON.stringify(res.body)).toBeTruthy();
    };
    await bad({ customerId: 9999 }, 'customerId');
    await bad({ planId: 9999 }, 'planId');
    await bad({ planId: null, templateId: null }, 'planId');
    await bad({ templateId: 9999 }, 'templateId');
    await bad({ startDate: '2026-02-30' }, 'startDate');
    await bad({ startDate: iso(10), expiryDate: iso(5) }, 'expiryDate');
    await bad({ startDate: iso(-30), expiryDate: iso(-10) }, 'expiryDate');
    await bad({ paymentTermsId: 9999 }, 'paymentTermsId');
    await bad({ lines: [{ productId: w.product.id, quantity: 0 }] }, 'lines.0.quantity');
    await bad({ lines: [{ productId: 9999, quantity: 1 }] }, 'lines.0.productId');
    await bad({ planId: w.free.id, lines: [{ productId: w.product.id, quantity: 1 }] }, 'lines.0.quantity'); // plan minimum is 2
    const future = (await post(admin, '/api/plans', { name: 'Future', price: 1, billingPeriod: 'monthly', availableFrom: iso(30) })).plan;
    await bad({ planId: future.id }, 'planId');
    await bad({ planId: future.id, startDate: iso(1) }, 'planId');
    expect((await staff.post('/api/subscriptions').send({})).status).toBe(422);
  });

  it('accepts a start date inside the plan window', async () => {
    const future = (await post(admin, '/api/plans', { name: 'Future', price: 1, billingPeriod: 'monthly', availableFrom: iso(30) })).plan;
    const sub = await create({ planId: future.id, startDate: iso(31), lines: [] });
    expect(sub.startDate).toBe(iso(31));
  });
});

describe('subscription lifecycle', () => {
  it('moves Draft -> Quotation -> Confirmed -> Active and records who did what', async () => {
    const { id } = await create();
    const quote = (await act(staff, id, 'send_quote')).subscription;
    expect(quote).toMatchObject({ status: 'quotation', quoteValidUntil: iso(30) });
    expect((await act(staff, id, 'confirm')).subscription.status).toBe('confirmed');
    const active = (await act(staff, id, 'activate')).subscription;
    expect(active).toMatchObject({ status: 'active', nextBillingDate: iso(0) });
    expect(active.events.map((e: { action: string; fromStatus: string | null; toStatus: string }) => [e.action, e.fromStatus, e.toStatus])).toEqual([
      ['create', null, 'draft'],
      ['send_quote', 'draft', 'quotation'],
      ['confirm', 'quotation', 'confirmed'],
      ['activate', 'confirmed', 'active'],
    ]);
    expect(active.events.every((e: { actor: { name: string } | null }) => e.actor?.name)).toBe(true);
  });

  it('refuses steps that are out of order, and says why', async () => {
    const { id } = await create();
    for (const a of ['confirm', 'activate', 'pause', 'resume', 'close', 'renew', 'revert_to_draft']) {
      const body = await act(staff, id, a, 409);
      expect(body.error.code, a).toMatch(/invalid_transition/);
    }
    await act(staff, id, 'send_quote');
    expect((await act(staff, id, 'send_quote', 409)).error.message).toMatch(/Only a draft/);
    expect((await act(staff, id, 'activate', 409)).error.message).toMatch(/Only a confirmed/);
    expect((await act(staff, id, 'bogus', 404)).error.code).toBe('not_found');
    expect((await staff.get('/api/subscriptions/999999')).status).toBe(404);
  });

  it('will not send a quotation with nothing on it', async () => {
    const empty = await create({ planId: w.free.id, lines: [] });
    expect(empty.lines).toEqual([]);
    expect((await act(staff, empty.id, 'send_quote', 409)).error.code).toBe('no_lines');
  });

  it('only lets a draft be edited, and re-prices when the lines change', async () => {
    const { id } = await create({ lines: lines(2) });
    const edited = await staff.patch(`/api/subscriptions/${id}`).send({ lines: [{ productId: w.product.id, variantId: w.odoo.id, quantity: 4 }], notes: 'Rush job' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.subscription.lines.find((l: { kind: string }) => l.kind === 'product')).toMatchObject({ unitPrice: 1560, quantity: 4 });
    expect(edited.body.subscription.notes).toBe('Rush job');

    await act(staff, id, 'send_quote');
    const frozen = await staff.patch(`/api/subscriptions/${id}`).send({ notes: 'too late' });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe('not_editable');

    await act(staff, id, 'revert_to_draft');
    expect((await staff.patch(`/api/subscriptions/${id}`).send({ notes: 'again' })).status).toBe(200);
  });

  it('keeps the price a quotation was made at when the catalog changes later', async () => {
    const { id } = await create({ lines: lines(2) });
    await admin.patch(`/api/products/${w.product.id}`).send({ salesPrice: 5000 });
    const seat = (await staff.get(`/api/subscriptions/${id}`)).body.subscription.lines.find((l: { kind: string }) => l.kind === 'product');
    expect(seat.unitPrice).toBe(1000);
    // an explicit re-save of the lines takes today's catalog price
    const repriced = await staff.patch(`/api/subscriptions/${id}`).send({ lines: lines(2) });
    expect(repriced.body.subscription.lines.find((l: { kind: string }) => l.kind === 'product').unitPrice).toBe(5000);
  });

  it('validates draft edits the same way as creation', async () => {
    const { id } = await create();
    const bad = async (patch: object, field: string) => {
      const res = await staff.patch(`/api/subscriptions/${id}`).send(patch);
      expect(res.status, JSON.stringify(patch)).toBe(422);
      expect(res.body.error.fields[field]).toBeTruthy();
    };
    await bad({ customerId: 9999 }, 'customerId');
    await bad({ expiryDate: iso(-1) }, 'expiryDate');
    const big = (await post(admin, '/api/plans', { name: 'Big', price: 1, billingPeriod: 'monthly', minQuantity: 3, availableFrom: longAgo })).plan;
    await bad({ planId: big.id }, 'lines.0.quantity'); // the saved quantity of 2 is below this plan's minimum of 3
  });

  it('expires a quotation: it cannot be confirmed after its validity ends', async () => {
    const { id } = await create();
    await act(staff, id, 'send_quote');
    run(t.db, 'UPDATE subscriptions SET quote_valid_until = ? WHERE id = ?', iso(-1), id);
    expect((await staff.get(`/api/subscriptions/${id}`)).body.subscription.quoteExpired).toBe(true);
    expect((await act(staff, id, 'confirm', 409)).error.code).toBe('quote_expired');
    await act(staff, id, 'revert_to_draft');
    await act(staff, id, 'send_quote');
    expect((await act(staff, id, 'confirm')).subscription.status).toBe('confirmed');
  });

  it('cancels a draft, quotation or confirmed subscription, and then freezes it', async () => {
    for (const steps of [[], ['send_quote'], ['send_quote', 'confirm']]) {
      const { id } = await create();
      for (const s of steps) await act(staff, id, s);
      const closed = (await act(staff, id, 'cancel', 200, { note: 'Customer changed their mind' })).subscription;
      expect(closed).toMatchObject({ status: 'closed', closeReason: 'cancelled' });
      expect(closed.events.at(-1)).toMatchObject({ action: 'cancel', note: 'Customer changed their mind' });
      for (const a of ['send_quote', 'confirm', 'activate', 'pause', 'close', 'renew', 'cancel']) await act(staff, id, a, 409);
    }
    const active = await create();
    await toActive(active.id);
    expect((await act(staff, active.id, 'cancel', 409)).error.message).toMatch(/Only a draft, quotation or confirmed/);
  });

  it('pauses and resumes where the plan allows it, and not where it does not', async () => {
    const a = await create();
    await toActive(a.id);
    await bill();
    expect((await act(staff, a.id, 'pause')).subscription.status).toBe('paused');
    expect((await act(staff, a.id, 'resume')).subscription.status).toBe('active');

    const b = await create({ planId: w.fixed.id, lines: [] });
    await toActive(b.id);
    for (const action of ['pause', 'close', 'renew']) expect((await act(staff, b.id, action, 409)).error.code, action).toBe('not_allowed_by_plan');
    expect((await staff.get(`/api/subscriptions/${b.id}`)).body.subscription.actions).toEqual([]);
  });

  it('closes early where the plan allows it', async () => {
    const { id } = await create();
    await toActive(id);
    await bill();
    const closed = (await act(staff, id, 'close', 200, { note: 'Moved to a competitor' })).subscription;
    expect(closed).toMatchObject({ status: 'closed', closeReason: 'closed_early' });
    expect(closed.closedAt).toBeTruthy();
  });

  it('renews for another term of the same length', async () => {
    const { id } = await create({ startDate: iso(0), expiryDate: iso(90) });
    await toActive(id);
    const renewed = (await act(staff, id, 'renew')).subscription;
    expect(renewed.expiryDate).toBe(iso(180));
    expect(renewed.status).toBe('active');
    expect(renewed.events.at(-1).note).toContain(`to ${iso(180)}`);
  });

  it('refuses to activate something whose expiry date has already passed', async () => {
    const { id } = await create();
    await act(staff, id, 'send_quote');
    await act(staff, id, 'confirm');
    run(t.db, 'UPDATE subscriptions SET start_date = ?, expiry_date = ? WHERE id = ?', iso(-20), iso(-5), id);
    expect((await act(staff, id, 'activate', 409)).error.code).toBe('already_expired');
  });
});

describe('automatic closure at the plan end', () => {
  it('closes active and paused subscriptions on plans that close themselves, and only those', async () => {
    const closing = await create({ planId: w.trial.id });
    const paused = await create({ planId: w.trial.id });
    const keeps = await create({ planId: w.flex.id });
    for (const s of [closing, paused, keeps]) await toActive(s.id);
    // a trial has no pause option, so force the state the sweep must still handle
    run(t.db, `UPDATE subscriptions SET status = 'paused' WHERE id = ?`, paused.id);
    for (const s of [closing, paused, keeps]) run(t.db, 'UPDATE subscriptions SET start_date = ?, expiry_date = ? WHERE id = ?', iso(-30), iso(-1), s.id);

    const list = (await staff.get('/api/subscriptions?pageSize=50')).body.items as { id: number; status: string; closeReason: string | null }[];
    const byId = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(byId[closing.id]).toMatchObject({ status: 'closed', closeReason: 'expired' });
    expect(byId[paused.id]).toMatchObject({ status: 'closed', closeReason: 'expired' });
    expect(byId[keeps.id]).toMatchObject({ status: 'active', closeReason: null });

    const events = (await staff.get(`/api/subscriptions/${closing.id}`)).body.subscription.events;
    expect(events.at(-1)).toMatchObject({ action: 'auto_close', fromStatus: 'active', toStatus: 'closed', actor: null });
  });

  it('is idempotent and leaves unexpired subscriptions alone', async () => {
    const { id } = await create({ planId: w.trial.id });
    await toActive(id);
    await staff.get('/api/subscriptions');
    await staff.get('/api/subscriptions');
    expect((await staff.get(`/api/subscriptions/${id}`)).body.subscription.status).toBe('active');
    run(t.db, 'UPDATE subscriptions SET start_date = ?, expiry_date = ? WHERE id = ?', iso(-30), iso(-1), id);
    await staff.get('/api/subscriptions');
    await staff.get('/api/subscriptions');
    const autoCloseEvents = all(t.db, `SELECT 1 FROM subscription_events WHERE subscription_id = ? AND action = 'auto_close'`, id);
    expect(autoCloseEvents).toHaveLength(1);
  });
});

describe('who can do what', () => {
  let alice: Agent;
  let bob: Agent;
  let aliceCustomer: number;
  let bobCustomer: number;

  beforeEach(async () => {
    alice = await signupCustomer(t, 'alice@shop.example', 'Alice');
    bob = await signupCustomer(t, 'bob@shop.example', 'Bob');
    const id = (email: string) => get<{ id: number }>(t.db, 'SELECT id FROM customers WHERE email = ?', email)!.id;
    aliceCustomer = id('alice@shop.example');
    bobCustomer = id('bob@shop.example');
  });

  it('shows a customer only their own subscriptions, and answers 404 for anyone else’s', async () => {
    const mine = await create({ customerId: aliceCustomer });
    const theirs = await create({ customerId: bobCustomer });
    await create({ customerId: w.customer.id });

    const list = (await alice.get('/api/subscriptions')).body;
    expect(list.total).toBe(1);
    expect(list.items.map((s: { id: number }) => s.id)).toEqual([mine.id]);
    expect((await alice.get(`/api/subscriptions/${mine.id}`)).status).toBe(200);
    expect((await alice.get(`/api/subscriptions/${theirs.id}`)).status).toBe(404);
    expect((await bob.get(`/api/subscriptions/${mine.id}`)).status).toBe(404);
  });

  it('ignores a customer id or filter supplied by the browser', async () => {
    await create({ customerId: aliceCustomer });
    const theirs = await create({ customerId: bobCustomer });
    const spoof = (await alice.get(`/api/subscriptions?customerId=${bobCustomer}`)).body;
    expect(spoof.items.map((s: { customer: { id: number } }) => s.customer.id)).toEqual([aliceCustomer]);
    expect((await alice.get(`/api/subscriptions/counts?customerId=${bobCustomer}`)).body.total).toBe(1);
    expect((await alice.get(`/api/subscriptions?q=${encodeURIComponent('Bob')}`)).body.total).toBe(0);
    expect(theirs.id).toBeTruthy();
  });

  it('lets a customer act only on their own subscription, only in the ways the plan permits', async () => {
    const mine = await create({ customerId: aliceCustomer });
    const theirs = await create({ customerId: bobCustomer });
    await act(staff, mine.id, 'send_quote');
    await act(staff, theirs.id, 'send_quote');

    await act(alice, theirs.id, 'confirm', 404);
    expect((await act(alice, mine.id, 'confirm')).subscription.status).toBe('confirmed');
    // activating is a staff decision
    await act(alice, mine.id, 'activate', 403);
    await act(staff, mine.id, 'activate');
    await bill();
    expect((await act(alice, mine.id, 'pause')).subscription.status).toBe('paused');
    expect((await act(alice, mine.id, 'resume')).subscription.status).toBe('active');
    expect((await act(alice, mine.id, 'renew')).subscription.status).toBe('active');
    await act(alice, mine.id, 'cancel', 403);
    expect((await act(alice, mine.id, 'close')).subscription).toMatchObject({ status: 'closed', closeReason: 'closed_early' });
    const events = (await alice.get(`/api/subscriptions/${mine.id}`)).body.subscription.events;
    // what the team did is shown as Brightloop, never as a staff member's name or id
    expect(events.find((e: { action: string }) => e.action === 'send_quote').actor).toEqual({ id: 0, name: 'Brightloop' });
    expect(events.filter((e: { action: string }) => ['confirm', 'pause'].includes(e.action)).every((e: { actor: { name: string } }) => e.actor.name === 'Alice')).toBe(true);
  });

  it('hides internal notes and the actions a customer may not take', async () => {
    const mine = await create({ customerId: aliceCustomer, notes: 'Margin is thin, push for annual' });
    const asStaff = (await staff.get(`/api/subscriptions/${mine.id}`)).body.subscription;
    const asCustomer = (await alice.get(`/api/subscriptions/${mine.id}`)).body.subscription;
    expect(asStaff.notes).toBe('Margin is thin, push for annual');
    expect(asCustomer.notes).toBeNull();
    expect(asCustomer.actions).toEqual([]); // a draft offers a customer nothing
    await act(staff, mine.id, 'send_quote');
    expect((await alice.get(`/api/subscriptions/${mine.id}`)).body.subscription.actions.map((a: { action: string }) => a.action)).toEqual(['confirm']);
  });

  it('stops customers creating or editing subscriptions and reading the staff-only lists', async () => {
    const mine = await create({ customerId: aliceCustomer });
    expect((await alice.post('/api/subscriptions').send({ customerId: aliceCustomer, planId: w.flex.id, lines: lines() })).status).toBe(403);
    expect((await alice.patch(`/api/subscriptions/${mine.id}`).send({ notes: 'x' })).status).toBe(403);
    for (const url of ['/api/customers', '/api/payment-terms', '/api/quotation-templates']) expect((await alice.get(url)).status, url).toBe(403);
    expect((await alice.post('/api/customers').send({ name: 'x', email: 'x@y.example' })).status).toBe(403);
    expect((await request(t.app).get('/api/subscriptions')).status).toBe(401);
    expect((await request(t.app).post(`/api/subscriptions/${mine.id}/actions/confirm`).send({})).status).toBe(401);
  });

  it('gives a customer with no linked customer record an empty list, not someone else’s data', async () => {
    run(t.db, 'UPDATE customers SET user_id = NULL WHERE email = ?', 'alice@shop.example');
    await create({ customerId: aliceCustomer });
    const list = (await alice.get('/api/subscriptions')).body;
    expect(list).toMatchObject({ items: [], total: 0 });
    expect((await alice.get('/api/subscriptions/counts')).body.total).toBe(0);
  });
});

describe('listing', () => {
  it('filters by status, text and plan, paginates, and counts by status', async () => {
    const other = (await post(staff, '/api/customers', { name: 'Zed Other', email: 'zed@other.example', company: 'Zebra Works' })).customer;
    const a = await create();
    const b = await create({ customerId: other.id, planId: w.fixed.id, lines: [] });
    await create();
    await toActive(a.id);
    await act(staff, b.id, 'send_quote');

    expect((await staff.get('/api/subscriptions?status=active')).body.items.map((s: { id: number }) => s.id)).toEqual([a.id]);
    expect((await staff.get('/api/subscriptions?q=zebra')).body.items.map((s: { id: number }) => s.id)).toEqual([b.id]);
    expect((await staff.get(`/api/subscriptions?q=${a.number}`)).body.total).toBe(1);
    expect((await staff.get(`/api/subscriptions?planId=${w.fixed.id}`)).body.total).toBe(1);
    expect((await staff.get('/api/subscriptions?q=%25')).body.total).toBe(0); // wildcards are literal
    const page = (await staff.get('/api/subscriptions?pageSize=2&page=2')).body;
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page.items).toHaveLength(1);
    expect((await staff.get('/api/subscriptions?status=nonsense')).status).toBe(422);
    expect((await staff.get('/api/subscriptions/counts')).body).toEqual({ counts: { draft: 1, quotation: 1, confirmed: 0, active: 1, paused: 0, closed: 0 }, total: 3 });
  });

  it('shows what one billing period costs on each row', async () => {
    await create({ lines: [{ productId: w.product.id, variantId: w.odoo.id, quantity: 5 }] });
    expect((await staff.get('/api/subscriptions')).body.items[0].total).toBe(9794);
  });
});

describe('customers, payment terms and templates', () => {
  it('lets staff create and edit customers, rejecting duplicate emails', async () => {
    expect((await staff.post('/api/customers').send({ name: 'Dup', email: 'ADA@buyer.example' })).status).toBe(409);
    expect((await staff.post('/api/customers').send({ name: '', email: 'nope' })).status).toBe(422);
    const patched = await staff.patch(`/api/customers/${w.customer.id}`).send({ phone: '+91 99999 00000', email: 'ada.new@buyer.example' });
    expect(patched.body.customer).toMatchObject({ phone: '+91 99999 00000', email: 'ada.new@buyer.example', hasPortalAccount: false });
    const portal = await signupCustomer(t, 'portal@shop.example');
    expect(portal).toBeTruthy();
    const portalId = get<{ id: number }>(t.db, 'SELECT id FROM customers WHERE email = ?', 'portal@shop.example')!.id;
    expect((await staff.patch(`/api/customers/${portalId}`).send({ email: 'changed@shop.example' })).status).toBe(409);
    expect((await staff.patch(`/api/customers/${portalId}`).send({ company: 'Portal Ltd' })).status).toBe(200);
    expect((await staff.get('/api/customers?q=portal')).body.items[0]).toMatchObject({ hasPortalAccount: true });
    expect((await staff.get('/api/customers/9999')).status).toBe(404);
  });

  it('counts subscriptions per customer', async () => {
    await create();
    await create();
    expect((await staff.get(`/api/customers/${w.customer.id}`)).body.customer.subscriptionCount).toBe(2);
  });

  it('keeps one default payment term and lets only the admin change them', async () => {
    const net15 = (await post(admin, '/api/payment-terms', { name: 'Net 15', daysDue: 15, isDefault: true })).terms;
    const list = (await staff.get('/api/payment-terms')).body.items as { id: number; isDefault: boolean }[];
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([net15.id]);
    expect((await staff.post('/api/payment-terms').send({ name: 'X', daysDue: 5 })).status).toBe(403);
    expect((await admin.post('/api/payment-terms').send({ name: 'net 15', daysDue: 15 })).status).toBe(409);
    expect((await admin.post('/api/payment-terms').send({ name: 'Bad', daysDue: -1 })).status).toBe(422);
    expect((await admin.post('/api/payment-terms').send({ name: 'Bad', daysDue: 1.5 })).status).toBe(422);
    expect((await admin.patch(`/api/payment-terms/${net15.id}`).send({ daysDue: 20 })).body.terms.daysDue).toBe(20);
  });

  it('validates template lines against the plan, and keeps template writes admin-only', async () => {
    const bad = async (over: object, field: string) => {
      const res = await admin.post('/api/quotation-templates').send({ name: 'T', planId: w.flex.id, validityDays: 30, lines: lines(), ...over });
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(res.body.error.fields[field], JSON.stringify(res.body)).toBeTruthy();
    };
    await bad({ planId: 9999 }, 'planId');
    await bad({ validityDays: 0 }, 'validityDays');
    await bad({ validityDays: 400 }, 'validityDays');
    await bad({ paymentTermsId: 9999 }, 'paymentTermsId');
    await bad({ planId: w.free.id, lines: [{ productId: w.product.id, quantity: 1 }] }, 'lines.0.quantity');
    await bad({ lines: [{ productId: w.product.id, variantId: 9999, quantity: 2 }] }, 'lines.0.variantId');
    await bad({ name: '' }, 'name');
    expect((await staff.post('/api/quotation-templates').send({ name: 'T', planId: w.flex.id, validityDays: 30, lines: [] })).status).toBe(403);

    const ok = await post(admin, '/api/quotation-templates', { name: 'Good', planId: w.flex.id, validityDays: 21, lines: [{ productId: w.product.id, variantId: w.odoo.id, quantity: 2 }] });
    expect(ok.template.lines[0]).toMatchObject({ productName: 'CRM Seat', variantLabel: 'Brand: Odoo', unitPrice: 1560, quantity: 2 });
    expect((await admin.post('/api/quotation-templates').send({ name: 'good', planId: w.flex.id, validityDays: 5, lines: [] })).status).toBe(409);
    expect((await staff.get('/api/quotation-templates')).body.total).toBe(1);
  });

  it('stops offering a switched-off template', async () => {
    const template = (await post(admin, '/api/quotation-templates', { name: 'Old', planId: w.flex.id, validityDays: 30, lines: lines() })).template;
    await admin.patch(`/api/quotation-templates/${template.id}`).send({ isActive: false });
    const res = await staff.post('/api/subscriptions').send({ customerId: w.customer.id, templateId: template.id });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.templateId).toBeTruthy();
  });
});
