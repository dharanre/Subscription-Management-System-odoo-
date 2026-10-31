import { describe, expect, it } from 'vitest';
import { addDays, addMonths, addPeriods, diffDays, suggestExpiry } from '../src/lib/dates.js';

describe('date arithmetic', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });

  it('clamps month-end days instead of overflowing into the next month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2026-05-15', -5)).toBe('2025-12-15');
  });

  it('measures every billing date from the original start, so month-end subscriptions never drift', () => {
    const dates = [0, 1, 2, 3, 4].map((k) => addPeriods('2026-01-31', 'monthly', k));
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('handles weekly, daily and yearly periods, including a leap-day start', () => {
    expect(addPeriods('2026-06-01', 'weekly', 3)).toBe('2026-06-22');
    expect(addPeriods('2026-06-01', 'daily', 45)).toBe('2026-07-16');
    expect(addPeriods('2028-02-29', 'yearly', 1)).toBe('2029-02-28');
    expect(addPeriods('2028-02-29', 'yearly', 4)).toBe('2032-02-29');
  });

  it('counts whole days between dates', () => {
    expect(diffDays('2026-01-01', '2027-01-01')).toBe(365);
    expect(diffDays('2028-01-01', '2029-01-01')).toBe(366);
    expect(diffDays('2026-06-10', '2026-06-09')).toBe(-1);
    expect(diffDays('2026-03-28', '2026-03-29')).toBe(1); // no off-by-one across a daylight-saving change
  });

  it('suggests an expiry that suits the billing period', () => {
    expect(suggestExpiry('2026-01-15', 'monthly')).toBe('2027-01-15');
    expect(suggestExpiry('2026-01-15', 'yearly')).toBe('2027-01-15');
    expect(suggestExpiry('2026-01-15', 'weekly')).toBe('2026-04-09');
    expect(suggestExpiry('2026-01-15', 'daily')).toBe('2026-02-14');
  });
});
