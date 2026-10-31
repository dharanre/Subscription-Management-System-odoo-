import { Router } from 'express';
import { z } from 'zod';
import { type DB, get } from '../db.js';
import { type PlanRow, buildLines, discountStatus, isPlanAvailable, loadDiscountStates } from '../lib/catalog.js';
import { invalidField, parse } from '../lib/http.js';
import { bpToPercent, dateSchema, fromMinor, today } from '../lib/money.js';
import { chooseBestDiscount, discountUnavailableReason, evaluateDiscount, priceLines } from '../lib/pricing.js';
import { requireRole } from '../middleware/auth.js';

const previewSchema = z.object({
  planId: z.number({ invalid_type_error: 'Choose a plan' }).int().positive().nullable().optional(),
  lines: z
    .array(
      z.object({
        productId: z.number({ required_error: 'Choose a product', invalid_type_error: 'Choose a product' }).int().positive('Choose a product'),
        variantId: z.number({ invalid_type_error: 'Choose a valid option' }).int().positive().nullable().optional(),
        quantity: z.number({ required_error: 'Quantity is required', invalid_type_error: 'Quantity must be a number' }).int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(100_000, 'Quantity is too large'),
      }),
    )
    .max(100, 'At most 100 lines')
    .default([]),
  discountId: z.number({ invalid_type_error: 'Choose a discount' }).int().positive().nullable().optional(),
  date: dateSchema('Date').optional(),
});

/**
 * Prices a hypothetical order without saving anything, so staff can see exactly how a total is
 * made up: variant extras, tax per line, which discount applies and why others do not.
 */
export function pricingRouter(db: DB): Router {
  const router = Router();

  router.post('/preview', requireRole('admin', 'staff'), (req, res) => {
    const input = parse(previewSchema, req.body);
    const date = input.date ?? today();

    let plan: PlanRow | null = null;
    if (input.planId) {
      plan = get<PlanRow>(db, 'SELECT * FROM plans WHERE id = ?', input.planId) ?? null;
      if (!plan) invalidField('planId', 'Choose an existing plan');
      else if (!isPlanAvailable(plan, date)) invalidField('planId', `${plan.name} is not available on ${date}`);
    }
    if (!plan && input.lines.length === 0) invalidField('lines', 'Add a plan or at least one product');

    const built = buildLines(db, plan, input.lines);
    const lineInputs = built.map((l) => ({ key: l.key, productId: l.productId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, taxRateBp: l.taxRateBp }));

    const states = loadDiscountStates(db);
    const considered = states
      .filter((s) => s.isActive)
      .map((s) => {
        const unavailable = discountUnavailableReason(s, date);
        const ev = unavailable ? null : evaluateDiscount(s, lineInputs);
        return { state: s, applies: !!ev?.applies, reason: unavailable ?? ev?.reason, amountMinor: ev?.amountMinor ?? 0 };
      });

    let chosen: { id: number; name: string; amountMinor: number; eligibleKeys: (number | string)[] } | null = null;
    let reasonNone: string | undefined;
    if (input.discountId) {
      const picked = considered.find((c) => c.state.id === input.discountId);
      if (!picked) {
        const exists = states.find((s) => s.id === input.discountId);
        reasonNone = exists ? `${exists.name}: ${discountStatus(exists, date).replace('_', ' ')}` : 'That discount does not exist';
      } else if (!picked.applies) reasonNone = `${picked.state.name}: ${picked.reason}`;
      else {
        const ev = evaluateDiscount(picked.state, lineInputs);
        chosen = { id: picked.state.id, name: picked.state.name, amountMinor: ev.amountMinor, eligibleKeys: ev.eligibleKeys };
      }
    } else {
      const best = chooseBestDiscount(states, lineInputs, date);
      if (best) chosen = { id: best.rule.id, name: best.rule.name, amountMinor: best.evaluation.amountMinor, eligibleKeys: best.evaluation.eligibleKeys };
    }

    const totals = priceLines(lineInputs, chosen);
    res.json({
      date,
      plan: plan && { id: plan.id, name: plan.name, billingPeriod: plan.billing_period, price: fromMinor(plan.price_minor) },
      lines: totals.lines.map((l, i) => {
        const b = built[i]!;
        return {
          key: b.key,
          kind: b.kind,
          description: b.description,
          productId: b.productId,
          variantId: b.variantId,
          quantity: b.quantity,
          basePrice: fromMinor(b.baseMinor),
          variantExtra: fromMinor(b.variantExtraMinor),
          unitPrice: fromMinor(b.unitPriceMinor),
          taxName: b.taxName,
          taxRatePercent: bpToPercent(b.taxRateBp),
          subtotal: fromMinor(l.subtotalMinor),
          discount: fromMinor(l.discountMinor),
          net: fromMinor(l.netMinor),
          tax: fromMinor(l.taxMinor),
          total: fromMinor(l.totalMinor),
        };
      }),
      discount: {
        applied: chosen && { id: chosen.id, name: chosen.name, amount: fromMinor(chosen.amountMinor) },
        notApplied: reasonNone ?? null,
        considered: considered.map((c) => ({ id: c.state.id, name: c.state.name, applies: c.applies, reason: c.reason ?? null, amount: fromMinor(c.amountMinor) })),
      },
      totals: {
        subtotal: fromMinor(totals.subtotalMinor),
        discount: fromMinor(totals.discountMinor),
        tax: fromMinor(totals.taxMinor),
        total: fromMinor(totals.totalMinor),
      },
    });
  });

  return router;
}
