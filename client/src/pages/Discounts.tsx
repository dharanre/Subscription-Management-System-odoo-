import { Plus, Search, Tag } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, type Page, api, qs } from '../api';
import { useAuth } from '../auth';
import { fmtDate } from '../format';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import { isDate, numToInput, parseMoney, parsePercent, parseWhole } from '../parse';
import type { Discount, DiscountStatus, Product } from '../types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Alert, Badge, useToast } from '../ui/Feedback';
import { AffixField, CheckboxField, SelectField, TextField } from '../ui/Field';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';

const PAGE_SIZE = 10;
const STATUS: Record<DiscountStatus, { tone: 'ok' | 'warn' | 'bad' | 'mute'; label: string }> = {
  active: { tone: 'ok', label: 'Active' },
  scheduled: { tone: 'warn', label: 'Scheduled' },
  expired: { tone: 'mute', label: 'Expired' },
  used_up: { tone: 'bad', label: 'Used up' },
  inactive: { tone: 'mute', label: 'Switched off' },
};

export function DiscountsPage() {
  usePageTitle('Discounts');
  const { user } = useAuth();
  const { money } = useMoney();
  const isAdmin = user?.role === 'admin';
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const [editing, setEditing] = useState<Discount | 'new' | null>(null);

  const list = useQuery(() => api.get<Page<Discount>>(`/discounts${qs({ page, pageSize: PAGE_SIZE, q: search, status })}`), [page, search, status]);
  const items = list.data?.items ?? [];
  const amount = (d: Discount) => (d.kind === 'percent' ? `${d.value}% off` : `${money(d.value)} off`);

  return (
    <>
      <PageHeader
        title="Discounts"
        description="Rules that cut the price automatically. A discount that qualifies appears on the next invoice by itself and stops when it expires or runs out."
        actions={isAdmin && <Button icon={<Plus size={18} />} onClick={() => setEditing('new')}>New discount</Button>}
      />
      <section className="card">
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input className="input" type="search" placeholder="Search discounts" aria-label="Search discounts" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          <select className="select" aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <QueryStates
          query={list}
          isEmpty={!!list.data && items.length === 0}
          emptyIcon={<Tag size={22} />}
          emptyTitle={search || status ? 'No discounts match' : 'No discount rules yet'}
          emptyText={isAdmin ? 'Create a rule, for example a percentage off when a customer takes more seats.' : 'Only admins can create discount rules.'}
          emptyAction={isAdmin && !search && !status ? <Button onClick={() => setEditing('new')}>New discount</Button> : undefined}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Discount</th><th className="hide-sm">Applies to</th><th className="hide-sm">Conditions</th><th className="hide-sm">Valid</th><th>Used</th><th>Status</th></tr>
              </thead>
              <tbody>
                {items.map((d) => {
                  const s = STATUS[d.status];
                  const conditions = [d.minQuantity > 0 && `${d.minQuantity}+ units`, d.minPurchase > 0 && `${money(d.minPurchase)}+ spend`].filter(Boolean);
                  return (
                    <tr key={d.id}>
                      <td>
                        <button className="link-btn" onClick={() => setEditing(d)}>{d.name}</button> {d.isDemo && <Badge plain>Demo</Badge>}
                        <div className="cell-sub">{amount(d)}</div>
                      </td>
                      <td className="hide-sm">{d.scope === 'subscription' ? 'Whole subscription' : d.products.map((p) => p.name).join(', ')}</td>
                      <td className="hide-sm">{conditions.length ? conditions.join(' · ') : <span className="muted">None</span>}</td>
                      <td className="num hide-sm">
                        {fmtDate(d.startDate)}
                        <div className="cell-sub">{d.endDate ? `to ${fmtDate(d.endDate)}` : 'No end date'}</div>
                      </td>
                      <td className="num">
                        {d.usageLimit === null ? (
                          `${d.usageCount} times`
                        ) : (
                          <>
                            {d.usageCount} / {d.usageLimit}
                            <div className="meter" data-full={d.usageCount >= d.usageLimit}><span style={{ width: `${Math.min(100, (d.usageCount / d.usageLimit) * 100)}%` }} /></div>
                          </>
                        )}
                      </td>
                      <td><Badge tone={s.tone}>{s.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.data && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
        </QueryStates>
      </section>
      <DiscountDialog target={editing} canEdit={isAdmin} onClose={() => setEditing(null)} onSaved={list.reload} />
    </>
  );
}

interface FormState {
  name: string;
  kind: 'fixed' | 'percent';
  value: string;
  scope: 'products' | 'subscription';
  productIds: number[];
  minPurchase: string;
  minQuantity: string;
  startDate: string;
  endDate: string;
  usageLimit: string;
  isActive: boolean;
}
const today = () => new Date().toISOString().slice(0, 10);
const blank = (): FormState => ({ name: '', kind: 'percent', value: '', scope: 'subscription', productIds: [], minPurchase: '0', minQuantity: '0', startDate: today(), endDate: '', usageLimit: '', isActive: true });

function DiscountDialog({ target, canEdit, onClose, onSaved }: { target: Discount | 'new' | null; canEdit: boolean; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const { symbol } = useMoney();
  const isNew = target === 'new';
  const discount = target && target !== 'new' ? target : null;
  const [form, setForm] = useState<FormState>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const products = useQuery(() => api.get<Page<Product>>('/products?pageSize=100&active=true'), [target !== null]);

  useEffect(() => {
    setErrors({});
    setFormError('');
    setForm(
      discount
        ? { name: discount.name, kind: discount.kind, value: numToInput(discount.value), scope: discount.scope, productIds: discount.products.map((p) => p.id), minPurchase: numToInput(discount.minPurchase), minQuantity: String(discount.minQuantity), startDate: discount.startDate, endDate: discount.endDate ?? '', usageLimit: discount.usageLimit === null ? '' : String(discount.usageLimit), isActive: discount.isActive }
        : blank(),
    );
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleProduct = (id: number) => set('productIds', form.productIds.includes(id) ? form.productIds.filter((x) => x !== id) : [...form.productIds, id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = 'Name is required';
    const value = form.kind === 'percent' ? parsePercent(form.value, 'Percentage') : parseMoney(form.value, 'Amount');
    if (!value.ok) next.value = value.error;
    else if (value.value <= 0) next.value = 'Must be greater than zero';
    const minPurchase = parseMoney(form.minPurchase || '0', 'Minimum purchase');
    const minQty = parseWhole(form.minQuantity || '0', 'Minimum quantity', 0);
    if (!minPurchase.ok) next.minPurchase = minPurchase.error;
    if (!minQty.ok) next.minQuantity = minQty.error;
    if (!isDate(form.startDate)) next.startDate = 'Choose a valid date';
    if (form.endDate && !isDate(form.endDate)) next.endDate = 'Choose a valid date';
    else if (form.endDate && form.endDate < form.startDate) next.endDate = 'Must be on or after the start date';
    const limit = form.usageLimit.trim() ? parseWhole(form.usageLimit, 'Usage limit', 1) : null;
    if (limit && !limit.ok) next.usageLimit = limit.error;
    if (form.scope === 'products' && form.productIds.length === 0) next.productIds = 'Choose at least one product';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length || !value.ok || !minPurchase.ok || !minQty.ok || (limit && !limit.ok)) return;

    const body = {
      name: form.name.trim(),
      kind: form.kind,
      value: value.value,
      scope: form.scope,
      productIds: form.scope === 'products' ? form.productIds : [],
      minPurchase: minPurchase.value,
      minQuantity: minQty.value,
      startDate: form.startDate,
      endDate: form.endDate || null,
      usageLimit: limit && limit.ok ? limit.value : null,
      ...(isNew ? {} : { isActive: form.isActive }),
    };
    setBusy(true);
    try {
      await (isNew ? api.post('/discounts', body) : api.patch(`/discounts/${discount!.id}`, body));
      toast.success(`${body.name} saved.`);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof Error ? err.message : 'Could not save the discount.');
    } finally {
      setBusy(false);
    }
  }

  const off = !canEdit;
  return (
    <Dialog
      open={target !== null}
      wide
      title={isNew ? 'New discount' : (discount?.name ?? 'Discount')}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form="discount-form" loading={busy}>{isNew ? 'Create discount' : 'Save changes'}</Button>}
        </>
      }
    >
      <form id="discount-form" className="dialog__body" onSubmit={submit} noValidate>
        {off && <Alert tone="info">Only admins can create or change discount rules.</Alert>}
        {formError && <Alert>{formError}</Alert>}
        {discount && discount.unavailableReason && <Alert tone="info">Not applying right now: {discount.unavailableReason}.</Alert>}
        <div className="form-grid">
          <div className="span-2"><TextField label="Name" value={form.name} onChange={(v) => set('name', v)} error={errors.name} disabled={off} autoFocus /></div>
          <SelectField label="Type" value={form.kind} onChange={(v) => set('kind', v as 'fixed' | 'percent')} error={errors.kind} disabled={off}>
            <option value="percent">Percentage</option>
            <option value="fixed">Fixed amount</option>
          </SelectField>
          {form.kind === 'percent'
            ? <AffixField label="Percentage off" suffix="%" value={form.value} onChange={(v) => set('value', v)} error={errors.value} disabled={off} placeholder="10" />
            : <AffixField label="Amount off" prefix={symbol} value={form.value} onChange={(v) => set('value', v)} error={errors.value} disabled={off} placeholder="0.00" />}
          <SelectField label="Applies to" value={form.scope} onChange={(v) => set('scope', v as 'products' | 'subscription')} disabled={off}>
            <option value="subscription">Whole subscription</option>
            <option value="products">Specific products</option>
          </SelectField>
          <span />
          {form.scope === 'products' && (
            <div className="span-2 field">
              <span className="field__label">Products covered</span>
              <div className="chips" role="group" aria-label="Products covered">
                {(products.data?.items ?? []).map((p) => (
                  <button key={p.id} type="button" disabled={off} className="chip" aria-pressed={form.productIds.includes(p.id)} onClick={() => toggleProduct(p.id)} style={form.productIds.includes(p.id) ? { background: 'var(--brand-50)', borderColor: 'var(--brand-500)', color: 'var(--brand-800)' } : { cursor: 'pointer' }}>
                    {p.name}
                  </button>
                ))}
                {discount && discount.products.filter((p) => !(products.data?.items ?? []).some((x) => x.id === p.id)).map((p) => (
                  <button key={p.id} type="button" disabled={off} className="chip" aria-pressed={form.productIds.includes(p.id)} onClick={() => toggleProduct(p.id)} style={form.productIds.includes(p.id) ? { background: 'var(--brand-50)', borderColor: 'var(--brand-500)' } : undefined}>
                    {p.name} (inactive)
                  </button>
                ))}
              </div>
              {errors.productIds && <p className="field__error" role="alert">{errors.productIds}</p>}
            </div>
          )}
          <AffixField label="Minimum purchase" prefix={symbol} value={form.minPurchase} onChange={(v) => set('minPurchase', v)} error={errors.minPurchase} disabled={off} hint="Of the products it covers. 0 for none." />
          <TextField label="Minimum quantity" inputMode="numeric" value={form.minQuantity} onChange={(v) => set('minQuantity', v)} error={errors.minQuantity} disabled={off} hint="Units on the lines it covers. 0 for none." />
          <TextField label="Starts" type="date" value={form.startDate} onChange={(v) => set('startDate', v)} error={errors.startDate} disabled={off} />
          <TextField label="Ends (optional)" type="date" value={form.endDate} onChange={(v) => set('endDate', v)} error={errors.endDate} disabled={off} hint="Applies through this date." />
          <TextField label="Usage limit (optional)" inputMode="numeric" value={form.usageLimit} onChange={(v) => set('usageLimit', v)} error={errors.usageLimit} disabled={off} hint={discount ? `Used ${discount.usageCount} time${discount.usageCount === 1 ? '' : 's'} so far.` : 'How many invoices it may be applied to. Empty for unlimited.'} />
        </div>
        {!isNew && canEdit && <CheckboxField label="Discount is switched on" hint="Turn off to stop it applying without deleting the rule." checked={form.isActive} onChange={(v) => set('isActive', v)} />}
      </form>
    </Dialog>
  );
}
