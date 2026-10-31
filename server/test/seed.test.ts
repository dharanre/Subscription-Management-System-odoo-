import { describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db.js';
import { seedAccounts, seedCatalog, seedSubscriptions } from '../src/seed.js';
import { ADMIN, STAFF, buildTestApp, loginAs } from './helpers.js';

describe('demo seed', () => {
  it('is repeatable: a second run creates nothing and duplicates nothing', async () => {
    const t = await buildTestApp();
    const first = seedCatalog(t.db);
    expect(first).toEqual({ taxes: 2, products: 6, plans: 6, discounts: 3 });
    const counts = () => all<{ n: number }>(t.db, 'SELECT (SELECT COUNT(*) FROM products) + (SELECT COUNT(*) FROM plans) + (SELECT COUNT(*) FROM discounts) + (SELECT COUNT(*) FROM product_variants) + (SELECT COUNT(*) FROM discount_products) AS n')[0]!.n;
    const before = counts();

    expect(seedCatalog(t.db)).toEqual({ taxes: 0, products: 0, plans: 0, discounts: 0 });
    expect((await seedAccounts(t.db, 4)).created).toBe(0);
    expect(counts()).toBe(before);
  });

  it('labels every seeded record as demo data', async () => {
    const t = await buildTestApp();
    seedCatalog(t.db);
    for (const table of ['users', 'taxes', 'products', 'plans', 'discounts']) {
      expect(get<{ n: number }>(t.db, `SELECT COUNT(*) AS n FROM ${table} WHERE is_demo = 0`)!.n, table).toBe(0);
    }
  });

  it('does not overwrite edits an admin has made to seeded records', async () => {
    const t = await buildTestApp();
    seedCatalog(t.db);
    run(t.db, `UPDATE products SET sales_price_minor = 1 WHERE name = 'Brightloop CRM'`);
    seedCatalog(t.db);
    expect(get<{ p: number }>(t.db, `SELECT sales_price_minor AS p FROM products WHERE name = 'Brightloop CRM'`)!.p).toBe(1);
  });

  it('leaves an admin-chosen default tax alone', async () => {
    const t = await buildTestApp();
    const admin = await loginAs(t, ADMIN);
    await admin.post('/api/taxes').send({ name: 'My tax', ratePercent: 7, isDefault: true });
    seedCatalog(t.db);
    expect(all<{ name: string }>(t.db, 'SELECT name FROM taxes WHERE is_default = 1')).toMatchObject([{ name: 'My tax' }]);
  });

  it('produces data the pricing engine can use end to end, including a lapsed discount', async () => {
    const t = await buildTestApp();
    seedCatalog(t.db);
    const staff = await loginAs(t, STAFF);

    const products = (await staff.get('/api/products?q=CRM')).body.items as { id: number; variants: { id: number; value: string }[] }[];
    const crm = products[0]!;
    const odoo = crm.variants.find((v) => v.value === 'Odoo')!;
    const plan = ((await staff.get('/api/plans?q=Business%20Monthly')).body.items as { id: number }[])[0]!;

    const res = await staff.post('/api/pricing/preview').send({ planId: plan.id, lines: [{ productId: crm.id, variantId: odoo.id, quantity: 10 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 1200 + 560 per seat, ten seats; the 10+ seats volume rule qualifies, the ended spring promotion does not
    expect(res.body.lines.find((l: { kind: string }) => l.kind === 'product').unitPrice).toBe(1760);
    expect(res.body.discount.applied.name).toBe('Volume: 10+ seats');
    const spring = res.body.discount.considered.find((c: { name: string }) => c.name.startsWith('Spring'));
    expect(spring).toMatchObject({ applies: false });
    expect(spring.reason).toMatch(/Expired/);

    const expired = (await staff.get('/api/discounts?status=expired')).body.items as { name: string }[];
    expect(expired.map((d) => d.name)).toEqual(['Spring promotion (ended)']);
  });

  it('seeds customers, templates and subscriptions in every lifecycle state, and is repeatable', async () => {
    const t = await buildTestApp();
    seedCatalog(t.db);
    expect(await seedSubscriptions(t.db, 4)).toEqual({ customers: 8, templates: 3, subscriptions: 11 });
    expect(await seedSubscriptions(t.db, 4)).toEqual({ customers: 0, templates: 0, subscriptions: 0 });
    expect(get<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM subscriptions')!.n).toBe(11);

    const staff = await loginAs(t, STAFF);
    expect((await staff.get('/api/subscriptions/counts')).body.counts).toEqual({ draft: 1, quotation: 2, confirmed: 1, active: 3, paused: 1, closed: 3 });

    const all = (await staff.get('/api/subscriptions?pageSize=50')).body.items as { customer: { company: string }; status: string; closeReason: string | null; quoteExpired: boolean }[];
    expect(all.find((s) => s.customer.company === 'Blue Kite Learning')).toMatchObject({ status: 'closed', closeReason: 'expired' }); // closed itself at plan end
    expect(all.filter((s) => s.quoteExpired)).toHaveLength(1);
    expect(all.filter((s) => s.status === 'closed').map((s) => s.closeReason).sort()).toEqual(['cancelled', 'closed_early', 'expired']);
  });

  it('gives the demo portal customer exactly their own subscription', async () => {
    const t = await buildTestApp();
    seedCatalog(t.db);
    await seedSubscriptions(t.db, 4);
    const portal = await loginAs(t, 'customer@brightloop.example');
    const mine = (await portal.get('/api/subscriptions')).body;
    expect(mine.total).toBe(1);
    expect(mine.items[0].customer.company).toBe('Maple Street Bakery');
    const someoneElses = get<{ id: number }>(t.db, `SELECT s.id FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE c.company = 'Harbor Light Dental'`)!.id;
    expect((await portal.get(`/api/subscriptions/${someoneElses}`)).status).toBe(404);
  });

  it('gives running subscriptions a real billing history and leaves exactly the right ones due', async () => {
    const t = await buildTestApp();
    seedCatalog(t.db);
    await seedSubscriptions(t.db, 4);
    const staff = await loginAs(t, STAFF);

    // made by the real billing code and issued, so the invoice list is not empty on day one
    const issued = all<{ status: string; is_demo: number; total_minor: number; paid_minor: number }>(t.db, 'SELECT status, is_demo, total_minor, paid_minor FROM invoices');
    expect(issued.length).toBeGreaterThanOrEqual(5);
    expect(issued.every((i) => i.is_demo === 1 && (i.status === 'confirmed' || i.status === 'paid'))).toBe(true);
    expect(all(t.db, 'SELECT subscription_id, period_index FROM invoices GROUP BY 1, 2 HAVING COUNT(*) > 1')).toHaveLength(0);

    // with a payment history: some paid in full, some part-paid, some untouched, and some of those overdue
    expect(issued.some((i) => i.status === 'paid' && i.paid_minor === i.total_minor)).toBe(true);
    expect(issued.some((i) => i.status === 'confirmed' && i.paid_minor > 0 && i.paid_minor < i.total_minor)).toBe(true);
    expect(issued.some((i) => i.status === 'confirmed' && i.paid_minor === 0)).toBe(true);
    for (const inv of all<{ id: number; paid_minor: number }>(t.db, 'SELECT id, paid_minor FROM invoices')) {
      const sum = get<{ s: number | null }>(t.db, `SELECT SUM(amount_minor) AS s FROM payments WHERE invoice_id = ? AND status = 'recorded'`, inv.id)!.s ?? 0;
      expect(inv.paid_minor).toBe(sum);
    }
    const overdue = (await staff.get('/api/invoices?status=overdue&sort=due')).body.items as { daysOverdue: number }[];
    expect(overdue.length).toBeGreaterThanOrEqual(2);
    expect(overdue[0]!.daysOverdue).toBeGreaterThanOrEqual(overdue.at(-1)!.daysOverdue);

    // the three subscriptions that just started are waiting for billing day; the paused, closed and trial ones are not
    const due = (await staff.get('/api/billing/due')).body;
    expect(due.subscriptionsDue).toBe(3);
    expect(due.items.map((i: { customer: string }) => i.customer).sort()).toEqual(['Harbor Light Dental', 'Maple Street Bakery', 'Riverbend Logistics']);

    const before = issued.length;
    const run1 = (await staff.post('/api/billing/run').send({})).body.run;
    expect(run1.created).toHaveLength(3);
    expect((await staff.post('/api/billing/run').send({})).body.run.created).toHaveLength(0);
    expect(get<{ n: number }>(t.db, 'SELECT COUNT(*) AS n FROM invoices')!.n).toBe(before + 3);
  });
});
