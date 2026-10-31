import { expect, test } from '@playwright/test';
import { ADMIN, signIn } from './helpers';

/**
 * The side menu is taller than most laptop screens, so on a short window it has to scroll inside its panel. It once
 * spilled out of the bottom of the dark panel instead, leaving white links on the pale page where nobody could read them.
 */
test.describe('the side menu on a short window', () => {
  test.use({ viewport: { width: 1280, height: 640 } });

  test('stays inside its panel: the menu scrolls, and the brand and account stay in view', async ({ page }) => {
    await signIn(page, ADMIN);
    const panel = page.getByRole('complementary', { name: 'Main navigation' });
    const box = (await panel.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(640);

    // every link can be reached, and once scrolled to, sits inside the panel
    for (const name of ['Dashboard', 'Billing', 'Plans', 'Discounts', 'Price calculator', 'Team']) {
      const link = panel.getByRole('link', { name, exact: true });
      await link.scrollIntoViewIfNeeded();
      const b = (await link.boundingBox())!;
      expect(b.y, `${name} starts inside the panel`).toBeGreaterThanOrEqual(box.y);
      expect(b.y + b.height, `${name} ends inside the panel`).toBeLessThanOrEqual(box.y + box.height);
    }

    // the account and the sign-out button stay pinned at the bottom of the panel, readable
    const account = (await panel.locator('.user-chip').boundingBox())!;
    expect(account.y + account.height).toBeLessThanOrEqual(box.y + box.height + 1);
    await expect(panel.getByRole('button', { name: 'Sign out' })).toBeInViewport();
  });

  test('opens on the page you are on, even when its link is far down the menu', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/team');
    const link = page.getByRole('complementary', { name: 'Main navigation' }).getByRole('link', { name: 'Team', exact: true });
    await expect(link).toBeInViewport();
  });
});
