import { Calculator, Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, type Page, api } from '../api';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import { type Discount, type Plan, type Preview, type Product, periodUnit } from '../types';
import { Button } from '../ui/Button';
import { BreakdownTable } from '../ui/Breakdown';
import { Alert, Badge } from '../ui/Feedback';
import { SelectField, TextField } from '../ui/Field';
import { PageHeader } from '../ui/Layout';
import { Spinner } from '../ui/Spinner';

interface LineDraft {
  id: number;
  productId: string;
  variantId: string;
  quantity: string;
}
let nextId = 1;
const newLine = (): LineDraft => ({ id: nextId++, productId: '', variantId: '', quantity: '1' });

/** A what-if pricing tool: nothing is saved. It runs the same engine that prices real subscriptions and invoices. */
export function CalculatorPage() {
  usePageTitle('Price calculator');
  const { money } = useMoney();
  const plans = useQuery(() => api.get<Page<Plan>>('/plans?active=true&pageSize=100'), []);
  const products = useQuery(() => api.get<Page<Product>>('/products?active=true&pageSize=100'), []);
  const discounts = useQuery(() => api.get<Page<Discount>>('/discounts?pageSize=100'), []);

  const [planId, setPlanId] = useState('');
  const [discountId, setDiscountId] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);

  const productList = products.data?.items ?? [];
  const available = (plans.data?.items ?? []).filter((p) => p.isAvailable);

  // Re-price shortly after the last change; only complete lines are sent.
  const request = useDebounced(
    JSON.stringify({
      planId: planId ? Number(planId) : null,
      discountId: discountId ? Number(discountId) : null,
      lines: lines
        .filter((l) => l.productId)
        .map((l) => ({ productId: Number(l.productId), variantId: l.variantId ? Number(l.variantId) : null, quantity: Number(l.quantity) })),
    }),
    250,
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const body = JSON.parse(request) as { planId: number | null; lines: unknown[] };
    if (!body.planId && body.lines.length === 0) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setPending(true);
    api
      .post<Preview>('/pricing/preview', body)
      .then((p) => !cancelled && (setPreview(p), setError(null)))
      .catch((err) => !cancelled && setError(err as ApiError))
      .finally(() => !cancelled && setPending(false));
    return () => {
      cancelled = true;
    };
  }, [request]);

  const update = (id: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const fieldError = (i: number, f: string) => error?.fields[`lines.${i}.${f}`];
  // Errors are indexed by position among the lines that were sent, so map back to the drafts.
  const sentIndex = (draft: LineDraft) => lines.filter((l) => l.productId).findIndex((l) => l.id === draft.id);

  return (
    <>
      <PageHeader title="Price calculator" description="Try a plan, products and quantities and see exactly how the total is made up. Nothing is saved." />
      <div className="calc">
        <section className="card">
          <div className="card__head"><h2>Build an order</h2></div>
          <div className="card__body" style={{ display: 'grid', gap: 16 }}>
            <SelectField label="Plan" value={planId} onChange={setPlanId} error={error?.fields.planId} hint={planId ? undefined : 'Optional. A plan adds its recurring fee and a minimum quantity.'}>
              <option value="">No plan</option>
              {available.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price)} per {periodUnit(p.billingPeriod)}</option>)}
            </SelectField>

            {lines.map((l) => {
              const product = productList.find((p) => String(p.id) === l.productId);
              const idx = sentIndex(l);
              return (
                <div key={l.id} className="calc-line">
                  <SelectField label="Product" value={l.productId} onChange={(v) => update(l.id, { productId: v, variantId: '' })} error={idx >= 0 ? fieldError(idx, 'productId') : undefined}>
                    <option value="">Choose a product</option>
                    {productList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </SelectField>
                  <TextField label="Qty" inputMode="numeric" value={l.quantity} onChange={(v) => update(l.id, { quantity: v })} error={idx >= 0 ? fieldError(idx, 'quantity') : undefined} />
                  <Button variant="ghost" size="sm" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))} icon={<Minus size={16} />} />
                  {product && product.variants.some((v) => v.isActive) && (
                    <div className="full">
                      <SelectField label="Option" value={l.variantId} onChange={(v) => update(l.id, { variantId: v })} error={idx >= 0 ? fieldError(idx, 'variantId') : undefined}>
                        <option value="">Standard</option>
                        {product.variants.filter((v) => v.isActive).map((v) => <option key={v.id} value={v.id}>{v.attribute}: {v.value}{v.extraPrice > 0 ? ` (+${money(v.extraPrice)})` : ''}</option>)}
                      </SelectField>
                    </div>
                  )}
                </div>
              );
            })}
            <div>
              <Button variant="secondary" size="sm" icon={<Plus size={16} />} onClick={() => setLines((ls) => [...ls, newLine()])}>Add a line</Button>
            </div>

            <SelectField label="Discount" value={discountId} onChange={setDiscountId} hint="Automatic picks the discount that saves the most among those that qualify.">
              <option value="">Automatic</option>
              {(discounts.data?.items ?? []).filter((d) => d.status === 'active').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </SelectField>
          </div>
        </section>

        <section className="card" aria-live="polite">
          <div className="card__head">
            <h2>Breakdown</h2>
            {pending && <Spinner label="Calculating" />}
          </div>
          {!preview && !error && (
            <div className="state">
              <div className="state__icon"><Calculator size={22} /></div>
              <h3>Nothing to price yet</h3>
              <p>Choose a plan or a product and the calculation appears here.</p>
            </div>
          )}
          {error && !Object.keys(error.fields).length && <div className="card__body"><Alert>{error.message}</Alert></div>}
          {error && Object.keys(error.fields).length > 0 && <div className="card__body"><Alert>Fix the highlighted fields to see the total.</Alert></div>}
          {preview && !error && (
            <>
              <BreakdownTable
                rows={preview.lines.map((l) => ({
                  key: l.key,
                  description: l.description,
                  detail: `${l.quantity} × ${money(l.unitPrice)}${l.variantExtra > 0 ? ` (${money(l.basePrice)} + ${money(l.variantExtra)} option)` : ''} · ${l.taxName ? `${l.taxName} ${l.taxRatePercent}%` : 'No tax'}`,
                  subtotal: l.subtotal,
                  discount: l.discount,
                  tax: l.tax,
                  total: l.total,
                }))}
                totals={preview.totals}
                totalLabel="Order total"
              />
              <div className="card__body" style={{ display: 'grid', gap: 10, borderTop: '1px solid var(--line)' }}>
                <h3>Discounts</h3>
                {preview.discount.applied && <Alert tone="success"><strong>{preview.discount.applied.name}</strong> saves {money(preview.discount.applied.amount)}. It is taken off before tax.</Alert>}
                {preview.discount.notApplied && <Alert tone="info">{preview.discount.notApplied}</Alert>}
                {preview.discount.considered.length === 0 && <p className="muted small">No discount rules are switched on.</p>}
                <ul className="checklist">
                  {preview.discount.considered.map((c) => (
                    <li key={c.id} style={{ alignItems: 'center' }}>
                      <Badge tone={c.applies ? 'ok' : 'mute'}>{c.applies ? 'Qualifies' : 'No'}</Badge>
                      <span><strong>{c.name}</strong>{c.applies ? ` · ${money(c.amount)} off` : c.reason ? ` · ${c.reason}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
