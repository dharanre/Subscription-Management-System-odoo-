import { describe, expect, it } from 'vitest';
import { dateSchema, moneySchema, percentSchema, roundDiv, toMinor } from '../src/lib/money.js';
import {
  type DiscountRule,
  type DiscountState,
  type LineInput,
  allocate,
  chooseBestDiscount,
  discountUnavailableReason,
  evaluateDiscount,
  priceLines,
} from '../src/lib/pricing.js';

const line = (key: number, productId: number | null, quantity: number, unitPriceMinor: number, taxRateBp = 0): LineInput => ({
  key,
  productId,
  quantity,
  unitPriceMinor,
  taxRateBp,
});

const rule = (over: Partial<DiscountRule> = {}): DiscountRule => ({
  id: 1,
  name: 'Test',
  kind: 'percent',
  value: 1000,
  scope: 'subscription',
  productIds: [],
  minPurchaseMinor: 0,
  minQuantity: 0,
  ...over,
});

const state = (over: Partial<DiscountState> = {}): DiscountState => ({
  ...rule(),
  isActive: true,
  startDate: '2026-01-01',
  endDate: null,
  usageLimit: null,
  usageCount: 0,
  ...over,
});

describe('money helpers', () => {
  it('rounds half up and never uses floating point drift', () => {
    expect(roundDiv(5, 10)).toBe(1);
    expect(roundDiv(4, 10)).toBe(0);
    expect(roundDiv(15, 10)).toBe(2);
    expect(toMinor(560)).toBe(56000);
    expect(toMinor(19.99)).toBe(1999);
  });

  it('rejects amounts with more than two decimals instead of silently rounding them', () => {
    expect(moneySchema('Price').safeParse(1.005).success).toBe(false);
    expect(moneySchema('Price').safeParse(19.99).success).toBe(true);
    expect(moneySchema('Price').safeParse(-1).success).toBe(false);
    expect(moneySchema('Price').safeParse(Number.NaN).success).toBe(false);
    expect(percentSchema('Rate').safeParse(100.01).success).toBe(false);
    expect(dateSchema('Date').safeParse('2026-02-30').success).toBe(false);
    expect(dateSchema('Date').safeParse('2026-02-28').success).toBe(true);
  });
});

