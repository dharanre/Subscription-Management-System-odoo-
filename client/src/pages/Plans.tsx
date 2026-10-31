import { CalendarClock, Plus, Search } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, type Page, api, qs } from '../api';
import { useAuth } from '../auth';
import { fmtDate } from '../format';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import { isDate, numToInput, parseMoney, parseWhole } from '../parse';
import { type BillingPeriod, PERIODS, type Plan, periodUnit } from '../types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Alert, Badge, useToast } from '../ui/Feedback';
import { AffixField, CheckboxField, SelectField, TextAreaField, TextField } from '../ui/Field';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';

const PAGE_SIZE = 10;

function availability(p: Plan): { tone: 'ok' | 'warn' | 'mute'; label: string } {
  if (!p.isActive) return { tone: 'mute', label: 'Inactive' };
  if (p.isAvailable) return { tone: 'ok', label: 'On sale' };
  const today = new Date().toISOString().slice(0, 10);
  return today < p.availableFrom ? { tone: 'warn', label: 'Not yet on sale' } : { tone: 'mute', label: 'Ended' };
}

export function PlansPage() {
  usePageTitle('Plans');
  const { user } = useAuth();
  const { money } = useMoney();
  const isAdmin = user?.role === 'admin';
  const [q, setQ] = useState('');
  const [period, setPeriod] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);

  const list = useQuery(() => api.get<Page<Plan>>(`/plans${qs({ page, pageSize: PAGE_SIZE, q: search, period })}`), [page, search, period]);
  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Plans"
        description="How often and for how much a subscription bills, when the plan can be sold, and what customers may do with it once it is running."
        actions={isAdmin && <Button icon={<Plus size={18} />} onClick={() => setEditing('new')}>New plan</Button>}
      />
      <section className="card">
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input className="input" type="search" placeholder="Search plans" aria-label="Search plans" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          <select className="select" aria-label="Filter by billing period" value={period} onChange={(e) => { setPeriod(e.target.value); setPage(1); }}>
            <option value="">All billing periods</option>
            {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <QueryStates
          query={list}
          isEmpty={!!list.data && items.length === 0}
          emptyIcon={<CalendarClock size={22} />}
          emptyTitle={search || period ? 'No plans match' : 'No plans yet'}
          emptyText={isAdmin ? 'Create a plan to set a price, a billing interval and what customers can do with it.' : 'Adjust the filters to see more.'}
          emptyAction={isAdmin && !search && !period ? <Button onClick={() => setEditing('new')}>New plan</Button> : undefined}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th className="hide-sm">Min qty</th>
                  <th className="hide-sm">Available</th>
                  <th className="hide-sm">Lifecycle</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const a = availability(p);
                  return (
                    <tr key={p.id}>
                      <td>
                        <button className="link-btn" onClick={() => setEditing(p)}>{p.name}</button> {p.isDemo && <Badge plain>Demo</Badge>}
                        {p.description && <div className="cell-sub">{p.description}</div>}
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {money(p.price)}
                        <div className="cell-sub">per {periodUnit(p.billingPeriod)}</div>
                      </td>
                      <td className="num hide-sm">{p.minQuantity}</td>
                      <td className="num hide-sm">
                        {fmtDate(p.availableFrom)}
                        <div className="cell-sub">{p.availableTo ? `to ${fmtDate(p.availableTo)}` : 'No end date'}</div>
                      </td>
                      <td className="hide-sm">
                        <div className="chips">
                          {p.autoClose && <span className="chip">Auto-closes</span>}
                          {p.allowEarlyClose && <span className="chip">Early close</span>}
                          {p.allowPause && <span className="chip">Pausable</span>}
                          {p.allowRenewal && <span className="chip">Renewable</span>}
                          {!p.autoClose && !p.allowEarlyClose && !p.allowPause && !p.allowRenewal && <span className="muted">Fixed</span>}
                        </div>
                      </td>
                      <td><Badge tone={a.tone}>{a.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.data && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
        </QueryStates>
      </section>
      <PlanDialog target={editing} canEdit={isAdmin} onClose={() => setEditing(null)} onSaved={list.reload} />
    </>
  );
}

interface FormState {
  name: string;
  description: string;
  price: string;
  billingPeriod: BillingPeriod;
  minQuantity: string;
  availableFrom: string;
  availableTo: string;
  autoClose: boolean;
  allowEarlyClose: boolean;
  allowPause: boolean;
  allowRenewal: boolean;
  isActive: boolean;
}
const today = () => new Date().toISOString().slice(0, 10);
const blank = (): FormState => ({ name: '', description: '', price: '', billingPeriod: 'monthly', minQuantity: '1', availableFrom: today(), availableTo: '', autoClose: false, allowEarlyClose: false, allowPause: false, allowRenewal: false, isActive: true });

function PlanDialog({ target, canEdit, onClose, onSaved }: { target: Plan | 'new' | null; canEdit: boolean; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const { symbol } = useMoney();
  const isNew = target === 'new';
  const plan = target && target !== 'new' ? target : null;
  const [form, setForm] = useState<FormState>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setErrors({});
    setFormError('');
    setForm(
      plan
        ? { name: plan.name, description: plan.description ?? '', price: numToInput(plan.price), billingPeriod: plan.billingPeriod, minQuantity: String(plan.minQuantity), availableFrom: plan.availableFrom, availableTo: plan.availableTo ?? '', autoClose: plan.autoClose, allowEarlyClose: plan.allowEarlyClose, allowPause: plan.allowPause, allowRenewal: plan.allowRenewal, isActive: plan.isActive }
        : blank(),
    );
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = 'Name is required';
    const price = parseMoney(form.price, 'Price');
    const minQty = parseWhole(form.minQuantity, 'Minimum quantity', 1);
    if (!price.ok) next.price = price.error;
    if (!minQty.ok) next.minQuantity = minQty.error;
    if (!isDate(form.availableFrom)) next.availableFrom = 'Choose a valid date';
    if (form.availableTo && !isDate(form.availableTo)) next.availableTo = 'Choose a valid date';
    else if (form.availableTo && form.availableTo < form.availableFrom) next.availableTo = 'Must be on or after the start date';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length || !price.ok || !minQty.ok) return;

    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      price: price.value,
      billingPeriod: form.billingPeriod,
      minQuantity: minQty.value,
      availableFrom: form.availableFrom,
      availableTo: form.availableTo || null,
      autoClose: form.autoClose,
      allowEarlyClose: form.allowEarlyClose,
      allowPause: form.allowPause,
      allowRenewal: form.allowRenewal,
      ...(isNew ? {} : { isActive: form.isActive }),
    };
    setBusy(true);
    try {
      await (isNew ? api.post('/plans', body) : api.patch(`/plans/${plan!.id}`, body));
      toast.success(isNew ? `${body.name} created.` : `${body.name} saved.`);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof Error ? err.message : 'Could not save the plan.');
    } finally {
      setBusy(false);
    }
  }

  const off = !canEdit;
  return (
    <Dialog
      open={target !== null}
      wide
      title={isNew ? 'New plan' : (plan?.name ?? 'Plan')}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form="plan-form" loading={busy}>{isNew ? 'Create plan' : 'Save changes'}</Button>}
        </>
      }
    >
      <form id="plan-form" className="dialog__body" onSubmit={submit} noValidate>
        {off && <Alert tone="info">Only admins can change plans.</Alert>}
        {formError && <Alert>{formError}</Alert>}
        <div className="form-grid">
          <div className="span-2"><TextField label="Name" value={form.name} onChange={(v) => set('name', v)} error={errors.name} disabled={off} autoFocus /></div>
          <div className="span-2"><TextAreaField label="Description" value={form.description} onChange={(v) => set('description', v)} error={errors.description} disabled={off} rows={2} /></div>
          <AffixField label="Price per billing period" prefix={symbol} value={form.price} onChange={(v) => set('price', v)} error={errors.price} disabled={off} placeholder="0.00" hint="Charged as a plan fee on every invoice. Use 0 if only products are billed." />
          <SelectField label="Billing period" value={form.billingPeriod} onChange={(v) => set('billingPeriod', v as BillingPeriod)} error={errors.billingPeriod} disabled={off}>
            {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </SelectField>
          <TextField label="Minimum quantity" inputMode="numeric" value={form.minQuantity} onChange={(v) => set('minQuantity', v)} error={errors.minQuantity} disabled={off} hint="Fewest units allowed on each product line." />
          <span />
          <TextField label="Available from" type="date" value={form.availableFrom} onChange={(v) => set('availableFrom', v)} error={errors.availableFrom} disabled={off} />
          <TextField label="Available until (optional)" type="date" value={form.availableTo} onChange={(v) => set('availableTo', v)} error={errors.availableTo} disabled={off} hint="Leave empty for no end date." />
        </div>
        <div className="form-section">
          <h3>What can happen to a subscription on this plan</h3>
          <CheckboxField label="Close automatically when the plan ends" hint="Subscriptions close themselves on their expiry date." checked={form.autoClose} onChange={(v) => set('autoClose', v)} disabled={off} />
          <CheckboxField label="Allow closing early" hint="Staff or the customer can end it before the expiry date." checked={form.allowEarlyClose} onChange={(v) => set('allowEarlyClose', v)} disabled={off} />
          <CheckboxField label="Allow pausing" hint="Billing can be paused and resumed." checked={form.allowPause} onChange={(v) => set('allowPause', v)} disabled={off} />
          <CheckboxField label="Allow renewal" hint="A subscription can be renewed for another term." checked={form.allowRenewal} onChange={(v) => set('allowRenewal', v)} disabled={off} />
          {!isNew && canEdit && <CheckboxField label="Plan is active" hint="Turn off to stop selling it. Running subscriptions are not affected." checked={form.isActive} onChange={(v) => set('isActive', v)} />}
        </div>
      </form>
    </Dialog>
  );
}
