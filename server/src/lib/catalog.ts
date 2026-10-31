import { type DB, all, get } from '../db.js';
import { HttpError } from './http.js';
import { bpToPercent, fromMinor } from './money.js';
import { type DiscountState, discountUnavailableReason } from './pricing.js';

/* ---------- Row types (as stored) ---------- */

export interface TaxRow {
  id: number;
  name: string;
  rate_bp: number;
  is_default: number;
  is_active: number;
  is_demo: number;
  created_at: string;
}
export interface ProductRow {
  id: number;
  name: string;
  type: string;
  sales_price_minor: number;
  cost_price_minor: number;
  tax_id: number | null;
  notes: string | null;
  is_active: number;
  is_demo: number;
  created_at: string;
  updated_at: string;
}
export interface VariantRow {
  id: number;
  product_id: number;
  attribute: string;
  value: string;
  extra_price_minor: number;
  is_active: number;
}
export interface PlanRow {
  id: number;
  name: string;
  description: string | null;
  price_minor: number;
  billing_period: 'daily' | 'weekly' | 'monthly' | 'yearly';
  min_quantity: number;
  available_from: string;
  available_to: string | null;
  auto_close: number;
  allow_early_close: number;
  allow_pause: number;
  allow_renewal: number;
  is_active: number;
  is_demo: number;
  created_at: string;
}
export interface DiscountRow {
  id: number;
  name: string;
  kind: 'fixed' | 'percent';
  value: number;
  scope: 'products' | 'subscription';
  min_purchase_minor: number;
  min_quantity: number;
  start_date: string;
  end_date: string | null;
  usage_limit: number | null;
  usage_count: number;
  is_active: number;
  is_demo: number;
  created_at: string;
}

/* ---------- API shapes ---------- */

export const toTax = (r: TaxRow) => ({
  id: r.id,
  name: r.name,
  ratePercent: bpToPercent(r.rate_bp),
  isDefault: r.is_default === 1,
  isActive: r.is_active === 1,
  isDemo: r.is_demo === 1,
  createdAt: r.created_at,
});

export const toVariant = (v: VariantRow) => ({
  id: v.id,
  attribute: v.attribute,
  value: v.value,
  extraPrice: fromMinor(v.extra_price_minor),
  isActive: v.is_active === 1,
});

export const toProduct = (r: ProductRow, variants: VariantRow[], tax: TaxRow | undefined) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  salesPrice: fromMinor(r.sales_price_minor),
  costPrice: fromMinor(r.cost_price_minor),
  taxId: r.tax_id,
  tax: tax ? { id: tax.id, name: tax.name, ratePercent: bpToPercent(tax.rate_bp) } : null,
  notes: r.notes,
  isActive: r.is_active === 1,
  isDemo: r.is_demo === 1,
  variants: variants.map(toVariant),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const isPlanAvailable = (p: PlanRow, date: string) =>
  p.is_active === 1 && date >= p.available_from && (p.available_to === null || date <= p.available_to);

export const toPlan = (r: PlanRow, date: string) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  price: fromMinor(r.price_minor),
  billingPeriod: r.billing_period,
  minQuantity: r.min_quantity,
  availableFrom: r.available_from,
  availableTo: r.available_to,
  autoClose: r.auto_close === 1,
  allowEarlyClose: r.allow_early_close === 1,
  allowPause: r.allow_pause === 1,
  allowRenewal: r.allow_renewal === 1,
  isActive: r.is_active === 1,
  isAvailable: isPlanAvailable(r, date),
  isDemo: r.is_demo === 1,
  createdAt: r.created_at,
});

export type DiscountStatus = 'active' | 'scheduled' | 'expired' | 'used_up' | 'inactive';

export function discountStatus(d: DiscountState, date: string): DiscountStatus {
  if (!d.isActive) return 'inactive';
  if (date < d.startDate) return 'scheduled';
  if (d.endDate && date > d.endDate) return 'expired';
  if (d.usageLimit !== null && d.usageCount >= d.usageLimit) return 'used_up';
  return 'active';
}

export const toDiscountState = (r: DiscountRow, productIds: number[]): DiscountState => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  value: r.value,
  scope: r.scope,
  productIds,
  minPurchaseMinor: r.min_purchase_minor,
  minQuantity: r.min_quantity,
  isActive: r.is_active === 1,
  startDate: r.start_date,
  endDate: r.end_date,
  usageLimit: r.usage_limit,
  usageCount: r.usage_count,
});

export const toDiscount = (r: DiscountRow, products: { id: number; name: string }[], date: string) => {
  const state = toDiscountState(r, products.map((p) => p.id));
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    value: r.kind === 'fixed' ? fromMinor(r.value) : bpToPercent(r.value),
    scope: r.scope,
    products,
    minPurchase: fromMinor(r.min_purchase_minor),
    minQuantity: r.min_quantity,
    startDate: r.start_date,
    endDate: r.end_date,
    usageLimit: r.usage_limit,
    usageCount: r.usage_count,
    isActive: r.is_active === 1,
    status: discountStatus(state, date),
    unavailableReason: discountUnavailableReason(state, date),
    isDemo: r.is_demo === 1,
    createdAt: r.created_at,
  };
};

/* ---------- Loaders ---------- */

