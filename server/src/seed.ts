import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { type DB, all, get, migrate, openDb, run } from './db.js';
import type { Action } from './lib/lifecycle.js';
import { hashPassword } from './lib/password.js';
import { runBilling } from './lib/billing.js';
import { addDays } from './lib/dates.js';
import { type PaymentMethod } from './lib/paymentRows.js';
import { recordPayment } from './lib/payments.js';
import { applyAction, createSubscription, sweepExpired } from './lib/subscriptions.js';

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

const PORTAL_CUSTOMER_EMAIL = 'customer@brightloop.example';

/**
 * Demo payment terms, customers (one with a portal login), quotation templates and subscriptions in every
 * lifecycle state. Subscriptions are built with the same service code the API uses, so they are
 * exactly what the API could have produced. Skipped entirely if demo subscriptions already exist.
 */
export async function seedSubscriptions(db: DB, bcryptCost: number): Promise<{ customers: number; templates: number; subscriptions: number }> {
  const made = { customers: 0, templates: 0, subscriptions: 0 };
  const idOf = (table: string, name: string) => get<{ id: number }>(db, `SELECT id FROM ${table} WHERE name = ?`, name)?.id ?? null;

  for (const t of [
    { name: 'Immediate payment', days: 0 },
    { name: 'Net 15', days: 15 },
    { name: 'Net 30', days: 30 },
  ]) {
    run(db, 'INSERT OR IGNORE INTO payment_terms (name, days_due, is_demo) VALUES (?, ?, 1)', t.name, t.days);
  }
  run(db, `UPDATE payment_terms SET is_default = 1 WHERE name = 'Net 15' AND NOT EXISTS (SELECT 1 FROM payment_terms WHERE is_default = 1)`);

  const customers = [
    ['Maple Street Bakery', 'Priya Nair', 'accounts@maplestreet.example'],
    ['Harbor Light Dental', 'Daniel Okoye', 'billing@harborlight.example'],
    ['Pinecone Studio', 'Mei Tanaka', 'finance@pinecone.example'],
    ['Riverbend Logistics', 'Carlos Mendes', 'ap@riverbend.example'],
    ['Sunrise Pharmacy', 'Aisha Khan', 'office@sunrise.example'],
    ['Orchid Textiles', 'Lakshmi Rao', 'purchasing@orchid.example'],
    ['Granite Peak Consulting', 'Tom Eriksen', 'hello@granitepeak.example'],
    ['Blue Kite Learning', 'Sofia Rossi', 'team@bluekite.example'],
  ] as const;

  // The first customer can sign in to the portal.
  const passwordHash = await hashPassword(DEMO_PASSWORD, bcryptCost);
  run(db, `INSERT OR IGNORE INTO users (email, password_hash, name, role, is_demo) VALUES (?, ?, ?, 'customer', 1)`, PORTAL_CUSTOMER_EMAIL, passwordHash, 'Priya Nair (demo)');
  const portalUserId = get<{ id: number }>(db, 'SELECT id FROM users WHERE email = ?', PORTAL_CUSTOMER_EMAIL)!.id;

  const customerId: Record<string, number> = {};
  for (const [company, person, email] of customers) {
    const isPortal = company === 'Maple Street Bakery';
    const loginEmail = isPortal ? PORTAL_CUSTOMER_EMAIL : email;
    made.customers += run(
      db,
      'INSERT INTO customers (user_id, name, email, company, is_demo) SELECT ?, ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM customers WHERE email = ?)',
      isPortal ? portalUserId : null,
      person,
      loginEmail,
      company,
      loginEmail,
    ).changes;
    customerId[company] = get<{ id: number }>(db, 'SELECT id FROM customers WHERE email = ?', loginEmail)!.id;
  }

  const product = (name: string) => idOf('products', name)!;
  const variant = (productName: string, value: string) => get<{ id: number }>(db, 'SELECT id FROM product_variants WHERE product_id = ? AND value = ?', product(productName), value)?.id ?? null;
  const CRM = 'Brightloop CRM';
  const HELPDESK = 'Brightloop Helpdesk';

  const templates = [
    { name: 'Small shop starter', plan: 'Starter Monthly', validity: 14, terms: 'Immediate payment', lines: [{ productId: product(CRM), variantId: null, quantity: 1 }, { productId: product('Extra storage (100 GB)'), variantId: null, quantity: 1 }] },
    { name: 'Business team, yearly', plan: 'Business Yearly', validity: 30, terms: 'Net 30', lines: [{ productId: product(CRM), variantId: variant(CRM, 'Odoo'), quantity: 10 }, { productId: product('Priority support'), variantId: null, quantity: 5 }] },
    { name: 'Enterprise rollout', plan: 'Enterprise Yearly', validity: 45, terms: 'Net 30', lines: [{ productId: product(CRM), variantId: variant(CRM, 'Odoo'), quantity: 25 }, { productId: product(HELPDESK), variantId: null, quantity: 25 }] },
  ];
  const templateId: Record<string, number> = {};
  for (const t of templates) {
    made.templates += run(db, 'INSERT OR IGNORE INTO quotation_templates (name, plan_id, validity_days, payment_terms_id, is_demo) VALUES (?, ?, ?, ?, 1)', t.name, idOf('plans', t.plan), t.validity, idOf('payment_terms', t.terms)).changes;
    templateId[t.name] = idOf('quotation_templates', t.name)!;
    if (get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM quotation_template_lines WHERE template_id = ?', templateId[t.name]!)!.n === 0) {
      t.lines.forEach((l, i) => run(db, 'INSERT INTO quotation_template_lines (template_id, position, product_id, variant_id, quantity) VALUES (?, ?, ?, ?, ?)', templateId[t.name]!, i, l.productId, l.variantId, l.quantity));
    }
  }

  if (get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM subscriptions WHERE is_demo = 1')!.n > 0) return made;

  const admin = get<{ id: number }>(db, `SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)?.id ?? null;
  const staff = { kind: 'staff' as const, userId: admin };
  const plan = (name: string) => idOf('plans', name)!;
  const plusDays = (n: number) => dayOffset(n);

  interface Demo {
    customer: string;
    plan: string;
    start: number;
    expiry: number;
    lines?: { productId: number; variantId?: number | null; quantity: number }[];
    template?: string;
    /** Lifecycle steps; 'bill' runs real billing for this subscription (confirming its invoices) before the next step. */
    path: (Action | 'bill')[];
    after?: (id: number) => void;
  }
  const demos: Demo[] = [
    { customer: 'Maple Street Bakery', plan: 'Starter Monthly', start: -3, expiry: 362, lines: [{ productId: product(CRM), quantity: 1 }, { productId: product('Extra storage (100 GB)'), quantity: 1 }], path: ['send_quote', 'confirm', 'activate'] },
    { customer: 'Harbor Light Dental', plan: 'Business Monthly', start: -3, expiry: 362, lines: [{ productId: product(CRM), variantId: variant(CRM, 'Odoo'), quantity: 6 }, { productId: product(HELPDESK), quantity: 6 }], path: ['send_quote', 'confirm', 'activate'] },
    { customer: 'Pinecone Studio', plan: 'Starter Monthly', start: -40, expiry: 325, lines: [{ productId: product(HELPDESK), quantity: 2 }], path: ['send_quote', 'confirm', 'activate', 'bill', 'pause'] },
    { customer: 'Riverbend Logistics', plan: 'Business Yearly', start: -100, expiry: 265, template: 'Business team, yearly', path: ['send_quote', 'confirm', 'activate'] },
    { customer: 'Sunrise Pharmacy', plan: 'Business Monthly', start: 5, expiry: 370, lines: [{ productId: product(CRM), quantity: 5 }], path: ['send_quote', 'confirm'] },
    { customer: 'Orchid Textiles', plan: 'Enterprise Yearly', start: 10, expiry: 375, template: 'Enterprise rollout', path: ['send_quote'] },
    { customer: 'Granite Peak Consulting', plan: 'Starter Monthly', start: 0, expiry: 365, lines: [{ productId: product(HELPDESK), quantity: 1 }], path: [] },
    { customer: 'Blue Kite Learning', plan: 'Weekly Trial', start: -20, expiry: 40, lines: [{ productId: product(HELPDESK), quantity: 1 }], path: ['send_quote', 'confirm', 'activate', 'bill'], after: (id) => run(db, 'UPDATE subscriptions SET expiry_date = ? WHERE id = ?', plusDays(-2), id) },
    { customer: 'Pinecone Studio', plan: 'Starter Monthly', start: -60, expiry: 305, lines: [{ productId: product(CRM), quantity: 1 }], path: ['send_quote', 'confirm', 'activate', 'bill', 'close'] },
    { customer: 'Granite Peak Consulting', plan: 'Business Monthly', start: 0, expiry: 365, lines: [{ productId: product(CRM), quantity: 5 }], path: ['send_quote', 'cancel'] },
    { customer: 'Orchid Textiles', plan: 'Business Monthly', start: 2, expiry: 367, lines: [{ productId: product(HELPDESK), quantity: 5 }], path: ['send_quote'], after: (id) => run(db, 'UPDATE subscriptions SET quote_valid_until = ? WHERE id = ?', plusDays(-3), id) },
  ];

  for (const d of demos) {
    const id = createSubscription(db, {
      customerId: customerId[d.customer]!,
      planId: plan(d.plan),
      templateId: d.template ? templateId[d.template] : null,
      startDate: plusDays(d.start),
      expiryDate: plusDays(d.expiry),
      lines: d.lines,
      notes: 'Demo subscription',
      createdBy: admin,
      isDemo: true,
    });
    for (const step of d.path) {
      if (step === 'bill') await runBilling(db, { subscriptionId: id, confirm: true, triggeredBy: admin, isDemo: true });
      else applyAction(db, id, step, staff);
    }
    d.after?.(id);
    made.subscriptions += 1;
  }
  seedPayments(db, admin);
  sweepExpired(db);
  return made;
}

/**
 * Gives the invoices billing made for the running demo subscriptions a believable payment history. Billing
 * runs on each period's first day, so the invoices are dated then and fall due under their payment terms.
 * Then, in turn: one is paid in full, one is part-paid, one is untouched. That leaves paid, part-paid and
 * overdue invoices to look at. Payments go through the same code the API uses.
 */
function seedPayments(db: DB, actorId: number | null) {
  const methods: PaymentMethod[] = ['bank_transfer', 'upi', 'card', 'cheque', 'cash'];
  const invoices = all<{ id: number; period_start: string; total_minor: number; days_due: number | null }>(
    db,
    `SELECT i.id, i.period_start, i.total_minor, t.days_due FROM invoices i
       JOIN subscriptions s ON s.id = i.subscription_id LEFT JOIN payment_terms t ON t.id = s.payment_terms_id
      WHERE i.is_demo = 1 ORDER BY i.id`,
  );
  const todayIso = dayOffset(0);
  invoices.forEach((inv, n) => {
    const due = addDays(inv.period_start, inv.days_due ?? 0);
    run(db, 'UPDATE invoices SET issue_date = ?, due_date = ? WHERE id = ?', inv.period_start, due, inv.id);
    if (n % 3 === 2) return;
    // paid a few days before it fell due, but never before it was issued or in the future
    const wanted = addDays(due, -3);
    const paidOn = wanted < inv.period_start ? inv.period_start : wanted > todayIso ? todayIso : wanted;
    const full = n % 3 === 0;
    recordPayment(
      db,
      inv.id,
      { amountMinor: full ? inv.total_minor : Math.floor(inv.total_minor / 2), method: methods[n % methods.length]!, paidOn, reference: `DEMO-${String(inv.id).padStart(4, '0')}`, isDemo: true },
      actorId,
    );
  });
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
  const sales = await seedSubscriptions(db, config.bcryptCost);
  db.close();
  console.log(`[seed] demo accounts created: ${accounts.created} (existing records left untouched)`);
  console.log(`[seed] demo catalog created: ${catalog.taxes} taxes, ${catalog.products} products, ${catalog.plans} plans, ${catalog.discounts} discounts`);
  console.log(`[seed] demo sales data created: ${sales.customers} customers, ${sales.templates} templates, ${sales.subscriptions} subscriptions`);
  console.log(`[seed] sign in as admin@, staff@ or customer@brightloop.example with password "${DEMO_PASSWORD}"`);
}

// Only run when executed directly (`npm run seed`), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
