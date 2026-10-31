/* Invoices and billing (Stage 4). */

export type InvoiceStatus = 'draft' | 'confirmed' | 'paid' | 'cancelled';
export type InvoiceAction = 'confirm' | 'send' | 'cancel';

export interface InvoiceSummary {
  id: number;
  number: string;
  status: InvoiceStatus;
  customer: { id: number; name: string; company: string | null };
  subscription: { id: number; number: string };
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  dueDate: string;
  isOverdue: boolean;
  daysOverdue: number;
  total: number;
  paid: number;
  balance: number;
  sentAt: string | null;
  isDemo: boolean;
}

export interface InvoiceLine {
  id: number;
  kind: 'plan' | 'product';
  description: string;
  quantity: number;
  unitPrice: number;
  taxName: string | null;
  taxRatePercent: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

export interface InvoiceEvent {
  id: number;
  action: string;
  fromStatus: InvoiceStatus | null;
  toStatus: InvoiceStatus;
  actor: string | null;
  note: string | null;
  at: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  customerDetails: { name: string; company: string | null; email: string; address: string | null };
  planName: string;
  paymentTerms: string | null;
  discount: { id: number; name: string | null; amount: number } | null;
  lines: InvoiceLine[];
  totals: { subtotal: number; discount: number; tax: number; total: number; paid: number; balance: number };
  confirmedAt: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  sentCount: number;
  events: InvoiceEvent[];
  actions: { action: InvoiceAction; label: string }[];
}

export interface InvoiceCounts {
  counts: { draft: number; confirmed: number; paid: number; cancelled: number; overdue: number; outstanding: number };
  total: number;
}

export interface DueItem {
  subscriptionId: number;
  number: string;
  customer: string;
  plan: string;
  nextPeriodStart: string;
  periodsDue: number;
  perPeriod: number;
}

export interface DueResponse {
  asOf: string;
  subscriptionsDue: number;
  periodsDue: number;
  items: DueItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface BillingRunResult {
  runId: number;
  asOf: string;
  due: number;
  created: { id: number; number: string; subscriptionId: number; subscriptionNumber: string; periodIndex: number; total: number }[];
  failed: { subscriptionId: number; subscriptionNumber: string; periodIndex: number; message: string }[];
}

export interface BillingRunRow {
  id: number;
  asOf: string;
  autoConfirm: boolean;
  startedAt: string;
  finishedAt: string | null;
  due: number;
  created: number;
  failed: number;
  by: string | null;
}

export interface BillingFailureRow {
  id: number;
  subscription: { id: number; number: string };
  customer: string;
  periodIndex: number;
  message: string;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  resolvedAt: string | null;
}
