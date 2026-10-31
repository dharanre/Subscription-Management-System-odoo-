import path from 'node:path';
import { loadConfig } from './config.js';
import { type DB, all, get, migrate, openDb, run, transaction } from './db.js';
import { runBilling } from './lib/billing.js';
import { addDays } from './lib/dates.js';
import { hashPassword } from './lib/password.js';
import type { PaymentMethod } from './lib/paymentRows.js';
import { recordPayment } from './lib/payments.js';
import { applyAction, createSubscription } from './lib/subscriptions.js';
import { DEMO_PASSWORD, seedAccounts, seedCatalog, seedPaymentTerms } from './seed.js';

/**
 * Builds a large, realistic database to measure performance against (`npm run seed:load`). Everything goes
 * through the same service code the API uses, so the result is data the application could really have
 * produced. Every record is flagged as demo data. Not for production: it refuses to run there.
 *
 *   npm run seed:load -w server -- --subscriptions=5000 --db=path/to/load.db
 *
 * Without --db it writes `load.db` beside the normal database, so the development data is never filled with load data
 * by accident.
 */

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=') as [string, string]),
);
const TOTAL = Number(args.subscriptions ?? 5000);
const config = loadConfig();
if (config.nodeEnv === 'production') throw new Error('Refusing to generate load data in a production environment.');
const dbPath = args.db ?? path.join(path.dirname(config.dbPath), 'load.db');

