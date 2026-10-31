import { expect, test } from '@playwright/test';
import { ADMIN, CUSTOMER, apiAs, horizontalOverflow, ok, signIn, watchProblems } from './helpers';

/**
 * Opens every screen each role can reach, on a laptop and on a phone, and fails if any of them throws, calls the API
 * and is refused, shows no heading, or is wider than the screen. A quick way to catch a screen that broke quietly.
 */

const STAFF_SCREENS = ['/', '/subscriptions', '/customers', '/templates', '/billing', '/invoices', '/payments', '/receivables', '/products', '/plans', '/taxes', '/discounts', '/calculator', '/team'];
const CUSTOMER_SCREENS = ['/', '/subscriptions', '/invoices'];

const SIZES = [
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
];

async function visit(page: import('@playwright/test').Page, path: string, problems: string[]) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first(), `${path} has a heading`).toBeVisible();
  // let the data the screen asks for arrive (and any failure show up) before judging it
  await page.waitForLoadState('networkidle');
  expect(await horizontalOverflow(page), `${path} scrolls sideways`).toBeLessThanOrEqual(0);
  expect(problems, `${path} had problems`).toEqual([]);
}

for (const size of SIZES) {
  test.describe(`on a ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('staff can open every screen without a problem', async ({ page, baseURL }) => {
      const problems = watchProblems(page);
      await signIn(page, ADMIN);
      for (const path of STAFF_SCREENS) {
        problems.length = 0;
        await visit(page, path, problems);
      }

      // a record's own page: one subscription and one invoice
      const api = await apiAs(baseURL!, ADMIN);
      const sub = (await ok<{ items: { id: number }[] }>(await api.get('/api/subscriptions?pageSize=1&status=active'))).items[0]!;
      const inv = (await ok<{ items: { id: number }[] }>(await api.get('/api/invoices?pageSize=1'))).items[0]!;
      for (const path of [`/subscriptions/${sub.id}`, `/invoices/${inv.id}`]) {
        problems.length = 0;
        await visit(page, path, problems);
      }
      await api.dispose();
    });

    test('a customer can open every screen they have without a problem', async ({ page, baseURL }) => {
      const problems = watchProblems(page);
      await signIn(page, CUSTOMER);
      for (const path of CUSTOMER_SCREENS) {
        problems.length = 0;
        await visit(page, path, problems);
      }

      const api = await apiAs(baseURL!, CUSTOMER);
      const sub = (await ok<{ items: { id: number }[] }>(await api.get('/api/subscriptions?pageSize=1'))).items[0];
      const inv = (await ok<{ items: { id: number }[] }>(await api.get('/api/invoices?pageSize=1'))).items[0];
      for (const path of [sub && `/subscriptions/${sub.id}`, inv && `/invoices/${inv.id}`]) {
        if (!path) continue;
        problems.length = 0;
        await visit(page, path, problems);
      }
      await api.dispose();
    });
  });
}
