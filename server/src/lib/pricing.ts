import { roundDiv } from './money.js';

/**
 * Pure pricing maths in integer minor units. Nothing here touches the database, so the same code
 * prices previews, quotations and invoices and the results always agree.
 *
 * Order of operations for every document:
 *   1. line subtotal = quantity x unit price
 *   2. one discount (if any) is taken off the eligible lines, shared out in proportion to their subtotals
 *   3. tax is charged on each line's discounted amount, rounded half up per line
 *   4. totals are plain sums of the line figures
 */

export interface LineInput {
  /** Caller's identifier, echoed back so results can be matched to inputs. */
  key: number | string;
  productId: number | null;
  quantity: number;
  unitPriceMinor: number;
  taxRateBp: number;
}

export interface DiscountRule {
  id: number;
  name: string;
  kind: 'fixed' | 'percent';
  /** Minor units for 'fixed', basis points for 'percent'. */
  value: number;
  scope: 'products' | 'subscription';
  productIds: number[];
  minPurchaseMinor: number;
  minQuantity: number;
}

export interface DiscountState extends DiscountRule {
  isActive: boolean;
  startDate: string;
  endDate: string | null;
  usageLimit: number | null;
  usageCount: number;
}

export interface PricedLine extends LineInput {
  subtotalMinor: number;
  discountMinor: number;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface Totals {
  lines: PricedLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface DiscountEvaluation {
  applies: boolean;
  /** Why it does not apply, in words suitable for showing to staff. */
  reason?: string;
  amountMinor: number;
  eligibleKeys: (number | string)[];
}

/** Why a discount cannot be used on `date` regardless of the cart, or null when it is usable. */
export function discountUnavailableReason(d: DiscountState, date: string): string | null {
  if (!d.isActive) return 'The discount is switched off';
  if (date < d.startDate) return `Starts on ${d.startDate}`;
  if (d.endDate && date > d.endDate) return `Expired on ${d.endDate}`;
  if (d.usageLimit !== null && d.usageCount >= d.usageLimit) return 'Usage limit reached';
  return null;
}

export function evaluateDiscount(rule: DiscountRule, lines: LineInput[]): DiscountEvaluation {
  const eligible = rule.scope === 'subscription' ? lines : lines.filter((l) => l.productId !== null && rule.productIds.includes(l.productId));
  const none = (reason: string): DiscountEvaluation => ({ applies: false, reason, amountMinor: 0, eligibleKeys: [] });

  if (eligible.length === 0) return none('No line on this order uses a product the discount covers');

  const subtotal = eligible.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
  const quantity = eligible.reduce((s, l) => s + l.quantity, 0);
  if (subtotal < rule.minPurchaseMinor) return none('Order value is below the discount minimum');
  if (quantity < rule.minQuantity) return none(`Needs at least ${rule.minQuantity} units (order has ${quantity})`);

  const raw = rule.kind === 'percent' ? roundDiv(subtotal * rule.value, 10_000) : rule.value;
  const amount = Math.min(raw, subtotal);
  if (amount <= 0) return none('The discount would not reduce the price');
  return { applies: true, amountMinor: amount, eligibleKeys: eligible.map((l) => l.key) };
}

/** Splits `amount` across `weights` proportionally so the parts add up to exactly `amount`. */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total === 0 || amount === 0) return weights.map(() => 0);
  const shares = weights.map((w) => Math.floor((amount * w) / total));
  let remainder = amount - shares.reduce((s, x) => s + x, 0);
  // Hand leftover minor units to the largest fractional remainders first, ties to the earlier line.
  const order = weights
    .map((w, i) => ({ i, frac: (amount * w) % total }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder === 0) break;
    shares[i]! += 1;
    remainder -= 1;
  }
  return shares;
}

export function priceLines(lines: LineInput[], discount?: { amountMinor: number; eligibleKeys: (number | string)[] } | null): Totals {
  const subtotals = lines.map((l) => l.quantity * l.unitPriceMinor);
  const eligibleIdx = lines.map((l, i) => (discount?.eligibleKeys.includes(l.key) ? i : -1)).filter((i) => i >= 0);
  const shares = allocate(discount?.amountMinor ?? 0, eligibleIdx.map((i) => subtotals[i]!));
  const discountByIdx = new Map(eligibleIdx.map((i, n) => [i, shares[n]!]));

  const priced = lines.map((l, i): PricedLine => {
    const subtotalMinor = subtotals[i]!;
    const discountMinor = discountByIdx.get(i) ?? 0;
    const netMinor = subtotalMinor - discountMinor;
    const taxMinor = roundDiv(netMinor * l.taxRateBp, 10_000);
    return { ...l, subtotalMinor, discountMinor, netMinor, taxMinor, totalMinor: netMinor + taxMinor };
  });

  const sum = (f: (l: PricedLine) => number) => priced.reduce((s, l) => s + f(l), 0);
  return {
    lines: priced,
    subtotalMinor: sum((l) => l.subtotalMinor),
    discountMinor: sum((l) => l.discountMinor),
    taxMinor: sum((l) => l.taxMinor),
    totalMinor: sum((l) => l.totalMinor),
  };
}

/** Of all discounts usable on `date` that apply to these lines, the one that saves the most. */
export function chooseBestDiscount(
  discounts: DiscountState[],
  lines: LineInput[],
  date: string,
): { rule: DiscountState; evaluation: DiscountEvaluation } | null {
  let best: { rule: DiscountState; evaluation: DiscountEvaluation } | null = null;
  for (const rule of discounts) {
    if (discountUnavailableReason(rule, date)) continue;
    const evaluation = evaluateDiscount(rule, lines);
    if (!evaluation.applies) continue;
    if (!best || evaluation.amountMinor > best.evaluation.amountMinor) best = { rule, evaluation };
  }
  return best;
}
