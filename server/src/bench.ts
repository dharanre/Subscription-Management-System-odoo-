import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { get, migrate, openDb } from './db.js';
import { addDays } from './lib/dates.js';
import { MemoryMailer } from './lib/mailer.js';
import { today } from './lib/money.js';
import { DEMO_PASSWORD } from './seed.js';

/**
 * Times every API call behind every screen against a database (`npm run bench`), as staff and as the customer with
 * the most subscriptions. It starts the real application in this process, so the numbers include routing,
 * authentication, validation, the queries and JSON encoding; they leave out the browser's own rendering.
 *
 *   npm run bench -w server -- --db=path/to/load.db --runs=7 --budget=2000
 *
 * Without --db it uses `load.db` beside the normal database (where `seed:load` writes by default), never the
 * development database itself. Exits with an error if any call's slowest run is over the budget (milliseconds).
 */

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=') as [string, string]),
);
const RUNS = Number(args.runs ?? 7);
const BUDGET = Number(args.budget ?? 2000);
const config = { ...loadConfig(), rateLimit: false, devMailbox: false };
const db = openDb(args.db ?? path.join(path.dirname(config.dbPath), 'load.db'));
migrate(db);

const app = createApp({ config, db, mailer: new MemoryMailer() });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  if (!res.ok) throw new Error(`Could not sign in as ${email}: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const count = (sql: string, ...p: (string | number)[]) => get<{ n: number }>(db, sql, ...p)!.n;
const first = <T>(sql: string, ...p: (string | number)[]) => get<T>(db, sql, ...p);
const sixMonthsAgo = addDays(today(), -180);

// A subscription and an invoice from the middle of the data, and a customer name to search for.
const midSub = first<{ id: number }>(`SELECT id FROM subscriptions WHERE status = 'active' ORDER BY id LIMIT 1 OFFSET ${Math.floor(count(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'`) / 2)}`)?.id ?? 1;
const midInvoice = first<{ id: number }>(`SELECT id FROM invoices ORDER BY id LIMIT 1 OFFSET ${Math.floor(count('SELECT COUNT(*) AS n FROM invoices') / 2)}`)?.id ?? 1;
const someCustomer = first<{ company: string }>(`SELECT company FROM customers WHERE company LIKE 'Customer %' ORDER BY id LIMIT 1 OFFSET 400`)?.company ?? 'Customer';
const someInvoiceNo = first<{ number: string }>('SELECT number FROM invoices ORDER BY id LIMIT 1 OFFSET 1000')?.number ?? 'INV-00001';
const lastSubPage = Math.max(1, Math.ceil(count('SELECT COUNT(*) AS n FROM subscriptions') / 10) - 1);
const lastInvoicePage = Math.max(1, Math.ceil(count('SELECT COUNT(*) AS n FROM invoices') / 10) - 1);

const enc = encodeURIComponent;
const staffChecks: [string, string][] = [
  ['Dashboard', '/api/dashboard'],
  ['Dashboard (6 months)', `/api/dashboard?from=${sixMonthsAgo}&to=${today()}`],
  ['Subscriptions: counts', '/api/subscriptions/counts'],
  ['Subscriptions: first page', '/api/subscriptions?pageSize=10'],
  ['Subscriptions: active filter', '/api/subscriptions?status=active&pageSize=10'],
  ['Subscriptions: search', `/api/subscriptions?q=${enc(someCustomer)}`],
  ['Subscriptions: last page', `/api/subscriptions?pageSize=10&page=${lastSubPage}`],
  ['Subscriptions: date range', `/api/subscriptions?from=${sixMonthsAgo}&to=${today()}&pageSize=10`],
  ['Subscription detail', `/api/subscriptions/${midSub}`],
  ['Invoices: counts', '/api/invoices/counts'],
  ['Invoices: first page', '/api/invoices?pageSize=10'],
  ['Invoices: overdue, longest first', '/api/invoices?status=overdue&sort=due&pageSize=10'],
  ['Invoices: outstanding', '/api/invoices?status=outstanding&pageSize=10'],
  ['Invoices: search by number', `/api/invoices?q=${enc(someInvoiceNo)}`],
  ['Invoices: search by customer', `/api/invoices?q=${enc(someCustomer)}`],
  ['Invoices: last page', `/api/invoices?pageSize=10&page=${lastInvoicePage}`],
  ['Invoice detail', `/api/invoices/${midInvoice}`],
  ['Payments: first page', '/api/payments?pageSize=12'],
  ['Payments: by method', '/api/payments?method=upi&pageSize=12'],
  ['Payments: date range', `/api/payments?from=${sixMonthsAgo}&to=${today()}&pageSize=12`],
  ['Payments: search', `/api/payments?q=${enc(someCustomer)}`],
  ['Receivables: summary', '/api/receivables/summary'],
  ['Billing: what is due', '/api/billing/due?pageSize=8'],
  ['Billing: runs', '/api/billing/runs?pageSize=6'],
  ['Billing: failures', '/api/billing/failures?pageSize=20'],
  ['Customers: first page', '/api/customers?pageSize=10'],
  ['Customers: search', `/api/customers?q=${enc(someCustomer)}`],
  ['Products', '/api/products?pageSize=10'],
  ['Plans', '/api/plans?pageSize=10'],
  ['Discounts', '/api/discounts?pageSize=10'],
  ['Quotation templates', '/api/quotation-templates?pageSize=10'],
  ['Team', '/api/users?pageSize=10'],
];
const customerChecks: [string, string][] = [
  ['Portal: summary', '/api/portal/summary'],
  ['Portal: my subscriptions', '/api/subscriptions?pageSize=10'],
  ['Portal: subscription counts', '/api/subscriptions/counts'],
  ['Portal: my invoices', '/api/invoices?pageSize=10'],
  ['Portal: invoice counts', '/api/invoices/counts'],
  ['Portal: my payments', '/api/payments?pageSize=12'],
];

interface Result {
  name: string;
  p50: number;
  max: number;
  status: number;
  bytes: number;
}

async function measure(cookie: string, name: string, path: string): Promise<Result> {
  const times: number[] = [];
  let status = 0;
  let bytes = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const res = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
    const body = await res.arrayBuffer();
    times.push(performance.now() - t0);
    status = res.status;
    bytes = body.byteLength;
  }
  times.sort((a, b) => a - b);
  return { name, p50: times[Math.floor(times.length / 2)]!, max: times.at(-1)!, status, bytes };
}

const table = (title: string, rows: Result[]) => {
  console.log(`\n${title}`);
  console.log(`${'call'.padEnd(36)} ${'status'.padStart(6)} ${'median'.padStart(9)} ${'slowest'.padStart(9)} ${'size'.padStart(9)}`);
  for (const r of rows) {
    const flag = r.max > BUDGET ? '  <-- over budget' : r.status >= 400 ? '  <-- error' : '';
    console.log(`${r.name.padEnd(36)} ${String(r.status).padStart(6)} ${`${r.p50.toFixed(1)} ms`.padStart(9)} ${`${r.max.toFixed(1)} ms`.padStart(9)} ${`${(r.bytes / 1024).toFixed(1)} kB`.padStart(9)}${flag}`);
  }
};

const rows = (n: string) => `${count(`SELECT COUNT(*) AS n FROM ${n}`)} ${n}`;
console.log(`Benchmark: ${[rows('subscriptions'), rows('invoices'), rows('payments'), rows('customers')].join(', ')}; ${RUNS} runs per call, budget ${BUDGET} ms`);

const staffCookie = await login('admin@brightloop.example');
const staff: Result[] = [];
for (const [name, path] of staffChecks) staff.push(await measure(staffCookie, name, path));
table('Staff', staff);

const portalUser = first<{ email: string }>(`SELECT email FROM users WHERE email = 'bigcustomer@brightloop.example'`) ?? first<{ email: string }>(`SELECT email FROM users WHERE role = 'customer' ORDER BY id LIMIT 1`);
const portal: Result[] = [];
if (portalUser) {
  const cookie = await login(portalUser.email);
  for (const [name, path] of customerChecks) portal.push(await measure(cookie, name, path));
  table(`Customer portal (${portalUser.email})`, portal);
} else {
  console.log('\nNo customer account to measure the portal with.');
}

const all = [...staff, ...portal];
const slowest = all.reduce((a, b) => (b.max > a.max ? b : a));
const failures = all.filter((r) => r.max > BUDGET || r.status >= 400);
console.log(`\nSlowest call: ${slowest.name} at ${slowest.max.toFixed(1)} ms. ${failures.length === 0 ? `All ${all.length} calls were within the ${BUDGET} ms budget.` : `${failures.length} call(s) failed the budget or returned an error.`}`);

server.close();
db.close();
process.exit(failures.length === 0 ? 0 : 1);
