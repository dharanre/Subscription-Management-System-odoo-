import { ArrowLeft } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, type Page, api } from '../api';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import { isDate } from '../parse';
import type { PaymentTerms, SubscriptionDetail, Template } from '../salesTypes';
import { type Plan, type Preview, type Product, periodUnit } from '../types';
import { BreakdownTable } from '../ui/Breakdown';
import { Button } from '../ui/Button';
import { CustomerPicker, type PickedCustomer } from '../ui/CustomerPicker';
import { Alert, EmptyState, useToast } from '../ui/Feedback';
import { SelectField, TextAreaField, TextField } from '../ui/Field';
import { PageHeader } from '../ui/Layout';
import { type LineDraft, LinesEditor, lineErrorsFrom, linesToRequest, newLine } from '../ui/LinesEditor';
import { Spinner } from '../ui/Spinner';

const today = () => new Date().toISOString().slice(0, 10);

/** Creates a quotation (a draft subscription) or edits an existing draft. */
export function SubscriptionFormPage() {
  const { id } = useParams();
  const editing = id !== undefined;
  usePageTitle(editing ? 'Edit draft' : 'New subscription');
  const navigate = useNavigate();
  const toast = useToast();
  const { money } = useMoney();

  const plans = useQuery(() => api.get<Page<Plan>>('/plans?active=true&pageSize=100'), []);
  const products = useQuery(() => api.get<Page<Product>>('/products?active=true&pageSize=100'), []);
  const templates = useQuery(() => api.get<Page<Template>>('/quotation-templates?active=true&pageSize=100'), []);
  const terms = useQuery(() => api.get<{ items: PaymentTerms[] }>('/payment-terms'), []);
  const existing = useQuery(() => (editing ? api.get<{ subscription: SubscriptionDetail }>(`/subscriptions/${id}`) : Promise.resolve(null)), [id]);

  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [planId, setPlanId] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [expiryDate, setExpiryDate] = useState('');
  const [termsId, setTermsId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [linesDirty, setLinesDirty] = useState(false);
  const [planDirty, setPlanDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  /** Drops a field's error as soon as the person changes it, so a fixed problem stops being shown. */
  const clear = (...keys: string[]) => setErrors((e) => (keys.some((k) => k in e) ? Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k))) : e));

  // Fill the form from the draft being edited, once.
  const draft = existing.data?.subscription;
  useEffect(() => {
    if (!draft || loadedFor === draft.id) return;
    setLoadedFor(draft.id);
    setCustomer({ id: draft.customer.id, name: draft.customer.name, company: draft.customer.company });
    setPlanId(String(draft.plan.id));
    setStartDate(draft.startDate);
    setExpiryDate(draft.expiryDate);
    setTermsId(draft.paymentTerms ? String(draft.paymentTerms.id) : '');
    setNotes(draft.notes ?? '');
    setLines(draft.lines.filter((l) => l.kind === 'product').map((l) => newLine({ productId: String(l.productId), variantId: l.variantId ? String(l.variantId) : '', quantity: String(l.quantity) })));
  }, [draft, loadedFor]);

  async function applyTemplate(value: string) {
    setTemplateId(value);
    if (!value) return;
    try {
      const { template } = await api.get<{ template: Template }>(`/quotation-templates/${value}`);
      setPlanId(String(template.plan.id));
      clear('planId', 'paymentTermsId');
      setLineErrors({});
      setTermsId(template.paymentTerms ? String(template.paymentTerms.id) : '');
      setLines(template.lines.map((l) => newLine({ productId: String(l.productId), variantId: l.variantId ? String(l.variantId) : '', quantity: String(l.quantity) })));
      toast.success(`Filled in from "${template.name}". Adjust anything you need.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the template.');
    }
  }

  // Live price check using the same engine that prices the saved quotation.
  const request = useDebounced(
    JSON.stringify({
      planId: planId ? Number(planId) : null,
      date: isDate(startDate) ? startDate : undefined,
      lines: lines.filter((l) => l.productId && /^\d+$/.test(l.quantity.trim()) && Number(l.quantity) >= 1).map((l) => ({ productId: Number(l.productId), variantId: l.variantId ? Number(l.variantId) : null, quantity: Number(l.quantity) })),
    }),
    300,
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  useEffect(() => {
    const body = JSON.parse(request) as { planId: number | null; lines: unknown[] };
    if (!body.planId && body.lines.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    api
      .post<Preview>('/pricing/preview', body)
      .then((p) => !cancelled && (setPreview(p), setPreviewError(null)))
      .catch((err) => !cancelled && setPreviewError(err as ApiError));
    return () => {
      cancelled = true;
    };
  }, [request]);

  const selectedPlan = (plans.data?.items ?? []).find((p) => String(p.id) === planId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!customer) next.customerId = 'Choose a customer';
    if (!planId) next.planId = 'Choose a plan';
    if (!isDate(startDate)) next.startDate = 'Choose a valid start date';
    if (expiryDate && !isDate(expiryDate)) next.expiryDate = 'Choose a valid date';
    else if (expiryDate && isDate(startDate) && expiryDate <= startDate) next.expiryDate = 'Must be after the start date';
    const req = linesToRequest(lines);
    setErrors(next);
    setLineErrors(req.ok ? {} : req.errors);
    setFormError('');
    if (Object.keys(next).length || !req.ok) return;

    setBusy(true);
    try {
      const common = {
        customerId: customer!.id,
        planId: Number(planId),
        startDate,
        paymentTermsId: termsId ? Number(termsId) : null,
        notes: notes.trim() || null,
      };
      if (editing) {
        // Lines are only re-saved (and so re-priced at today's catalog prices) when they or the plan changed.
        const body = { ...common, ...(expiryDate ? { expiryDate } : {}), ...(linesDirty || planDirty ? { lines: req.value } : {}) };
        await api.patch(`/subscriptions/${id}`, body);
        toast.success('Draft saved.');
        navigate(`/subscriptions/${id}`);
      } else {
        const body = { ...common, templateId: templateId ? Number(templateId) : null, ...(expiryDate ? { expiryDate } : {}), lines: req.value };
        const res = await api.post<{ subscription: { id: number; number: string } }>('/subscriptions', body);
        toast.success(`${res.subscription.number} created as a draft.`);
        navigate(`/subscriptions/${res.subscription.id}`);
      }
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setErrors(err.fields);
        setLineErrors(lineErrorsFrom(err.fields));
      } else setFormError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  if (editing && existing.error) {
    return (
      <EmptyState icon={<ArrowLeft size={22} />} title="Could not open this draft" action={<Link className="btn btn--secondary" to="/subscriptions">Back to subscriptions</Link>}>
        {existing.error.message}
      </EmptyState>
    );
  }
  if (editing && !draft) {
    return (
      <div className="state">
        <Spinner large />
      </div>
    );
  }
  if (editing && draft && draft.status !== 'draft') {
    return (
      <EmptyState icon={<ArrowLeft size={22} />} title="Only a draft can be edited" action={<Link className="btn btn--secondary" to={`/subscriptions/${draft.id}`}>Back to {draft.number}</Link>}>
        {draft.number} is {draft.status}. Move a quotation back to draft first if you need to change it.
      </EmptyState>
    );
  }

  const breakdownRows = (preview?.lines ?? []).map((l) => ({
    key: l.key,
    description: l.description,
    detail: `${l.quantity} × ${money(l.unitPrice)}${l.variantExtra > 0 ? ` (${money(l.basePrice)} + ${money(l.variantExtra)} option)` : ''} · ${l.taxName ? `${l.taxName} ${l.taxRatePercent}%` : 'No tax'}`,
    subtotal: l.subtotal,
    discount: l.discount,
    tax: l.tax,
    total: l.total,
  }));

  return (
    <>
      <Link to={editing ? `/subscriptions/${id}` : '/subscriptions'} className="back-link"><ArrowLeft size={16} /> {editing ? draft?.number : 'Subscriptions'}</Link>
      <PageHeader
        title={editing ? `Edit ${draft?.number}` : 'New subscription'}
        description={editing ? 'Only drafts can be edited. Changing the plan or lines re-prices them at today’s catalog prices.' : 'Start from a template or build the quotation line by line. It is saved as a draft you can review before sending.'}
      />
      <form onSubmit={submit} noValidate>
        {formError && <div style={{ marginBottom: 16 }}><Alert>{formError}</Alert></div>}
        <div className="calc">
          <div className="stack">
            <section className="card">
              <div className="card__head"><h2>Customer and plan</h2></div>
              <div className="card__body" style={{ display: 'grid', gap: 16 }}>
                <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); clear('customerId'); }} error={errors.customerId} />
                {!editing && (
                  <SelectField label="Start from a template (optional)" value={templateId} onChange={applyTemplate} hint="Fills in the plan, lines and payment terms. You can change them afterwards.">
                    <option value="">No template</option>
                    {(templates.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </SelectField>
                )}
                <SelectField label="Plan" value={planId} onChange={(v) => { setPlanId(v); setPlanDirty(true); clear('planId'); }} error={errors.planId} hint={selectedPlan && selectedPlan.minQuantity > 1 ? `Each product line needs a quantity of at least ${selectedPlan.minQuantity}.` : undefined}>
                  <option value="">Choose a plan</option>
                  {(plans.data?.items ?? []).filter((p) => p.isAvailable || String(p.id) === planId).map((p) => (
                    <option key={p.id} value={p.id}>{p.name} · {money(p.price)} per {periodUnit(p.billingPeriod)}</option>
                  ))}
                </SelectField>
                <div className="form-grid">
                  <TextField label="Start date" type="date" value={startDate} onChange={(v) => { setStartDate(v); clear('startDate', 'expiryDate'); }} error={errors.startDate} />
                  <TextField label="Expiry date" type="date" value={expiryDate} onChange={(v) => { setExpiryDate(v); clear('expiryDate'); }} error={errors.expiryDate} hint={expiryDate ? undefined : 'Leave empty to use a default term for the plan.'} />
                </div>
                <SelectField label="Payment terms" value={termsId} onChange={setTermsId} error={errors.paymentTermsId} hint="How long the customer has to pay each invoice.">
                  <option value="">Default terms</option>
                  {(terms.data?.items ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}{t.daysDue === 0 ? ' (due on receipt)' : ` (${t.daysDue} days)`}</option>)}
                </SelectField>
                <TextAreaField label="Internal notes" value={notes} onChange={setNotes} error={errors.notes} rows={2} hint="Only the team sees these." />
              </div>
            </section>
            <section className="card">
              <div className="card__head"><h2>Product lines</h2></div>
              <div className="card__body">
                <LinesEditor
                  lines={lines}
                  onChange={(l) => { setLines(l); setLinesDirty(true); setLineErrors({}); }}
                  products={products.data?.items ?? []}
                  errors={lineErrors}
                  emptyHint="No product lines. The quotation carries only the plan fee."
                />
              </div>
            </section>
          </div>

          <div className="stack" style={{ position: 'sticky', top: 16 }}>
            <section className="card" aria-live="polite">
              <div className="card__head"><h2>Price per billing period</h2></div>
              {previewError && !Object.keys(previewError.fields).some((k) => k.startsWith('lines.')) && <div className="card__body"><Alert>{previewError.message}</Alert></div>}
              {!preview && !previewError && <div className="card__body muted">Choose a plan or add a product line to see the price.</div>}
              {preview && (
                <>
                  <BreakdownTable rows={breakdownRows} totals={preview.totals} totalLabel="Total" />
                  <div className="card__body" style={{ borderTop: '1px solid var(--line)' }}>
                    {preview.discount.applied ? (
                      <Alert tone="success"><strong>{preview.discount.applied.name}</strong> saves {money(preview.discount.applied.amount)} and is applied automatically on each invoice while it is valid.</Alert>
                    ) : (
                      <p className="muted small">No discount currently applies.</p>
                    )}
                  </div>
                </>
              )}
            </section>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={() => navigate(editing ? `/subscriptions/${id}` : '/subscriptions')} disabled={busy}>Cancel</Button>
              <Button type="submit" loading={busy}>{editing ? 'Save draft' : 'Create draft'}</Button>
            </div>
          </div>
        </div>
      </form>
    </>
  );
}
