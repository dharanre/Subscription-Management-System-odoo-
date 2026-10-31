export interface Variant {
  id: number;
  attribute: string;
  value: string;
  extraPrice: number;
  isActive: boolean;
}

export interface Tax {
  id: number;
  name: string;
  ratePercent: number;
  isDefault: boolean;
  isActive: boolean;
  isDemo: boolean;
}

export type ProductType = 'software' | 'add_on' | 'service' | 'goods';

export interface Product {
  id: number;
  name: string;
  type: ProductType;
  salesPrice: number;
  costPrice: number;
  taxId: number | null;
  tax: { id: number; name: string; ratePercent: number } | null;
  notes: string | null;
  isActive: boolean;
  isDemo: boolean;
  variants: Variant[];
}

export type BillingPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Plan {
  id: number;
  name: string;
  description: string | null;
  price: number;
  billingPeriod: BillingPeriod;
  minQuantity: number;
  availableFrom: string;
  availableTo: string | null;
  autoClose: boolean;
  allowEarlyClose: boolean;
  allowPause: boolean;
  allowRenewal: boolean;
  isActive: boolean;
  isAvailable: boolean;
  isDemo: boolean;
}

export type DiscountStatus = 'active' | 'scheduled' | 'expired' | 'used_up' | 'inactive';

export interface Discount {
  id: number;
  name: string;
  kind: 'fixed' | 'percent';
  value: number;
  scope: 'products' | 'subscription';
  products: { id: number; name: string }[];
  minPurchase: number;
  minQuantity: number;
  startDate: string;
  endDate: string | null;
  usageLimit: number | null;
  usageCount: number;
  isActive: boolean;
  status: DiscountStatus;
  unavailableReason: string | null;
  isDemo: boolean;
}

export interface PreviewLine {
  key: number;
  kind: 'plan' | 'product';
  description: string;
  quantity: number;
  basePrice: number;
  variantExtra: number;
  unitPrice: number;
  taxName: string | null;
  taxRatePercent: number;
  subtotal: number;
  discount: number;
  net: number;
  tax: number;
  total: number;
}

export interface Preview {
  date: string;
  plan: { id: number; name: string; billingPeriod: BillingPeriod; price: number } | null;
  lines: PreviewLine[];
  discount: {
    applied: { id: number; name: string; amount: number } | null;
    notApplied: string | null;
    considered: { id: number; name: string; applies: boolean; reason: string | null; amount: number }[];
  };
  totals: { subtotal: number; discount: number; tax: number; total: number };
}

export const PRODUCT_TYPES: { value: ProductType; label: string }[] = [
  { value: 'software', label: 'Software' },
  { value: 'add_on', label: 'Add-on' },
  { value: 'service', label: 'Service' },
  { value: 'goods', label: 'Goods' },
];
export const typeLabel = (t: ProductType) => PRODUCT_TYPES.find((x) => x.value === t)?.label ?? t;

export const PERIODS: { value: BillingPeriod; label: string; unit: string }[] = [
  { value: 'daily', label: 'Daily', unit: 'day' },
  { value: 'weekly', label: 'Weekly', unit: 'week' },
  { value: 'monthly', label: 'Monthly', unit: 'month' },
  { value: 'yearly', label: 'Yearly', unit: 'year' },
];
export const periodUnit = (p: BillingPeriod) => PERIODS.find((x) => x.value === p)?.unit ?? p;