export const defaultTax = (db: DB) => get<TaxRow>(db, 'SELECT * FROM taxes WHERE is_default = 1 AND is_active = 1');

export function loadVariants(db: DB, productIds: number[]): Map<number, VariantRow[]> {
  const byProduct = new Map<number, VariantRow[]>();
  if (productIds.length === 0) return byProduct;
  const rows = all<VariantRow>(
    db,
    `SELECT * FROM product_variants WHERE product_id IN (${productIds.map(() => '?').join(',')}) ORDER BY attribute, value`,
    ...productIds,
  );
  for (const v of rows) {
    const list = byProduct.get(v.product_id) ?? [];
    list.push(v);
    byProduct.set(v.product_id, list);
  }
  return byProduct;
}

export function loadDiscountProducts(db: DB, discountIds: number[]): Map<number, { id: number; name: string }[]> {
  const byDiscount = new Map<number, { id: number; name: string }[]>();
  if (discountIds.length === 0) return byDiscount;
  const rows = all<{ discount_id: number; id: number; name: string }>(
    db,
    `SELECT dp.discount_id, p.id, p.name FROM discount_products dp JOIN products p ON p.id = dp.product_id
      WHERE dp.discount_id IN (${discountIds.map(() => '?').join(',')}) ORDER BY p.name`,
    ...discountIds,
  );
  for (const r of rows) {
    const list = byDiscount.get(r.discount_id) ?? [];
    list.push({ id: r.id, name: r.name });
    byDiscount.set(r.discount_id, list);
  }
  return byDiscount;
}

/** Every discount with its covered products, ready for the pricing engine. */
export function loadDiscountStates(db: DB): DiscountState[] {
  const rows = all<DiscountRow>(db, 'SELECT * FROM discounts');
  const products = loadDiscountProducts(db, rows.map((r) => r.id));
  return rows.map((r) => toDiscountState(r, (products.get(r.id) ?? []).map((p) => p.id)));
}

/* ---------- Building priced lines from a plan and product requests ---------- */

export interface LineRequest {
  productId: number;
  variantId?: number | null;
  quantity: number;
}

export interface BuiltLine {
  key: number;
  kind: 'plan' | 'product';
  description: string;
  productId: number | null;
  variantId: number | null;
  quantity: number;
  unitPriceMinor: number;
  baseMinor: number;
  variantExtraMinor: number;
  taxId: number | null;
  taxName: string | null;
  taxRateBp: number;
}

const lineError = (index: number, field: string, message: string) =>
  new HttpError(422, 'validation_failed', 'Please correct the highlighted fields.', { [`lines.${index}.${field}`]: message });

/**
 * Resolves each requested product to a concrete unit price (product price + chosen variant extra)
 * and tax (the product's own tax, else the default tax, else none). When a plan is given, its
 * recurring fee is added as the first line and every product quantity must meet the plan minimum.
 */
export function buildLines(db: DB, plan: PlanRow | null, requests: LineRequest[]): BuiltLine[] {
  const fallbackTax = defaultTax(db);
  const lines: BuiltLine[] = [];

  if (plan && plan.price_minor > 0) {
    lines.push({
      key: 0,
      kind: 'plan',
      description: `${plan.name} (${plan.billing_period})`,
      productId: null,
      variantId: null,
      quantity: 1,
      unitPriceMinor: plan.price_minor,
      baseMinor: plan.price_minor,
      variantExtraMinor: 0,
      taxId: fallbackTax?.id ?? null,
      taxName: fallbackTax?.name ?? null,
      taxRateBp: fallbackTax?.rate_bp ?? 0,
    });
  }

  requests.forEach((req, i) => {
    const product = get<ProductRow>(db, 'SELECT * FROM products WHERE id = ?', req.productId);
    if (!product) throw lineError(i, 'productId', 'Choose an existing product');
    if (!product.is_active) throw lineError(i, 'productId', `${product.name} is no longer sold`);
    if (plan && req.quantity < plan.min_quantity) {
      throw lineError(i, 'quantity', `${plan.name} needs a quantity of at least ${plan.min_quantity}`);
    }

    let variant: VariantRow | undefined;
    if (req.variantId != null) {
      variant = get<VariantRow>(db, 'SELECT * FROM product_variants WHERE id = ? AND product_id = ?', req.variantId, product.id);
      if (!variant) throw lineError(i, 'variantId', `That option does not belong to ${product.name}`);
      if (!variant.is_active) throw lineError(i, 'variantId', `${variant.attribute}: ${variant.value} is no longer offered`);
    }

    const tax = product.tax_id ? get<TaxRow>(db, 'SELECT * FROM taxes WHERE id = ?', product.tax_id) : fallbackTax;
    const extra = variant?.extra_price_minor ?? 0;
    lines.push({
      key: lines.length,
      kind: 'product',
      description: variant ? `${product.name} - ${variant.attribute}: ${variant.value}` : product.name,
      productId: product.id,
      variantId: variant?.id ?? null,
      quantity: req.quantity,
      unitPriceMinor: product.sales_price_minor + extra,
      baseMinor: product.sales_price_minor,
      variantExtraMinor: extra,
      taxId: tax?.id ?? null,
      taxName: tax?.name ?? null,
      taxRateBp: tax?.rate_bp ?? 0,
    });
  });

  return lines;
}
