import { expect, request, test } from '@playwright/test';
import { ADMIN, CUSTOMER, apiAs, signIn } from './helpers';

test.describe('signing in and out', () => {
  test('a wrong password is refused with a message and nobody is let in', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ADMIN);
    await page.getByLabel('Password', { exact: true }).fill('Not-The-Password1!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('signing out ends the session: the app asks for a sign-in again', async ({ page }) => {
    await signIn(page, ADMIN);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/subscriptions');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('each role lands on its own home screen', async ({ page }) => {
    await signIn(page, ADMIN);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, CUSTOMER);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Good (morning|afternoon|evening),/);
  });
});

test.describe('creating an account', () => {
  test('a weak password is explained and no account is made', async ({ page, baseURL }) => {
    const email = `weak.${Date.now()}@customer.example`;
    await page.goto('/signup');
    await page.getByLabel('Full name').fill('Weak Password');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('short');
    // the rules are listed as the password is typed, and the server enforces them regardless
    await expect(page.getByText('More than 8 characters')).toBeVisible();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('alert').or(page.locator('[aria-invalid="true"]')).first()).toBeVisible();

    const api = await request.newContext({ baseURL });
    const attempt = await api.post('/api/auth/login', { data: { email, password: 'short' } });
    expect(attempt.status()).toBe(401);
    await api.dispose();
  });

  test('an email that is already registered cannot be used again', async ({ page }) => {
    await page.goto('/signup');
    await page.getByLabel('Full name').fill('Copy Cat');
    await page.getByLabel('Email').fill(CUSTOMER);
    await page.getByLabel('Password', { exact: true }).fill('Str0ng#Passw0rd');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('alert').filter({ hasText: /already/i })).toBeVisible();
  });
});

test.describe('who can reach what', () => {
  test('a customer sees none of the staff screens, in the menu or by address', async ({ page }) => {
    await signIn(page, CUSTOMER);
    const nav = page.getByRole('complementary', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'My subscriptions' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'My invoices' })).toBeVisible();
    for (const staffOnly of ['Billing', 'Payments', 'Receivables', 'Customers', 'Products', 'Plans', 'Discounts', 'Team']) {
      await expect(nav.getByRole('link', { name: staffOnly, exact: true })).toHaveCount(0);
    }
    for (const path of ['/team', '/billing', '/receivables', '/customers']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
    }
  });

  test('the server refuses a customer even when the screen is bypassed', async ({ baseURL }) => {
    const api = await apiAs(baseURL!, CUSTOMER);
    for (const path of ['/api/dashboard', '/api/customers', '/api/billing/due', '/api/users', '/api/receivables/summary']) {
      expect((await api.get(path)).status(), path).toBe(403);
    }
    await api.dispose();
  });

  test('a customer cannot open someone else’s invoice or subscription: it simply is not found', async ({ baseURL }) => {
    const admin = await apiAs(baseURL!, ADMIN);
    const mine = await apiAs(baseURL!, CUSTOMER);
    const own = (await (await mine.get('/api/invoices?pageSize=100')).json()) as { items: { id: number }[] };
    const ownIds = new Set(own.items.map((i) => i.id));
    const all = (await (await admin.get('/api/invoices?pageSize=100&status=outstanding')).json()) as { items: { id: number }[] };
    const theirs = all.items.find((i) => !ownIds.has(i.id));
    expect(theirs, 'the demo data should include an invoice that belongs to someone else').toBeTruthy();
    expect((await mine.get(`/api/invoices/${theirs!.id}`)).status()).toBe(404);

    const ownSubs = (await (await mine.get('/api/subscriptions?pageSize=100')).json()) as { items: { id: number }[] };
    const allSubs = (await (await admin.get('/api/subscriptions?pageSize=100')).json()) as { items: { id: number }[] };
    const foreign = allSubs.items.find((s) => !ownSubs.items.some((o) => o.id === s.id));
    expect(foreign).toBeTruthy();
    expect((await mine.get(`/api/subscriptions/${foreign!.id}`)).status()).toBe(404);
    await admin.dispose();
    await mine.dispose();
  });
});
