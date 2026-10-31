import { Package, Plus, Search } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, type Page, api, qs } from '../api';
import { useAuth } from '../auth';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import { numToInput, parseMoney } from '../parse';
import { type Product, type ProductType, type Tax, PRODUCT_TYPES, type Variant, typeLabel } from '../types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Alert, Badge, useToast } from '../ui/Feedback';
import { AffixField, SelectField, TextAreaField, TextField } from '../ui/Field';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';

const PAGE_SIZE = 10;

export function ProductsPage() {
  usePageTitle('Products');
  const { user } = useAuth();
  const { money } = useMoney();
  const isAdmin = user?.role === 'admin';
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [active, setActive] = useState('true');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const [editing, setEditing] = useState<Product | 'new' | null>(null);

  const list = useQuery(() => api.get<Page<Product>>(`/products${qs({ page, pageSize: PAGE_SIZE, q: search, type, active })}`), [page, search, type, active]);
  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Products"
        description="What Brightloop sells. Variants change the price, for example the Odoo brand adds an amount on top of the base price."
        actions={
          isAdmin && (
            <Button icon={<Plus size={18} />} onClick={() => setEditing('new')}>
              New product
            </Button>
          )
        }
      />
      <section className="card">
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input className="input" type="search" placeholder="Search products" aria-label="Search products" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          <select className="select" aria-label="Filter by type" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
            <option value="">All types</option>
            {PRODUCT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <select className="select" aria-label="Filter by status" value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
            <option value="">All</option>
          </select>
        </div>

        <QueryStates
          query={list}
          isEmpty={!!list.data && items.length === 0}
          emptyIcon={<Package size={22} />}
          emptyTitle={search || type || active !== 'true' ? 'No products match' : 'No products yet'}
          emptyText={isAdmin ? 'Adjust the filters, or add a product to start building plans around it.' : 'Adjust the filters to see more.'}
          emptyAction={isAdmin && !search && !type ? <Button onClick={() => setEditing('new')}>New product</Button> : undefined}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="hide-sm">Type</th>
                  <th style={{ textAlign: 'right' }}>Sales price</th>
                  <th className="hide-sm" style={{ textAlign: 'right' }}>Cost</th>
                  <th className="hide-sm">Variants</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <button className="link-btn" onClick={() => setEditing(p)}>{p.name}</button>{' '}
                      {p.isDemo && <Badge plain>Demo</Badge>}
                      <div className="cell-sub">{p.tax ? `${p.tax.name} (${p.tax.ratePercent}%)` : 'Default tax'}</div>
                    </td>
                    <td className="hide-sm">{typeLabel(p.type)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(p.salesPrice)}</td>
                    <td className="num muted hide-sm" style={{ textAlign: 'right' }}>{money(p.costPrice)}</td>
                    <td className="hide-sm">
                      {p.variants.length === 0 ? (
                        <span className="muted">None</span>
                      ) : (
                        <div className="chips">
                          {p.variants.filter((v) => v.isActive).slice(0, 3).map((v) => (
                            <span key={v.id} className="chip">{v.value}{v.extraPrice > 0 ? ` +${money(v.extraPrice)}` : ''}</span>
                          ))}
                          {p.variants.filter((v) => v.isActive).length > 3 && <span className="chip">+{p.variants.filter((v) => v.isActive).length - 3}</span>}
                        </div>
                      )}
                    </td>
                    <td>{p.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="mute">Inactive</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
        </QueryStates>
      </section>

      <ProductDialog
        target={editing}
        canEdit={isAdmin}
        onClose={() => setEditing(null)}
        onSaved={() => { list.reload(); }}
      />
    </>
  );
}

interface FormState {
  name: string;
  type: ProductType;
  salesPrice: string;
  costPrice: string;
  taxId: string;
  notes: string;
  isActive: boolean;
}
const EMPTY: FormState = { name: '', type: 'software', salesPrice: '', costPrice: '', taxId: '', notes: '', isActive: true };

function ProductDialog({ target, canEdit, onClose, onSaved }: { target: Product | 'new' | null; canEdit: boolean; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const { symbol, money } = useMoney();
  const isNew = target === 'new';
  const product = target && target !== 'new' ? target : null;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Product | null>(null);
  const taxes = useQuery(() => api.get<Page<Tax>>('/taxes?active=true&pageSize=100'), [target !== null]);
  const current = saved ?? product;

  useEffect(() => {
    setSaved(null);
    setErrors({});
    setFormError('');
    if (product) {
      setForm({
        name: product.name,
        type: product.type,
        salesPrice: numToInput(product.salesPrice),
        costPrice: numToInput(product.costPrice),
        taxId: product.taxId ? String(product.taxId) : '',
        notes: product.notes ?? '',
        isActive: product.isActive,
      });
    } else setForm(EMPTY);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = 'Name is required';
    const sales = parseMoney(form.salesPrice, 'Sales price');
    const cost = parseMoney(form.costPrice, 'Cost price');
    if (!sales.ok) next.salesPrice = sales.error;
    if (!cost.ok) next.costPrice = cost.error;
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length || !sales.ok || !cost.ok) return;

    const body = {
      name: form.name.trim(),
      type: form.type,
      salesPrice: sales.value,
      costPrice: cost.value,
      taxId: form.taxId ? Number(form.taxId) : null,
      notes: form.notes.trim() || null,
      ...(isNew ? {} : { isActive: form.isActive }),
    };
    setBusy(true);
    try {
      const res = isNew ? await api.post<{ product: Product }>('/products', body) : await api.patch<{ product: Product }>(`/products/${product!.id}`, body);
      toast.success(isNew ? `${res.product.name} created. You can add variants now.` : `${res.product.name} saved.`);
      onSaved();
      if (isNew) setSaved(res.product);
      else onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof Error ? err.message : 'Could not save the product.');
    } finally {
      setBusy(false);
    }
  }

  const margin = (() => {
    const s = parseMoney(form.salesPrice);
    const c = parseMoney(form.costPrice);
    if (!s.ok || !c.ok || s.value === 0) return null;
    return ((s.value - c.value) / s.value) * 100;
  })();

  const justCreated = isNew && saved;
  const title = isNew && !saved ? 'New product' : (current?.name ?? 'Product');

  return (
    <Dialog
      open={target !== null}
      wide
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{canEdit ? (justCreated ? 'Done' : 'Cancel') : 'Close'}</Button>
          {canEdit && !justCreated && <Button type="submit" form="product-form" loading={busy}>{isNew ? 'Create product' : 'Save changes'}</Button>}
        </>
      }
    >
      <div className="dialog__body">
        {!canEdit && <Alert tone="info">Only admins can change products. You can see everything staff need to quote.</Alert>}
        {formError && <Alert>{formError}</Alert>}
        <form id="product-form" onSubmit={(e) => { if (justCreated) e.preventDefault(); else void submit(e); }} noValidate className="form-grid">
          <div className="span-2">
            <TextField label="Name" value={form.name} onChange={(v) => set('name', v)} error={errors.name} disabled={!canEdit || !!justCreated} autoFocus />
          </div>
          <SelectField label="Type" value={form.type} onChange={(v) => set('type', v as ProductType)} error={errors.type} disabled={!canEdit || !!justCreated}>
            {PRODUCT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </SelectField>
          <SelectField label="Tax" value={form.taxId} onChange={(v) => set('taxId', v)} error={errors.taxId} hint="Leave on default to use the standard tax rule." disabled={!canEdit || !!justCreated}>
            <option value="">Default tax rule</option>
            {(taxes.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.ratePercent}%)</option>)}
          </SelectField>
          <AffixField label="Sales price" prefix={symbol} value={form.salesPrice} onChange={(v) => set('salesPrice', v)} error={errors.salesPrice} disabled={!canEdit || !!justCreated} placeholder="0.00" />
          <AffixField label="Cost price" prefix={symbol} value={form.costPrice} onChange={(v) => set('costPrice', v)} error={errors.costPrice} disabled={!canEdit || !!justCreated} placeholder="0.00" hint={margin === null ? undefined : `Margin ${margin.toFixed(1)}%`} />
          <div className="span-2">
            <TextAreaField label="Notes" value={form.notes} onChange={(v) => set('notes', v)} error={errors.notes} disabled={!canEdit || !!justCreated} />
          </div>
          {!isNew && canEdit && (
            <div className="span-2">
              <label className="check">
                <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} />
                <span>
                  <span className="check__label">Available to sell</span>
                  <span className="check__hint">Turn off to stop new subscriptions using it. Existing records are kept.</span>
                </span>
              </label>
            </div>
          )}
        </form>

        {current && <VariantsEditor product={current} canEdit={canEdit} money={money} symbol={symbol} onChanged={(p) => { setSaved(p); onSaved(); }} />}
        {isNew && !saved && <p className="muted small">Variants can be added right after the product is created.</p>}
      </div>
    </Dialog>
  );
}

