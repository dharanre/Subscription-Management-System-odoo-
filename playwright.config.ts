import { defineConfig } from '@playwright/test';

// Away from the usual development ports so a running copy of the app never collides with the tests.
const PORT = Number(process.env.E2E_PORT ?? 4317);

/**
 * End-to-end tests drive the production build of the web app in a real browser, against the real API and a
 * throwaway database that `e2e/start.mjs` creates and seeds from scratch on every run (nothing of yours is touched).
 *
 *   npm run e2e                     builds the app, then runs everything
 *   E2E_CHANNEL=chrome npm run e2e  uses the Chrome you already have instead of Playwright's own Chromium
 *
 * The first time, if you have no browser set up for Playwright: `npx playwright install chromium`.
 */
export default defineConfig({
  testDir: 'e2e',
  // One shared database and billing runs that look at every subscription: tests run one after another.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.E2E_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node e2e/start.mjs',
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: { E2E_PORT: String(PORT) },
  },
});
