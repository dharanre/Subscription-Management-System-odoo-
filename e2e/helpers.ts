import { type APIRequestContext, type APIResponse, type Page, expect, request } from '@playwright/test';

/** The accounts `npm run seed` creates. */
export const PASSWORD = 'Demo#Pass2026';
export const ADMIN = 'admin@brightloop.example';
export const STAFF = 'staff@brightloop.example';
export const CUSTOMER = 'customer@brightloop.example';

/** A password that satisfies the server's rules, for accounts the tests create. */
export const STRONG_PASSWORD = 'Str0ng#Passw0rd';

export const isoDate = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** Amounts as the app shows them with its default currency and locale (INR, en-IN). */
export const inr = (amount: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount);

/** Reads a JSON response, failing with the status and body when it is not a success. */
export async function ok<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} answered ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** An API client signed in as the given account, for setting things up and checking results without the UI. */
export async function apiAs(baseURL: string, email: string, password = PASSWORD): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL });
  await ok(await api.post('/api/auth/login', { data: { email, password } }));
  return api;
}

/** Signs in through the sign-in form and waits until the app shell is showing. */
export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('complementary', { name: 'Main navigation' })).toBeVisible();
}

/** Console errors and failed API calls seen while a page is used, so a screen that quietly breaks fails the test. */
export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`error: ${e.message}`));
  page.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && problems.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
  return problems;
}

/** How far the page is wider than the screen: anything above zero means sideways scrolling. */
export const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