function VariantsEditor({ product, canEdit, money, symbol, onChanged }: { product: Product; canEdit: boolean; money(n: number): string; symbol: string; onChanged(p: Product): void }) {
  const toast = useToast();
  const [variants, setVariants] = useState<Variant[]>(product.variants);
  const [attribute, setAttribute] = useState('Brand');
  const [value, setValue] = useState('');
  const [extra, setExtra] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => setVariants(product.variants), [product]);

  async function refresh() {
    const res = await api.get<{ product: Product }>(`/products/${product.id}`);
    setVariants(res.product.variants);
    onChanged(res.product);
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const extraParsed = parseMoney(extra || '0', 'Extra price');
    const next: Record<string, string> = {};
    if (!attribute.trim()) next.attribute = 'Required';
    if (!value.trim()) next.value = 'Required';
    if (!extraParsed.ok) next.extraPrice = extraParsed.error;
    setErrors(next);
    if (Object.keys(next).length || !extraParsed.ok) return;
    setBusy(true);
    try {
      await api.post(`/products/${product.id}/variants`, { attribute: attribute.trim(), value: value.trim(), extraPrice: extraParsed.value });
      setValue('');
      setExtra('');
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else toast.error(err instanceof Error ? err.message : 'Could not add the variant.');
    } finally {
      setBusy(false);
    }
  }

  async function patch(v: Variant, body: Record<string, unknown>) {
    try {
      await api.patch(`/products/${product.id}/variants/${v.id}`, body);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the variant.');
    }
  }

  return (
    <div className="form-section">
      <h3>
        Variants <span className="muted small">{variants.filter((v) => v.isActive).length} offered</span>
      </h3>
      {variants.length === 0 && <p className="muted small">No variants. Customers buy the base product at {money(product.salesPrice)}.</p>}
      {variants.map((v) => (
        <VariantRow key={v.id} variant={v} base={product.salesPrice} canEdit={canEdit} money={money} symbol={symbol} onSave={(extraPrice) => patch(v, { extraPrice })} onToggle={() => patch(v, { isActive: !v.isActive })} />
      ))}
      {canEdit && (
        <form className="add-variant" onSubmit={add} noValidate>
          <TextField label="Attribute" value={attribute} onChange={setAttribute} error={errors.attribute} placeholder="Brand" />
          <TextField label="Value" value={value} onChange={setValue} error={errors.value} placeholder="Odoo" />
          <AffixField label="Adds to price" prefix={symbol} value={extra} onChange={setExtra} error={errors.extraPrice} placeholder="0.00" />
          <Button type="submit" variant="secondary" loading={busy} icon={<Plus size={16} />}>Add</Button>
        </form>
      )}
    </div>
  );
}

