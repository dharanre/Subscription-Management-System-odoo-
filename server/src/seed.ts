import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { type DB, get, migrate, openDb, run } from './db.js';
import { hashPassword } from './lib/password.js';

/**
 * Demo accounts for local use. These are fictional, flagged is_demo = 1 in the database, and use
 * a published password, so the seed refuses to run against a production environment.
 */
export const DEMO_PASSWORD = 'Demo#Pass2026';

const DEMO_USERS = [
  { email: 'admin@brightloop.example', name: 'Asha Admin (demo)', role: 'admin' },
  { email: 'staff@brightloop.example', name: 'Sam Staff (demo)', role: 'staff' },
  { email: 'finance@brightloop.example', name: 'Fiona Finance (demo)', role: 'staff' },
] as const;

export async function seedAccounts(db: DB, bcryptCost: number): Promise<{ created: number }> {
  const passwordHash = await hashPassword(DEMO_PASSWORD, bcryptCost);
  let created = 0;
  for (const u of DEMO_USERS) {
    created += run(
      db,
      `INSERT OR IGNORE INTO users (email, password_hash, name, role, is_demo) VALUES (?, ?, ?, ?, 1)`,
      u.email,
      passwordHash,
      u.name,
      u.role,
    ).changes;
  }
  return { created };
}

const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * A believable catalog so every screen has something to show. Everything is flagged is_demo = 1,
 * matched by unique name so re-running never duplicates or overwrites what an admin has edited.
 * Amounts are in minor units (x100). Dates are relative to the day the seed runs.
 */
