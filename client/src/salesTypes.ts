import type { BillingPeriod } from './types';

/* Customers, quotation templates and subscriptions (Stage 3). */

export interface Customer {
  id: number;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  address: string | null;
  hasPortalAccount: boolean;
  subscriptionCount: number;
  isDemo: boolean;
}

export interface PaymentTerms {
  id: number;
  name: string;
  daysDue: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface TemplateLine {
  id: number;
  productId: number;
  productName: string;
  variantId: number | null;
  variantLabel: string | null;
  quantity: number;
  unitPrice: number;
}

export interface Template {
  id: number;
  name: string;
  plan: { id: number; name: string; billingPeriod: BillingPeriod; price: number; minQuantity: number };
  validityDays: number;
  paymentTerms: { id: number; name: string } | null;
  notes: string | null;
  isActive: boolean;
  isDemo: boolean;
  lines: TemplateLine[];
}

export type SubStatus = 'draft' | 'quotation' | 'confirmed' | 'active' | 'paused' | 'closed';
export type SubAction = 'send_quote' | 'revert_to_draft' | 'confirm' | 'activate' | 'pause' | 'resume' | 'close' | 'cancel' | 'renew';
export type CloseReason = 'cancelled' | 'closed_early' | 'expired';

export interface SubscriptionSummary {
  id: number;
  number: string;
  status: SubStatus;
  customer: { id: number; name: string; company: string | null };
  plan: { id: number; name: string; billingPeriod: BillingPeriod };
  startDate: string;
  expiryDate: string;
  quoteValidUntil: string | null;
  quoteExpired: boolean;
  nextBillingDate: string | null;
  closeReason: CloseReason | null;
  /** What one billing period costs, before any discount. */
  total: number;
  isDemo: boolean;
}

export interface SubscriptionLine {
  id: number;
  kind: 'plan' | 'product';
  description: string;
  productId: number | null;
  variantId: number | null;
  quantity: number;
  unitPrice: number;
  taxName: string | null;
  taxRatePercent: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

export interface SubscriptionEvent {
  id: number;
  action: string;
  fromStatus: SubStatus | null;
  toStatus: SubStatus;
  actor: { id: number; name: string | null } | null;
  note: string | null;
  at: string;
}

export interface SubscriptionDetail extends Omit<SubscriptionSummary, 'customer'> {
  customer: { id: number; name: string; email: string; company: string | null; phone: string | null; address: string | null };
  paymentTerms: { id: number; name: string; daysDue: number } | null;
  templateId: number | null;
  notes: string | null;
  closedAt: string | null;
  planRules: { autoClose: boolean; allowEarlyClose: boolean; allowPause: boolean; allowRenewal: boolean; minQuantity: number; price: number };
  lines: SubscriptionLine[];
  totals: { subtotal: number; discount: number; tax: number; total: number };
  estimatedDiscount: { id: number; name: string; amount: number } | null;
  events: SubscriptionEvent[];
  actions: { action: SubAction; label: string }[];
}