function VariantRow({ variant, base, canEdit, money, symbol, onSave, onToggle }: { variant: Variant; base: number; canEdit: boolean; money(n: number): string; symbol: string; onSave(extra: number): Promise<void>; onToggle(): void }) {
  const [extra, setExtra] = useState(numToInput(variant.extraPrice));
  const [error, setError] = useState('');
  useEffect(() => setExtra(numToInput(variant.extraPrice)), [variant.extraPrice]);
  const parsed = parseMoney(extra, 'Extra price');
  const dirty = parsed.ok && parsed.value !== variant.extraPrice;

  return (
    <div className="variant-row" data-off={!variant.isActive}>
      <div className="variant-row__name">
        {variant.attribute}: {variant.value}
        <small>Sells at {money(base + variant.extraPrice)}{!variant.isActive && ' · not offered'}</small>
      </div>
      {canEdit ? (
        <AffixField label="Adds" aria-label={`Extra price for ${variant.value}`} prefix={symbol} value={extra} onChange={(v) => { setExtra(v); setError(''); }} error={error} />
      ) : (
        <span className="num">+{money(variant.extraPrice)}</span>
      )}
      {canEdit && (
        <div className="variant-row__actions">
          <Button size="sm" variant="secondary" disabled={!dirty} onClick={() => (parsed.ok ? onSave(parsed.value) : setError(parsed.error))}>Save</Button>
          <Button size="sm" variant="ghost" onClick={onToggle}>{variant.isActive ? 'Turn off' : 'Turn on'}</Button>
        </div>
      )}
    </div>
  );
}