describe('allocate', () => {
  it('always sums exactly to the amount, however awkward the split', () => {
    for (const [amount, weights] of [
      [100, [1, 1, 1]],
      [1, [5, 5]],
      [999, [3333, 3333, 3334]],
      [7, [0, 10, 0]],
    ] as [number, number[]][]) {
      const parts = allocate(amount, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(parts.every((p) => p >= 0)).toBe(true);
    }
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('gives nothing to zero-weight lines', () => {
    expect(allocate(7, [0, 10, 0])).toEqual([0, 7, 0]);
  });
});

describe('priceLines', () => {
  it('charges tax per line, rounded half up', () => {
    const totals = priceLines([line(0, 1, 3, 999, 1800)]);
    expect(totals.subtotalMinor).toBe(2997);
    expect(totals.taxMinor).toBe(539); // 539.46 rounds down
    expect(totals.totalMinor).toBe(3536);

    // exactly half a minor unit rounds up: 25 x 18% = 4.5 -> 5
    expect(priceLines([line(0, 1, 1, 25, 1800)]).taxMinor).toBe(5);
    // just under half rounds down: 24 x 18% = 4.32 -> 4
    expect(priceLines([line(0, 1, 1, 24, 1800)]).taxMinor).toBe(4);
  });

  it('rounds each line separately, so the invoice always equals the sum of its lines', () => {
    const totals = priceLines([line(0, 1, 1, 25, 1800), line(1, 2, 1, 25, 1800)]);
    expect(totals.taxMinor).toBe(10); // 5 + 5, not round(9.0)
    expect(totals.lines.reduce((s, l) => s + l.taxMinor, 0)).toBe(totals.taxMinor);
  });

  it('applies the discount before tax and the totals are exact sums of the lines', () => {
    const lines = [line(0, 1, 5, 156000, 1800), line(1, null, 1, 50000, 1800)];
    const ev = evaluateDiscount(rule({ scope: 'products', productIds: [1], kind: 'percent', value: 1000 }), lines);
    expect(ev).toMatchObject({ applies: true, amountMinor: 78000, eligibleKeys: [0] });
    const totals = priceLines(lines, ev);
    expect(totals.subtotalMinor).toBe(830000);
    expect(totals.discountMinor).toBe(78000);
    expect(totals.taxMinor).toBe(126360 + 9000);
    expect(totals.totalMinor).toBe(702000 + 126360 + 50000 + 9000);
    expect(totals.lines.reduce((s, l) => s + l.totalMinor, 0)).toBe(totals.totalMinor);
    expect(totals.lines[1]!.discountMinor).toBe(0);
  });

  it('shares a subscription-wide discount across lines without losing a minor unit', () => {
    const lines = [line(0, 1, 1, 3333), line(1, 2, 1, 3333), line(2, 3, 1, 3334)];
    const ev = evaluateDiscount(rule({ kind: 'fixed', value: 1000 }), lines);
    const totals = priceLines(lines, ev);
    expect(totals.discountMinor).toBe(1000);
    expect(totals.lines.map((l) => l.discountMinor).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(totals.totalMinor).toBe(10000 - 1000);
  });

  it('handles an empty order', () => {
    expect(priceLines([])).toMatchObject({ subtotalMinor: 0, totalMinor: 0 });
  });
});

describe('evaluateDiscount', () => {
  const lines = [line(0, 1, 4, 1000), line(1, 2, 1, 5000)];

  it('percentage of the eligible subtotal', () => {
    expect(evaluateDiscount(rule({ value: 2500 }), lines).amountMinor).toBe(2250); // 25% of 9000
  });

  it('fixed amount, capped at what it can reduce', () => {
    expect(evaluateDiscount(rule({ kind: 'fixed', value: 3000 }), lines).amountMinor).toBe(3000);
    expect(evaluateDiscount(rule({ kind: 'fixed', value: 99999 }), lines).amountMinor).toBe(9000);
  });

  it('product scope looks only at the covered products', () => {
    const ev = evaluateDiscount(rule({ scope: 'products', productIds: [2], value: 1000 }), lines);
    expect(ev).toMatchObject({ applies: true, amountMinor: 500, eligibleKeys: [1] });
    expect(evaluateDiscount(rule({ scope: 'products', productIds: [99] }), lines)).toMatchObject({ applies: false });
  });

  it('enforces the minimum purchase and minimum quantity', () => {
    expect(evaluateDiscount(rule({ minPurchaseMinor: 9001 }), lines)).toMatchObject({ applies: false, reason: expect.stringContaining('minimum') });
    expect(evaluateDiscount(rule({ minPurchaseMinor: 9000 }), lines).applies).toBe(true);
    expect(evaluateDiscount(rule({ minQuantity: 6 }), lines)).toMatchObject({ applies: false });
    expect(evaluateDiscount(rule({ minQuantity: 5 }), lines).applies).toBe(true);
  });

  it('measures the minimums on eligible lines only', () => {
    const r = rule({ scope: 'products', productIds: [1], minQuantity: 5 });
    expect(evaluateDiscount(r, lines).applies).toBe(false); // only 4 units of product 1
  });
});

describe('discount availability', () => {
  const day = '2026-06-15';
  it('is usable inside its window and under its limit', () => {
    expect(discountUnavailableReason(state({ startDate: '2026-06-15', endDate: '2026-06-15' }), day)).toBeNull();
  });
  it('stops when expired, not yet started, switched off or used up', () => {
    expect(discountUnavailableReason(state({ endDate: '2026-06-14' }), day)).toMatch(/Expired/);
    expect(discountUnavailableReason(state({ startDate: '2026-06-16' }), day)).toMatch(/Starts/);
    expect(discountUnavailableReason(state({ isActive: false }), day)).toMatch(/off/);
    expect(discountUnavailableReason(state({ usageLimit: 3, usageCount: 3 }), day)).toMatch(/limit/);
    expect(discountUnavailableReason(state({ usageLimit: 3, usageCount: 2 }), day)).toBeNull();
  });
});

describe('chooseBestDiscount', () => {
  const lines = [line(0, 1, 10, 1000)];
  it('picks the discount that saves the most and ignores unusable ones', () => {
    const best = chooseBestDiscount(
      [
        state({ id: 1, kind: 'percent', value: 500 }),
        state({ id: 2, kind: 'fixed', value: 800 }),
        state({ id: 3, kind: 'percent', value: 5000, endDate: '2026-01-31' }),
        state({ id: 4, kind: 'percent', value: 5000, usageLimit: 1, usageCount: 1 }),
      ],
      lines,
      '2026-06-15',
    );
    expect(best?.rule.id).toBe(2);
    expect(best?.evaluation.amountMinor).toBe(800);
  });
  it('returns null when nothing qualifies', () => {
    expect(chooseBestDiscount([state({ minQuantity: 50 })], lines, '2026-06-15')).toBeNull();
  });
});
