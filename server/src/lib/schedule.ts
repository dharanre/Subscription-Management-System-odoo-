import { type BillingPeriod, addDays, addPeriods } from './dates.js';

/**
 * A subscription is billed in advance, one invoice per billing period. Period 0 starts on the
 * subscription's start date, period 1 one billing interval later, and so on. Every period start is
 * measured from the original start date (see addPeriods), so month-end subscriptions never drift.
 */

export interface Schedule {
  startDate: string;
  expiryDate: string;
  period: BillingPeriod;
}

/** First day of billing period `k`. */
export const periodStart = (s: Schedule, k: number) => addPeriods(s.startDate, s.period, k);

/**
 * Last day covered by period `k`: the day before the next period starts, but never beyond the expiry
 * date. Nothing is pro-rated; a final short period is billed as a full period.
 */
export function periodEnd(s: Schedule, k: number): string {
  const end = addDays(periodStart(s, k + 1), -1);
  return end > s.expiryDate ? s.expiryDate : end;
}

/** A period can be billed once it has started, and only if it starts before the subscription expires. */
export const isBillable = (s: Schedule, k: number, upTo: string) => {
  const start = periodStart(s, k);
  return start <= upTo && start < s.expiryDate;
};

/** How many periods, from `nextPeriod` onwards, are billable up to `upTo`. Capped to stay safe on bad data. */
export function countDue(s: Schedule, nextPeriod: number, upTo: string, cap = 1000): number {
  let n = 0;
  while (n < cap && isBillable(s, nextPeriod + n, upTo)) n++;
  return n;
}
