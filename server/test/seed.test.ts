import { describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db.js';
import { seedAccounts, seedCatalog } from '../src/seed.js';
import { ADMIN, buildTestApp, loginAs, STAFF } from './helpers.js';

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
});
