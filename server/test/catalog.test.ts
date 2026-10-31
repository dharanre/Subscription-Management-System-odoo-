import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/db.js';
import { ADMIN, STAFF, type TestApp, buildTestApp, loginAs, signupCustomer } from './helpers.js';

let t: TestApp;
type Agent = ReturnType<typeof request.agent>;
let admin: Agent;
let staff: Agent;

beforeEach(async () => {
  t = await buildTestApp();
  admin = await loginAs(t, ADMIN);
  staff = await loginAs(t, STAFF);
});

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const longAgo = '2020-01-01';

async function makeTax(name = 'GST 18%', ratePercent = 18, isDefault = true) {
  const res = await admin.post('/api/taxes').send({ name, ratePercent, isDefault });
  expect(res.status).toBe(201);
  return res.body.tax as { id: number };
}
async function makeProduct(over: Record<string, unknown> = {}) {
  const res = await admin.post('/api/products').send({ name: 'CRM Seat', type: 'software', salesPrice: 1000, costPrice: 400, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.product as { id: number; variants: { id: number }[] };
}
async function makePlan(over: Record<string, unknown> = {}) {
  const res = await admin.post('/api/plans').send({ name: 'Pro Monthly', price: 500, billingPeriod: 'monthly', minQuantity: 2, availableFrom: longAgo, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.plan as { id: number };
}

describe('catalog permissions', () => {
  it('lets admin and staff read, and only admin write', async () => {
    for (const path of ['/api/products', '/api/plans', '/api/taxes', '/api/discounts']) {
      expect((await request(t.app).get(path)).status, path).toBe(401);
      expect((await staff.get(path)).status, path).toBe(200);
      expect((await (await signupCustomer(t, `c${path.replace(/\W/g, '')}@shop.example`)).get(path)).status, path).toBe(403);
    }
    expect((await staff.post('/api/products').send({ name: 'X', type: 'goods', salesPrice: 1, costPrice: 1 })).status).toBe(403);
    expect((await staff.post('/api/plans').send({})).status).toBe(403);
    expect((await staff.post('/api/taxes').send({})).status).toBe(403);
  });

  it('keeps discount creation admin-only', async () => {
    const body = { name: 'Bulk', kind: 'percent', value: 10, scope: 'subscription', startDate: longAgo };
    expect((await staff.post('/api/discounts').send(body)).status).toBe(403);
    expect((await admin.post('/api/discounts').send(body)).status).toBe(201);
    const id = (await admin.get('/api/discounts')).body.items[0].id;
    expect((await staff.patch(`/api/discounts/${id}`).send({ isActive: false })).status).toBe(403);
  });
});

describe('products and variants', () => {
  it('stores prices exactly and returns them as plain numbers with variants', async () => {
    const tax = await makeTax();
    const res = await admin.post('/api/products').send({
      name: 'Odoo Hosting',
      type: 'software',
      salesPrice: 1999.99,
      costPrice: 800.5,
      taxId: tax.id,
      notes: 'Demo notes',
      variants: [{ attribute: 'Brand', value: 'Odoo', extraPrice: 560 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.product).toMatchObject({ salesPrice: 1999.99, costPrice: 800.5, taxId: tax.id, notes: 'Demo notes', isActive: true });
    expect(res.body.product.tax).toMatchObject({ name: 'GST 18%', ratePercent: 18 });
    expect(res.body.product.variants).toEqual([expect.objectContaining({ attribute: 'Brand', value: 'Odoo', extraPrice: 560 })]);
  });

  it('validates prices, type, references and uniqueness with field-level errors', async () => {
    const base = { name: 'P', type: 'software', salesPrice: 10, costPrice: 5 };
    const bad = async (over: Record<string, unknown>, field: string, status = 422) => {
      const res = await admin.post('/api/products').send({ ...base, ...over });
      expect(res.status, JSON.stringify(over)).toBe(status);
      expect(res.body.error.fields[field], JSON.stringify(res.body)).toBeTruthy();
    };
    await bad({ salesPrice: -1 }, 'salesPrice');
    await bad({ salesPrice: 1.234 }, 'salesPrice');
    await bad({ salesPrice: '10' }, 'salesPrice');
    await bad({ costPrice: 1e12 }, 'costPrice');
    await bad({ type: 'unicorn' }, 'type');
    await bad({ name: '   ' }, 'name');
    await bad({ taxId: 9999 }, 'taxId');
    await bad({ variants: [{ attribute: 'Brand', value: 'A', extraPrice: -5 }] }, 'variants.0.extraPrice');
    await bad({ variants: [{ attribute: 'Brand', value: 'A', extraPrice: 1 }, { attribute: 'brand', value: 'a', extraPrice: 2 }] }, 'variants.1.value');

    await makeProduct({ name: 'Dup' });
    await bad({ name: 'dup' }, 'name', 409);
  });

  it('rejects an inactive tax on a product', async () => {
    const tax = await makeTax('Old', 5, false);
    await admin.patch(`/api/taxes/${tax.id}`).send({ isActive: false });
    const res = await admin.post('/api/products').send({ name: 'P', type: 'goods', salesPrice: 1, costPrice: 1, taxId: tax.id });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.taxId).toBeTruthy();
  });

  it('adds, edits and deactivates variants; never duplicates an option', async () => {
    const p = await makeProduct();
    const add = await admin.post(`/api/products/${p.id}/variants`).send({ attribute: 'Brand', value: 'Odoo', extraPrice: 560 });
    expect(add.status).toBe(201);
    expect((await admin.post(`/api/products/${p.id}/variants`).send({ attribute: 'brand', value: 'ODOO', extraPrice: 1 })).status).toBe(409);
    const edit = await admin.patch(`/api/products/${p.id}/variants/${add.body.variant.id}`).send({ extraPrice: 600, isActive: false });
    expect(edit.body.variant).toMatchObject({ extraPrice: 600, isActive: false });
    // a variant is addressed through its own product only
    const other = await makeProduct({ name: 'Other' });
    expect((await admin.patch(`/api/products/${other.id}/variants/${add.body.variant.id}`).send({ extraPrice: 1 })).status).toBe(404);
  });

  it('searches, filters and paginates', async () => {
    for (let i = 1; i <= 5; i++) await makeProduct({ name: `Widget ${i}`, type: i % 2 ? 'goods' : 'service' });
    await makeProduct({ name: '100%_Special' });
    const page = await staff.get('/api/products?q=widget&pageSize=2&page=2');
    expect(page.body).toMatchObject({ page: 2, pageSize: 2, total: 5 });
    expect(page.body.items).toHaveLength(2);
    expect((await staff.get('/api/products?type=goods')).body.total).toBe(3);
    // LIKE wildcards in user input are literal
    expect((await staff.get('/api/products?q=%25_')).body.total).toBe(1);
    expect((await staff.get('/api/products?pageSize=1000')).status).toBe(422);
  });

  it('deactivates rather than deletes, and keeps the record', async () => {
    const p = await makeProduct();
    const res = await admin.patch(`/api/products/${p.id}`).send({ isActive: false });
    expect(res.body.product.isActive).toBe(false);
    expect((await staff.get('/api/products?active=true')).body.total).toBe(0);
    expect((await staff.get('/api/products?active=false')).body.total).toBe(1);
  });
});

describe('taxes', () => {
  it('keeps a single default tax', async () => {
    const a = await makeTax('A', 5, true);
    const b = await makeTax('B', 12, true);
    const list = (await staff.get('/api/taxes')).body.items as { id: number; isDefault: boolean }[];
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([b.id]);
    await admin.patch(`/api/taxes/${a.id}`).send({ isDefault: true });
    const after = (await staff.get('/api/taxes')).body.items as { id: number; isDefault: boolean }[];
    expect(after.filter((x) => x.isDefault).map((x) => x.id)).toEqual([a.id]);
  });

  it('validates the rate and name', async () => {
    expect((await admin.post('/api/taxes').send({ name: 'X', ratePercent: 101 })).status).toBe(422);
    expect((await admin.post('/api/taxes').send({ name: 'X', ratePercent: 5.555 })).status).toBe(422);
    expect((await admin.post('/api/taxes').send({ name: '', ratePercent: 5 })).status).toBe(422);
    await makeTax('Same', 5, false);
    expect((await admin.post('/api/taxes').send({ name: 'same', ratePercent: 6 })).status).toBe(409);
  });

  it('refuses to switch off a tax that active products still use', async () => {
    const tax = await makeTax();
    await makeProduct({ taxId: tax.id });
    const res = await admin.patch(`/api/taxes/${tax.id}`).send({ isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('in_use');
  });
});

describe('plans', () => {
  it('stores the billing interval, availability window and lifecycle choices', async () => {
    for (const billingPeriod of ['daily', 'weekly', 'monthly', 'yearly']) {
      const res = await admin.post('/api/plans').send({
        name: `Plan ${billingPeriod}`,
        price: 99.5,
        billingPeriod,
        availableFrom: longAgo,
        availableTo: '2099-12-31',
        autoClose: billingPeriod === 'daily',
        allowPause: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.plan).toMatchObject({ billingPeriod, price: 99.5, minQuantity: 1, allowPause: true, allowRenewal: false, isAvailable: true });
    }
    expect((await staff.get('/api/plans?period=daily')).body.items[0].autoClose).toBe(true);
  });

  it('validates intervals, quantities and dates', async () => {
    const base = { name: 'P', price: 10, billingPeriod: 'monthly', availableFrom: longAgo };
    const bad = async (over: Record<string, unknown>, field: string) => {
      const res = await admin.post('/api/plans').send({ ...base, ...over });
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(res.body.error.fields[field], JSON.stringify(res.body)).toBeTruthy();
    };
    await bad({ billingPeriod: 'fortnightly' }, 'billingPeriod');
    await bad({ minQuantity: 0 }, 'minQuantity');
    await bad({ minQuantity: 1.5 }, 'minQuantity');
    await bad({ price: -5 }, 'price');
    await bad({ availableFrom: '2026-02-30' }, 'availableFrom');
    await bad({ availableFrom: 'tomorrow' }, 'availableFrom');
    await bad({ availableFrom: '2026-06-10', availableTo: '2026-06-09' }, 'availableTo');
    await bad({ autoClose: 'yes' }, 'autoClose');
  });

  it('re-checks the window against stored dates on update', async () => {
    const plan = await makePlan({ availableFrom: '2026-06-01', availableTo: '2026-12-31' });
    const res = await admin.patch(`/api/plans/${plan.id}`).send({ availableTo: '2026-05-01' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.availableTo).toBeTruthy();
    const ok = await admin.patch(`/api/plans/${plan.id}`).send({ availableTo: null, allowRenewal: true });
    expect(ok.body.plan).toMatchObject({ availableTo: null, allowRenewal: true });
  });

  it('reports whether a plan can be sold today', async () => {
    const future = await makePlan({ name: 'Future', availableFrom: tomorrow() });
    const ended = await makePlan({ name: 'Ended', availableFrom: longAgo, availableTo: yesterday() });
    expect((await staff.get(`/api/plans/${future.id}`)).body.plan.isAvailable).toBe(false);
    expect((await staff.get(`/api/plans/${ended.id}`)).body.plan.isAvailable).toBe(false);
  });
});

describe('discount rules', () => {
  const base = { name: 'Seats', kind: 'percent', value: 10, scope: 'subscription', startDate: longAgo };

  it('creates percentage and fixed discounts with limits and product scope', async () => {
    const p = await makeProduct();
    const pct = await admin.post('/api/discounts').send({ ...base, scope: 'products', productIds: [p.id], minQuantity: 5, minPurchase: 1000, endDate: '2099-01-01', usageLimit: 3 });
    expect(pct.status).toBe(201);
    expect(pct.body.discount).toMatchObject({ kind: 'percent', value: 10, scope: 'products', minQuantity: 5, minPurchase: 1000, usageLimit: 3, usageCount: 0, status: 'active' });
    expect(pct.body.discount.products).toEqual([{ id: p.id, name: 'CRM Seat' }]);

    const fixed = await admin.post('/api/discounts').send({ ...base, name: 'Flat', kind: 'fixed', value: 250.5 });
    expect(fixed.body.discount).toMatchObject({ kind: 'fixed', value: 250.5, products: [] });
  });

  it('validates values, dates, scope and references', async () => {
    const bad = async (over: Record<string, unknown>, field: string) => {
      const res = await admin.post('/api/discounts').send({ ...base, ...over });
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(res.body.error.fields[field], JSON.stringify(res.body)).toBeTruthy();
    };
    await bad({ value: 0 }, 'value');
    await bad({ value: 100.5 }, 'value');
    await bad({ kind: 'fixed', value: 1.999 }, 'value');
    await bad({ kind: 'bogus' }, 'kind');
    await bad({ startDate: '2026-13-01' }, 'startDate');
    await bad({ startDate: '2026-06-10', endDate: '2026-06-01' }, 'endDate');
    await bad({ usageLimit: 0 }, 'usageLimit');
    await bad({ minQuantity: -1 }, 'minQuantity');
    await bad({ scope: 'products' }, 'productIds');
    await bad({ scope: 'products', productIds: [9999] }, 'productIds');
  });

  it('derives status from dates, limits and the active switch, and filters by it', async () => {
    await admin.post('/api/discounts').send({ ...base, name: 'Live' });
    await admin.post('/api/discounts').send({ ...base, name: 'Soon', startDate: tomorrow() });
    await admin.post('/api/discounts').send({ ...base, name: 'Gone', endDate: yesterday() });
    const used = (await admin.post('/api/discounts').send({ ...base, name: 'Used', usageLimit: 2 })).body.discount;
    run(t.db, 'UPDATE discounts SET usage_count = 2 WHERE id = ?', used.id);
    const off = (await admin.post('/api/discounts').send({ ...base, name: 'Off' })).body.discount;
    await admin.patch(`/api/discounts/${off.id}`).send({ isActive: false });

    const names = async (status: string) => ((await admin.get(`/api/discounts?status=${status}`)).body.items as { name: string }[]).map((d) => d.name);
    expect(await names('active')).toEqual(['Live']);
    expect(await names('scheduled')).toEqual(['Soon']);
    expect(await names('expired')).toEqual(['Gone']);
    expect(await names('used_up')).toEqual(['Used']);
    expect(await names('inactive')).toEqual(['Off']);
  });

  it('will not lower the usage limit below what has been used', async () => {
    const d = (await admin.post('/api/discounts').send({ ...base, usageLimit: 5 })).body.discount;
    run(t.db, 'UPDATE discounts SET usage_count = 3 WHERE id = ?', d.id);
    const res = await admin.patch(`/api/discounts/${d.id}`).send({ usageLimit: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.usageLimit).toBeTruthy();
    expect((await admin.patch(`/api/discounts/${d.id}`).send({ usageLimit: 3 })).status).toBe(200);
  });

  it('requires a new value when the discount type changes', async () => {
    const d = (await admin.post('/api/discounts').send(base)).body.discount;
    expect((await admin.patch(`/api/discounts/${d.id}`).send({ kind: 'fixed' })).status).toBe(422);
    const ok = await admin.patch(`/api/discounts/${d.id}`).send({ kind: 'fixed', value: 75 });
    expect(ok.body.discount).toMatchObject({ kind: 'fixed', value: 75 });
  });
});

describe('pricing preview', () => {
  /** Default 18% tax; product 1000 with an "Odoo" brand variant at +560; plan fee 500, minimum quantity 2. */
  async function scenario() {
    await makeTax();
    const product = await makeProduct();
    const variant = (await admin.post(`/api/products/${product.id}/variants`).send({ attribute: 'Brand', value: 'Odoo', extraPrice: 560 })).body.variant;
    const plan = await makePlan();
    return { product, variant, plan };
  }

  it('adds the variant extra to the unit price and shows how the total is made up', async () => {
    const { product, variant, plan } = await scenario();
    const res = await staff.post('/api/pricing/preview').send({ planId: plan.id, lines: [{ productId: product.id, variantId: variant.id, quantity: 5 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const seat = res.body.lines.find((l: { kind: string }) => l.kind === 'product');
    expect(seat).toMatchObject({ basePrice: 1000, variantExtra: 560, unitPrice: 1560, quantity: 5, subtotal: 7800, taxRatePercent: 18, tax: 1404, total: 9204 });
    expect(res.body.lines.find((l: { kind: string }) => l.kind === 'plan')).toMatchObject({ unitPrice: 500, tax: 90 });
    expect(res.body.totals).toEqual({ subtotal: 8300, discount: 0, tax: 1494, total: 9794 });
    expect(res.body.discount.applied).toBeNull();
  });

  it('applies a qualifying discount before tax, and only to the products it covers', async () => {
    const { product, variant, plan } = await scenario();
    await admin.post('/api/discounts').send({ name: '5+ seats', kind: 'percent', value: 10, scope: 'products', productIds: [product.id], minQuantity: 5, startDate: longAgo });
    const lines = [{ productId: product.id, variantId: variant.id, quantity: 5 }];
    const res = await staff.post('/api/pricing/preview').send({ planId: plan.id, lines });
    expect(res.body.discount.applied).toMatchObject({ name: '5+ seats', amount: 780 });
    expect(res.body.totals).toEqual({ subtotal: 8300, discount: 780, tax: 1353.6, total: 8873.6 });

    // one seat short of the threshold: no discount, and the reason is shown
    const short = await staff.post('/api/pricing/preview').send({ planId: plan.id, lines: [{ productId: product.id, quantity: 4 }] });
    expect(short.body.discount.applied).toBeNull();
    expect(short.body.discount.considered[0]).toMatchObject({ applies: false, reason: expect.stringContaining('at least 5') });
  });

  it('stops applying a discount once it expires or is used up', async () => {
    const { product, plan } = await scenario();
    const d = (await admin.post('/api/discounts').send({ name: 'Limited', kind: 'fixed', value: 100, scope: 'subscription', startDate: longAgo, usageLimit: 1 })).body.discount;
    const body = { planId: plan.id, lines: [{ productId: product.id, quantity: 2 }] };
    expect((await staff.post('/api/pricing/preview').send(body)).body.discount.applied?.name).toBe('Limited');
    run(t.db, 'UPDATE discounts SET usage_count = 1 WHERE id = ?', d.id);
    expect((await staff.post('/api/pricing/preview').send(body)).body.discount.applied).toBeNull();
    run(t.db, 'UPDATE discounts SET usage_count = 0, end_date = ? WHERE id = ?', yesterday(), d.id);
    expect((await staff.post('/api/pricing/preview').send(body)).body.discount.applied).toBeNull();
  });

  it('can price a specific discount, explaining why it does not apply', async () => {
    const { product, plan } = await scenario();
    const d = (await admin.post('/api/discounts').send({ name: 'Big', kind: 'percent', value: 50, scope: 'subscription', startDate: longAgo, minPurchase: 100000 })).body.discount;
    const res = await staff.post('/api/pricing/preview').send({ planId: plan.id, discountId: d.id, lines: [{ productId: product.id, quantity: 2 }] });
    expect(res.body.discount.applied).toBeNull();
    expect(res.body.discount.notApplied).toMatch(/below the discount minimum/);
  });

  it('rejects quantities under the plan minimum, bad references and unavailable plans', async () => {
    const { product, variant, plan } = await scenario();
    const other = await makeProduct({ name: 'Other' });
    const bad = async (body: Record<string, unknown>, field: string) => {
      const res = await staff.post('/api/pricing/preview').send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.fields[field], JSON.stringify(res.body)).toBeTruthy();
    };
    await bad({ planId: plan.id, lines: [{ productId: product.id, quantity: 1 }] }, 'lines.0.quantity');
    await bad({ planId: plan.id, lines: [{ productId: other.id, variantId: variant.id, quantity: 2 }] }, 'lines.0.variantId');
    await bad({ lines: [{ productId: 9999, quantity: 1 }] }, 'lines.0.productId');
    await bad({ lines: [{ productId: product.id, quantity: 0 }] }, 'lines.0.quantity');
    await bad({ lines: [{ productId: product.id, quantity: 1.5 }] }, 'lines.0.quantity');
    await bad({ planId: 9999, lines: [] }, 'planId');
    await bad({}, 'lines');
    const future = await makePlan({ name: 'Future', availableFrom: tomorrow() });
    await bad({ planId: future.id, lines: [] }, 'planId');

    await admin.patch(`/api/products/${product.id}/variants/${variant.id}`).send({ isActive: false });
    await bad({ lines: [{ productId: product.id, variantId: variant.id, quantity: 2 }] }, 'lines.0.variantId');
    await admin.patch(`/api/products/${product.id}`).send({ isActive: false });
    await bad({ lines: [{ productId: product.id, quantity: 2 }] }, 'lines.0.productId');
  });

  it('uses the product tax when set, else the default tax, else none', async () => {
    await makeTax('Default 18', 18, true);
    const special = await makeTax('Reduced 5', 5, false);
    const withTax = await makeProduct({ name: 'Taxed', taxId: special.id, salesPrice: 100 });
    const plain = await makeProduct({ name: 'Plain', salesPrice: 100 });
    const res = await staff.post('/api/pricing/preview').send({ lines: [{ productId: withTax.id, quantity: 1 }, { productId: plain.id, quantity: 1 }] });
    expect(res.body.lines.map((l: { taxRatePercent: number }) => l.taxRatePercent)).toEqual([5, 18]);
    expect(res.body.totals.tax).toBe(23);
  });

  it('does not let customers price anything', async () => {
    expect((await (await signupCustomer(t, 'c@shop.example')).post('/api/pricing/preview').send({ lines: [] })).status).toBe(403);
  });
});
