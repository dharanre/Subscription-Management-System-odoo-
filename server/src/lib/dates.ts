/**
 * Calendar-date arithmetic on 'YYYY-MM-DD' strings. Everything is done in UTC so results never
 * depend on the server's time zone or on daylight saving.
 */

export type BillingPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

const toUtc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** Adds calendar months, clamping to the last day of a shorter month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const d = toUtc(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return toIso(d);
}

/**
 * The date `count` billing periods after `start`. Always measured from the original start date, never
 * from the previous result, so a 31st-of-the-month subscription bills on the 28th in February and
 * returns to the 31st in March instead of drifting to the 28th for ever.
 */
export function addPeriods(start: string, period: BillingPeriod, count: number): string {
  switch (period) {
    case 'daily':
      return addDays(start, count);
    case 'weekly':
      return addDays(start, count * 7);
    case 'monthly':
      return addMonths(start, count);
    case 'yearly':
      return addMonths(start, count * 12);
  }
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** A sensible default expiry when none is given: about a year for monthly and yearly plans, shorter for short plans. */
export function suggestExpiry(start: string, period: BillingPeriod): string {
  switch (period) {
    case 'daily':
      return addDays(start, 30);
    case 'weekly':
      return addDays(start, 12 * 7);
    case 'monthly':
      return addMonths(start, 12);
    case 'yearly':
      return addMonths(start, 12);
  }
}
