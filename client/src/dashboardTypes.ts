import type { AgingBucket } from './billingTypes';
import type { SubStatus } from './salesTypes';

/* The finance dashboard and the customer portal home (Stage 6). */

export interface TrendPoint {
  key: string;
  label: string;
  invoiced: number;
  collected: number;
}

export interface DashboardData {
  range: { from: string; to: string };
  asOf: string;
  subscriptions: {
    active: number;
    paused: number;
    total: number;
    byStatus: Record<SubStatus, number>;
    activatedInRange: number;
    closedInRange: number;
  };
  recurring: { mrr: number; arr: number; activeSubscriptions: number; note: string };
  revenue: { collected: number; collectedCount: number; invoiced: number; invoicedCount: number };
  receivables: {
    outstanding: { count: number; amount: number };
    overdue: { count: number; amount: number; oldestDueDate: string | null; oldestDaysOverdue: number };
    dueSoon: { count: number; amount: number };
    buckets: AgingBucket[];
  };
  attention: { billingDue: number; billingFailures: number; draftInvoices: number; expiringSoon: number; expiredQuotes: number };
  trend: { granularity: 'day' | 'month'; points: TrendPoint[] };
}

export interface PortalSummary {
  subscriptions: {
    byStatus: Record<SubStatus, number>;
    active: number;
    items: { id: number; number: string; status: string; plan: string; billingPeriod: string; nextBillingDate: string | null; expiryDate: string; perPeriod: number }[];
  };
  invoices: {
    outstanding: { count: number; amount: number };
    overdue: { count: number; amount: number };
    next: { id: number; number: string; dueDate: string; balance: number; isOverdue: boolean } | null;
    recent: { id: number; number: string; status: string; issueDate: string; dueDate: string; total: number; balance: number }[];
  };
  payments: {
    totalPaid: number;
    count: number;
    recent: { id: number; invoiceId: number; invoiceNumber: string; amount: number; method: string; paidOn: string }[];
  };
}