/** A small seeded random number generator, so a given size always produces the same data. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(Number(args.seed ?? 42));
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
function pick<T>(weighted: [T, number][]): T {
  let r = rand() * weighted.reduce((n, [, w]) => n + w, 0);
  for (const [v, w] of weighted) if ((r -= w) <= 0) return v;
  return weighted[0]![0];
}
const todayIso = new Date().toISOString().slice(0, 10);

type Fate = 'active' | 'paused' | 'closed' | 'cancelled' | 'quotation' | 'draft' | 'confirmed';

async function main() {
  const started = Date.now();
  const db: DB = openDb(dbPath);
  migrate(db);
  // This is a throwaway benchmark database, so skip waiting for the disk after every commit.
  db.exec('PRAGMA synchronous = OFF');

  await seedAccounts(db, config.bcryptCost);
  seedCatalog(db);
  seedPaymentTerms(db);
  const admin = get<{ id: number }>(db, `SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)!.id;

  // customers
  const customerCount = Math.max(20, Math.round(TOTAL / 2.5));
  const customers: number[] = [];
  transaction(db, () => {
    for (let i = 1; i <= customerCount; i++) {
      const n = String(i).padStart(5, '0');
      customers.push(run(db, 'INSERT INTO customers (name, email, company, is_demo) VALUES (?, ?, ?, 1)', `Contact ${n}`, `c${n}@load.example`, `Customer ${n} Ltd`).lastInsertRowid);
    }
  });

  // one customer with a portal login and a lot of subscriptions, to measure the portal at its heaviest
  const bigPassword = await hashPassword(DEMO_PASSWORD, config.bcryptCost);
  run(db, `INSERT OR IGNORE INTO users (email, password_hash, name, role, is_demo) VALUES ('bigcustomer@brightloop.example', ?, 'Big Customer (demo)', 'customer', 1)`, bigPassword);
  const bigUserId = get<{ id: number }>(db, `SELECT id FROM users WHERE email = 'bigcustomer@brightloop.example'`)!.id;
  run(db, 'UPDATE customers SET user_id = ? WHERE id = ?', bigUserId, customers[0]!);

  const planOf = (name: string) => get<{ id: number; min_quantity: number; allow_pause: number; allow_early_close: number }>(db, 'SELECT id, min_quantity, allow_pause, allow_early_close FROM plans WHERE name = ?', name)!;
  const productId = (name: string) => get<{ id: number }>(db, 'SELECT id FROM products WHERE name = ?', name)!.id;
  const [CRM, HELPDESK, SUPPORT] = [productId('Brightloop CRM'), productId('Brightloop Helpdesk'), productId('Priority support')];
  const plans = [
    { plan: planOf('Starter Monthly'), weight: 30, back: 110 },
    { plan: planOf('Business Monthly'), weight: 30, back: 110 },
    { plan: planOf('Business Yearly'), weight: 12, back: 115 },
    { plan: planOf('Enterprise Yearly'), weight: 4, back: 115 },
    { plan: planOf('Weekly Trial'), weight: 14, back: 50 },
    { plan: planOf('Daily Event Pass'), weight: 10, back: 8 },
  ];
  const fates: [Fate, number][] = [['active', 70], ['paused', 7], ['closed', 6], ['cancelled', 4], ['quotation', 5], ['draft', 4], ['confirmed', 4]];
  const steps: Record<Fate, ('send_quote' | 'confirm' | 'activate' | 'cancel')[]> = {
    active: ['send_quote', 'confirm', 'activate'],
    paused: ['send_quote', 'confirm', 'activate'],
    closed: ['send_quote', 'confirm', 'activate'],
    cancelled: ['send_quote', 'cancel'],
    quotation: ['send_quote'],
    draft: [],
    confirmed: ['send_quote', 'confirm'],
  };

  console.log(`[load] creating ${TOTAL} subscriptions for ${customerCount} customers...`);
  const staff = { kind: 'staff' as const, userId: admin };
  const later: { id: number; fate: Fate }[] = [];
  const BATCH = 500;
  for (let from = 0; from < TOTAL; from += BATCH) {
    transaction(db, () => {
      for (let i = from; i < Math.min(TOTAL, from + BATCH); i++) {
        const choice = pick(plans.map((p) => [p, p.weight] as [(typeof plans)[number], number]));
        let fate = pick(fates);
        // plans decide whether they can be paused or closed early, so the others just stay active
        if ((fate === 'paused' && !choice.plan.allow_pause) || (fate === 'closed' && !choice.plan.allow_early_close)) fate = 'active';
        const qty = choice.plan.min_quantity + between(0, 8);
        const lines = [{ productId: rand() < 0.6 ? CRM : HELPDESK, quantity: qty }, ...(rand() < 0.3 ? [{ productId: SUPPORT, quantity: choice.plan.min_quantity }] : [])];
        const id = createSubscription(db, {
          customerId: i % 25 === 0 ? customers[0]! : customers[between(1, customers.length - 1)]!,
          planId: choice.plan.id,
          startDate: addDays(todayIso, -between(0, choice.back)),
          lines,
          createdBy: admin,
          isDemo: true,
        });
        for (const a of steps[fate]) applyAction(db, id, a, staff);
        if (fate === 'paused' || fate === 'closed') later.push({ id, fate });
      }
    });
    console.log(`[load]   ${Math.min(TOTAL, from + BATCH)} subscriptions`);
  }

  console.log('[load] billing every subscription that is due...');
  const billed = await runBilling(db, { confirm: true, triggeredBy: admin, isDemo: true });
  console.log(`[load]   ${billed.created.length} invoices from ${billed.due} subscriptions (${billed.failed.length} failed)`);

  // now that they are billed up to date, some are paused or closed, which billing would otherwise refuse
  for (const l of later) applyAction(db, l.id, l.fate === 'paused' ? 'pause' : 'close', staff);

  // billing ran today, so date each invoice on its period's first day and let it fall due by its terms
  run(
    db,
    `UPDATE invoices SET issue_date = period_start,
            due_date = date(period_start, '+' || COALESCE((SELECT t.days_due FROM subscriptions s JOIN payment_terms t ON t.id = s.payment_terms_id WHERE s.id = invoices.subscription_id), 0) || ' days')
      WHERE is_demo = 1`,
  );

  console.log('[load] recording payments...');
  const methods: PaymentMethod[] = ['bank_transfer', 'upi', 'card', 'cheque', 'cash'];
  const invoices = all<{ id: number; issue_date: string; due_date: string; total_minor: number }>(db, `SELECT id, issue_date, due_date, total_minor FROM invoices WHERE status = 'confirmed' ORDER BY id`);
  let paid = 0;
  const PAY_BATCH = 2000;
  for (let from = 0; from < invoices.length; from += PAY_BATCH) {
    transaction(db, () => {
      invoices.slice(from, from + PAY_BATCH).forEach((inv, k) => {
        const n = from + k;
        const outcome = rand();
        if (outcome > 0.82 || inv.total_minor === 0) return; // left unpaid: some of these end up overdue
        const wanted = addDays(inv.due_date, -between(0, 6));
        const paidOn = wanted < inv.issue_date ? inv.issue_date : wanted > todayIso ? todayIso : wanted;
        const partial = outcome > 0.72;
        recordPayment(db, inv.id, { amountMinor: partial ? Math.floor(inv.total_minor / 2) : inv.total_minor, method: methods[n % methods.length]!, paidOn, isDemo: true }, admin);
        paid += 1;
      });
    });
  }
  console.log(`[load]   ${paid} payments`);

  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('ANALYZE');
  const count = (t: string) => get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t}`)!.n;
  console.log(`[load] done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${count('customers')} customers, ${count('subscriptions')} subscriptions, ${count('invoices')} invoices, ${count('payments')} payments`);
  console.log(`[load] portal login with many subscriptions: bigcustomer@brightloop.example / ${DEMO_PASSWORD}`);
  db.close();
}

main().catch((err) => {
  console.error('[load] failed:', err);
  process.exit(1);
});