export function seedCatalog(db: DB): { taxes: number; products: number; plans: number; discounts: number } {
  const made = { taxes: 0, products: 0, plans: 0, discounts: 0 };
  const idOf = (table: string, name: string) => get<{ id: number }>(db, `SELECT id FROM ${table} WHERE name = ?`, name)?.id ?? null;

  for (const t of [
    { name: 'Standard tax', bp: 1800 },
    { name: 'Reduced tax', bp: 500 },
  ]) {
    made.taxes += run(db, 'INSERT OR IGNORE INTO taxes (name, rate_bp, is_demo) VALUES (?, ?, 1)', t.name, t.bp).changes;
  }
  // Only claim the default slot if the admin has not already chosen a default tax.
  run(db, `UPDATE taxes SET is_default = 1 WHERE name = 'Standard tax' AND NOT EXISTS (SELECT 1 FROM taxes WHERE is_default = 1)`);

  const products = [
    { name: 'Brightloop CRM', type: 'software', sales: 120000, cost: 40000, notes: 'Per-seat CRM. Branded builds carry a surcharge.', variants: [['Brand', 'Brightloop', 0], ['Brand', 'Odoo', 56000]] },
    { name: 'Brightloop Helpdesk', type: 'software', sales: 90000, cost: 30000, notes: 'Per-agent ticketing.', variants: [] },
    { name: 'Extra storage (100 GB)', type: 'add_on', sales: 25000, cost: 6000, notes: 'Switch on and off per month.', variants: [] },
    { name: 'Priority support', type: 'add_on', sales: 60000, cost: 20000, notes: '4-hour response during business days.', variants: [] },
    { name: 'Onboarding workshop', type: 'service', sales: 750000, cost: 300000, notes: 'Half-day remote session.', variants: [] },
    { name: 'Brightloop POS terminal', type: 'goods', sales: 1800000, cost: 1200000, notes: 'Countertop terminal.', variants: [['Colour', 'Black', 0], ['Colour', 'White', 50000]] },
  ] as const;
  for (const p of products) {
    made.products += run(
      db,
      'INSERT OR IGNORE INTO products (name, type, sales_price_minor, cost_price_minor, notes, is_demo) VALUES (?, ?, ?, ?, ?, 1)',
      p.name,
      p.type,
      p.sales,
      p.cost,
      p.notes,
    ).changes;
    const id = idOf('products', p.name);
    for (const [attribute, value, extra] of p.variants) {
      run(db, 'INSERT OR IGNORE INTO product_variants (product_id, attribute, value, extra_price_minor) VALUES (?, ?, ?, ?)', id, attribute, value, extra);
    }
  }

  const from = dayOffset(-120);
  const plans = [
    { name: 'Starter Monthly', desc: 'For small shops. Pause or stop any time.', price: 49900, period: 'monthly', minQty: 1, to: null, auto: 0, early: 1, pause: 1, renew: 0 },
    { name: 'Business Monthly', desc: 'Teams of five or more, billed monthly.', price: 149900, period: 'monthly', minQty: 5, to: null, auto: 0, early: 1, pause: 1, renew: 1 },
    { name: 'Business Yearly', desc: 'Annual contract with renewal.', price: 1499000, period: 'yearly', minQty: 5, to: null, auto: 0, early: 0, pause: 0, renew: 1 },
    { name: 'Enterprise Yearly', desc: 'Large companies on yearly contracts.', price: 4999000, period: 'yearly', minQty: 25, to: null, auto: 0, early: 0, pause: 0, renew: 1 },
    { name: 'Weekly Trial', desc: 'Short trial that closes on its own.', price: 9900, period: 'weekly', minQty: 1, to: dayOffset(240), auto: 1, early: 1, pause: 0, renew: 0 },
    { name: 'Daily Event Pass', desc: 'One-day access for events.', price: 2900, period: 'daily', minQty: 1, to: dayOffset(240), auto: 1, early: 0, pause: 0, renew: 0 },
  ] as const;
  for (const p of plans) {
    made.plans += run(
      db,
      `INSERT OR IGNORE INTO plans (name, description, price_minor, billing_period, min_quantity, available_from, available_to,
                                    auto_close, allow_early_close, allow_pause, allow_renewal, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      p.name,
      p.desc,
      p.price,
      p.period,
      p.minQty,
      from,
      p.to,
      p.auto,
      p.early,
      p.pause,
      p.renew,
    ).changes;
  }

  const discounts = [
    { name: 'Volume: 10+ seats', kind: 'percent', value: 1000, scope: 'products', minPurchase: 0, minQty: 10, start: dayOffset(-120), end: null, limit: null, products: ['Brightloop CRM', 'Brightloop Helpdesk'] },
    { name: 'Welcome offer', kind: 'fixed', value: 50000, scope: 'subscription', minPurchase: 300000, minQty: 0, start: dayOffset(-60), end: dayOffset(180), limit: 100, products: [] },
    { name: 'Spring promotion (ended)', kind: 'percent', value: 1500, scope: 'subscription', minPurchase: 0, minQty: 0, start: dayOffset(-200), end: dayOffset(-140), limit: null, products: [] },
  ] as const;
  for (const d of discounts) {
    made.discounts += run(
      db,
      `INSERT OR IGNORE INTO discounts (name, kind, value, scope, min_purchase_minor, min_quantity, start_date, end_date, usage_limit, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      d.name,
      d.kind,
      d.value,
      d.scope,
      d.minPurchase,
      d.minQty,
      d.start,
      d.end,
      d.limit,
    ).changes;
    const id = idOf('discounts', d.name);
    for (const name of d.products) run(db, 'INSERT OR IGNORE INTO discount_products (discount_id, product_id) VALUES (?, ?)', id, idOf('products', name));
  }
  return made;
}

async function main() {
  const config = loadConfig();
  if (config.nodeEnv === 'production') {
    throw new Error('Refusing to seed demo data into a production environment.');
  }
  const db = openDb(config.dbPath);
  migrate(db);
  const accounts = await seedAccounts(db, config.bcryptCost);
  const catalog = seedCatalog(db);
  db.close();
  console.log(`[seed] demo accounts created: ${accounts.created} (existing records left untouched)`);
  console.log(`[seed] demo catalog created: ${catalog.taxes} taxes, ${catalog.products} products, ${catalog.plans} plans, ${catalog.discounts} discounts`);
  console.log(`[seed] sign in as admin@brightloop.example or staff@brightloop.example with password "${DEMO_PASSWORD}"`);
}

// Only run when executed directly (`npm run seed`), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
