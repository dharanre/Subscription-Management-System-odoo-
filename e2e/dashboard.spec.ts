import { expect, test } from '@playwright/test';
import { ADMIN, isoDate, signIn } from './helpers';

test.describe('the finance dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  test('shows the headline figures, the chart, the status mix and the lists', async ({ page }) => {
    for (const label of ['Active subscriptions', 'Recurring revenue', 'Collected in period', 'Still owed', 'Overdue']) {
      await expect(page.locator('.kpi', { hasText: label })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Invoiced and collected' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Subscriptions by status' })).toBeVisible();
    const lists = page.getByRole('region', { name: 'Details' });
    await expect(lists.getByRole('row').nth(1)).toBeVisible();
    await lists.getByRole('tab', { name: 'Invoices' }).click();
    await expect(lists.getByText(/Invoices issued .* to /)).toBeVisible();
    await lists.getByRole('tab', { name: 'Payments' }).click();
    await expect(lists.getByText(/Payments received .* to /)).toBeVisible();
  });

  test('choosing a longer period redraws the chart by month and changes the dates shown', async ({ page }) => {
    const range = page.locator('#trend-title + span');
    const before = await range.innerText();
    const reload = page.waitForResponse((r) => r.url().includes('/api/dashboard?from='));
    await page.getByLabel('Period').selectOption('last180');
    await reload;
    await expect(range).not.toHaveText(before);
    // six months is drawn as a bar per month, so the axis is labelled with months rather than days
    await expect(page.locator('.trend__xaxis')).toContainText(/[A-Z][a-z]{2,4} \d{2}/);
    // 180 days reaches back through six or seven calendar months, never a bar per day
    const bars = await page.locator('.trend__col').count();
    expect(bars).toBeGreaterThanOrEqual(6);
    expect(bars).toBeLessThanOrEqual(7);
  });

  test('a range that ends before it starts is explained instead of showing wrong numbers', async ({ page }) => {
    await page.getByLabel('Period').selectOption('custom');
    await page.getByLabel('From').fill(isoDate(0));
    await page.getByLabel('To').fill(isoDate(-10));
    await expect(page.getByText(/Choose a start date on or before the end date/)).toBeVisible();
  });

  test('each headline figure opens the list behind it, already filtered', async ({ page }) => {
    await page.getByRole('link', { name: /Still owed/ }).click();
    await expect(page).toHaveURL(/\/invoices\?status=outstanding$/);
    await expect(page.getByRole('tab', { name: /Outstanding/ })).toHaveAttribute('aria-selected', 'true');

    await page.goto('/');
    await page.getByRole('link', { name: /^Overdue/ }).click();
    await expect(page).toHaveURL(/\/receivables$/);
  });

  test('the needs-attention chips lead to where the work is done', async ({ page }) => {
    const chips = page.getByLabel('Needs attention').getByRole('link');
    test.skip((await chips.count()) === 0, 'Nothing needs attention in the demo data right now.');
    const first = chips.first();
    const target = await first.getAttribute('href');
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${target!.replace(/[?]/g, '\\?')}$`));
  });
});
