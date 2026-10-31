import { expect, test } from '@playwright/test';
import { ADMIN, STAFF, STRONG_PASSWORD, apiAs, inr, isoDate, ok, signIn } from './helpers';

interface Page<T> {
  items: T[];
}

/**
 * The whole business in one story, with two people in two browsers: a customer signs up, staff sell them a
 * subscription and run billing, the customer sees what they owe, staff record the payment, and the customer and the
 * finance dashboard both move. It is the path money takes through the system.
 */
test('a new customer is billed and pays, and what they see and what finance sees both follow', async ({ browser, baseURL }) => {
  const stamp = Date.now();
  const email = `e2e.${stamp}@customer.example`;
  const base = baseURL!;
  const customer = await browser.newContext({ baseURL: base });
  const staff = await browser.newContext({ baseURL: base });
  const me = await customer.newPage();

  // 1. The customer signs up and lands on an overview with nothing owing.
  await me.goto('/signup');
  await me.getByLabel('Full name').fill('Ria Verma');
  await me.getByLabel('Company (optional)').fill(`Verma Traders ${stamp}`);
  await me.getByLabel('Email').fill(email);
  await me.getByLabel('Password', { exact: true }).fill(STRONG_PASSWORD);
  await me.getByRole('button', { name: 'Create account' }).click();
  await expect(me.getByRole('heading', { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Ria$/);
  await expect(me.getByText('You are all paid up')).toBeVisible();

  // 2. Staff sell them a subscription and run billing (set up through the API: the screens for this are covered elsewhere).
  const api = await apiAs(base, STAFF);
  const found = await ok<Page<{ id: number }>>(await api.get(`/api/customers?q=${encodeURIComponent(email)}`));
  expect(found.items).toHaveLength(1);
  const plans = await ok<Page<{ id: number; name: string; minQuantity: number }>>(await api.get('/api/plans?q=Starter%20Monthly'));
  const plan = plans.items.find((p) => p.name === 'Starter Monthly')!;
  const products = await ok<Page<{ id: number; name: string }>>(await api.get('/api/products?q=Brightloop%20CRM'));
  const product = products.items.find((p) => p.name === 'Brightloop CRM')!;
  const created = await ok<{ subscription: { id: number; number: string } }>(
    await api.post('/api/subscriptions', {
      data: { customerId: found.items[0]!.id, planId: plan.id, startDate: isoDate(), expiryDate: isoDate(365), lines: [{ productId: product.id, quantity: plan.minQuantity }] },
    }),
  );
  const sub = created.subscription;
  for (const action of ['send_quote', 'confirm', 'activate']) await ok(await api.post(`/api/subscriptions/${sub.id}/actions/${action}`, { data: {} }));
  const run = await ok<{ run: { created: { subscriptionNumber: string }[]; failed: unknown[] } }>(await api.post('/api/billing/run', { data: { confirm: true } }));
  expect(run.run.failed).toEqual([]);
  expect(run.run.created.map((i) => i.subscriptionNumber)).toContain(sub.number);
  const invoices = await ok<Page<{ id: number; number: string; total: number; status: string }>>(await api.get(`/api/invoices?subscriptionId=${sub.id}`));
  expect(invoices.items).toHaveLength(1);
  const invoice = invoices.items[0]!;
  expect(invoice.status).toBe('confirmed');
  expect(invoice.total).toBeGreaterThan(0);

  // 3. The customer reloads and sees the invoice, what they owe and the subscription.
  await me.reload();
  await expect(me.getByRole('heading', { name: 'Your next invoice is due' })).toBeVisible();
  await expect(me.getByRole('link', { name: invoice.number }).first()).toBeVisible();
  await expect(me.locator('.kpi', { hasText: 'You owe' })).toContainText(inr(invoice.total));
  await expect(me.locator('.kpi', { hasText: 'Active subscriptions' })).toContainText('1');
  await expect(me.getByRole('link', { name: sub.number })).toBeVisible();

  // 4. Staff open the invoice in the browser and record the payment in full.
  const collectedBefore = (await ok<{ revenue: { collected: number } }>(await api.get('/api/dashboard'))).revenue.collected;
  const desk = await staff.newPage();
  await signIn(desk, STAFF);
  await desk.goto(`/invoices/${invoice.id}`);
  await expect(desk.getByRole('heading', { level: 1 })).toContainText(invoice.number);
  await desk.getByRole('button', { name: 'Record payment' }).click();
  const dialog = desk.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Record payment for ${invoice.number}` })).toBeVisible();
  await dialog.getByRole('button', { name: /Pay in full/ }).click();
  await expect(dialog.getByText('This clears the invoice.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  await expect(desk.getByText(/^Paid in full on /)).toBeVisible();

  // 5. The customer's overview now says they are paid up, with the payment counted.
  await me.reload();
  await expect(me.getByText('You are all paid up')).toBeVisible();
  await expect(me.locator('.kpi', { hasText: 'Paid to date' })).toContainText(inr(invoice.total));

  // 6. And finance's dashboard counted the money, once.
  const collectedAfter = (await ok<{ revenue: { collected: number } }>(await api.get('/api/dashboard'))).revenue.collected;
  expect(collectedAfter - collectedBefore).toBeCloseTo(invoice.total, 2);

  // 7. Paying again is refused: the invoice is settled.
  const again = await api.post(`/api/invoices/${invoice.id}/payments`, { data: { amount: 1, method: 'cash' } });
  expect(again.status()).toBe(409);
  expect(await again.text()).toContain('already paid in full');

  await customer.close();
  await staff.close();
  await api.dispose();
});

test('staff can see the dashboard follow a payment made elsewhere, without reloading the page', async ({ page, baseURL }) => {
  const api = await apiAs(baseURL!, ADMIN);
  const owing = await ok<Page<{ id: number; balance: number }>>(await api.get('/api/invoices?status=outstanding&pageSize=1'));
  test.skip(owing.items.length === 0, 'The demo data has no invoice with a balance to pay.');
  const invoice = owing.items[0]!;
  const amount = Math.min(invoice.balance, 1);

  await signIn(page, ADMIN);
  const collected = page.locator('.kpi', { hasText: 'Collected in period' });
  await expect(collected).toBeVisible();
  // textContent, because that is what toHaveText compares (innerText puts line breaks in, so it could never match)
  const before = (await collected.textContent())!;
  expect(before).toContain('Collected in period');

  await ok(await api.post(`/api/invoices/${invoice.id}/payments`, { data: { amount, method: 'cash', note: 'recorded by an end-to-end test' } }));
  await page.getByRole('button', { name: 'Refresh now' }).click();
  await expect(collected).not.toHaveText(before);
  expect(await collected.textContent()).not.toBe(before);
  await api.dispose();
});
