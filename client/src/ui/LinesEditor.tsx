import { Minus, Plus } from 'lucide-react';
import { useMoney } from '../meta';
import type { Product } from '../types';
import { Button } from './Button';
import { SelectField, TextField } from './Field';

export interface LineDraft {
  id: number;
  productId: string;
  variantId: string;
  quantity: string;
}

let nextId = 1;
export const newLine = (partial: Partial<Omit<LineDraft, 'id'>> = {}): LineDraft => ({ id: nextId++, productId: '', variantId: '', quantity: '1', ...partial });

/** Product lines for a quotation, subscription or template. Errors are keyed `${index}.${field}`. */
export function LinesEditor({
  lines,
  onChange,
  products,
  errors = {},
  disabled,
  emptyHint,
}: {
  lines: LineDraft[];
  onChange(lines: LineDraft[]): void;
  products: Product[];
  errors?: Record<string, string>;
  disabled?: boolean;
  emptyHint?: string;
}) {
  const { money } = useMoney();
  const update = (id: number, patch: Partial<LineDraft>) => onChange(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {lines.length === 0 && emptyHint && <p className="muted small">{emptyHint}</p>}
      {lines.map((l, i) => {
        const product = products.find((p) => String(p.id) === l.productId);
        const options = product?.variants.filter((v) => v.isActive || String(v.id) === l.variantId) ?? [];
        return (
          <div key={l.id} className="calc-line">
            <SelectField label="Product" value={l.productId} disabled={disabled} onChange={(v) => update(l.id, { productId: v, variantId: '' })} error={errors[`${i}.productId`]}>
              <option value="">Choose a product</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {money(p.salesPrice)}
                </option>
              ))}
            </SelectField>
            <TextField label="Qty" inputMode="numeric" value={l.quantity} disabled={disabled} onChange={(v) => update(l.id, { quantity: v })} error={errors[`${i}.quantity`]} />
            <Button variant="ghost" size="sm" aria-label={`Remove line ${i + 1}`} disabled={disabled} onClick={() => onChange(lines.filter((x) => x.id !== l.id))} icon={<Minus size={16} />} />
            {options.length > 0 && (
              <div className="full">
                <SelectField label="Option" value={l.variantId} disabled={disabled} onChange={(v) => update(l.id, { variantId: v })} error={errors[`${i}.variantId`]}>
                  <option value="">Standard</option>
                  {options.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.attribute}: {v.value}
                      {v.extraPrice > 0 ? ` (+${money(v.extraPrice)})` : ''}
                    </option>
                  ))}
                </SelectField>
              </div>
            )}
          </div>
        );
      })}
      {!disabled && (
        <div>
          <Button variant="secondary" size="sm" icon={<Plus size={16} />} onClick={() => onChange([...lines, newLine()])}>
            Add a line
          </Button>
        </div>
      )}
    </div>
  );
}

/** Converts drafts to the API's line shape. Returns per-line errors instead of sending incomplete lines. */
export function linesToRequest(lines: LineDraft[]): { ok: true; value: { productId: number; variantId: number | null; quantity: number }[] } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const value = lines.map((l, i) => {
    if (!l.productId) errors[`${i}.productId`] = 'Choose a product';
    if (!/^\d+$/.test(l.quantity.trim()) || Number(l.quantity) < 1) errors[`${i}.quantity`] = 'Enter a whole number, 1 or more';
    return { productId: Number(l.productId), variantId: l.variantId ? Number(l.variantId) : null, quantity: Number(l.quantity) };
  });
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** Maps server errors like `lines.2.quantity` to the editor's `2.quantity` keys. */
export function lineErrorsFrom(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    const m = k.match(/^lines\.(\d+)\.(\w+)$/);
    if (m) out[`${m[1]}.${m[2]}`] = v;
  }
  return out;
}
