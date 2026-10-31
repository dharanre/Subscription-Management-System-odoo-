import { FileStack, Plus, Search } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, type Page, api, qs } from '../api';
import { useAuth } from '../auth';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import { parseWhole } from '../parse';
import type { PaymentTerms, Template } from '../salesTypes';
import { type Plan, type Product, periodUnit } from '../types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Alert, Badge, useToast } from '../ui/Feedback';
import { CheckboxField, SelectField, TextAreaField, TextField } from '../ui/Field';
import { PageHeader, Pagination } from '../ui/Layout';
import { type LineDraft, LinesEditor, lineErrorsFrom, linesToRequest, newLine } from '../ui/LinesEditor';
import { QueryStates } from '../ui/Query';

const PAGE_SIZE = 10;

export function TemplatesPage() {
  usePageTitle('Quotation templates');
  const { user } = useAuth();
  const { money } = useMoney();
  const isAdmin = user?.role === 'admin';
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const [editing, setEditing] = useState<Template | 'new' | null>(null);

  const list = useQuery(() => api.get<Page<Template>>(`/quotation-templates${qs({ page, pageSize: PAGE_SIZE, q: search })}`), [page, search]);
  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Quotation templates"
        description="A ready-made starting point for an offer: the plan, the product lines, the payment terms and how many days the quotation stays valid."
        actions={isAdmin && <Button icon={<Plus size={18} />} onClick={() => setEditing('new')}>New template</Button>}
      />
      <section className="card">
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input className="input" type="search" placeholder="Search templates" aria-label="Search templates" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
        </div>
        <QueryStates
          query={list}
          isEmpty={!!list.data && items.length === 0}
          emptyIcon={<FileStack size={22} />}
          emptyTitle={search ? 'No templates match' : 'No templates yet'}
          emptyText={isAdmin ? 'Create a template so quotes for common deals take seconds.' : 'An admin can create templates for common deals.'}
          emptyAction={isAdmin && !search ? <Button onClick={() => setEditing('new')}>New template</Button> : undefined}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Plan</th>
                  <th className="hide-sm">Lines</th>
                  <th className="hide-sm">Valid for</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <button className="link-btn" onClick={() => setEditing(t)}>{t.name}</button> {t.isDemo && <Badge plain>Demo</Badge>}
                      <div className="cell-sub">{t.paymentTerms?.name ?? 'Default payment terms'}</div>
                    </td>
                    <td>
                      {t.plan.name}
                      <div className="cell-sub">{money(t.plan.price)} per {periodUnit(t.plan.billingPeriod)}</div>
                    </td>
                    <td className="hide-sm">
                      {t.lines.length === 0 ? <span className="muted">Plan fee only</span> : t.lines.map((l) => `${l.quantity} × ${l.productName}`).join(', ')}
                    </td>
                    <td className="num hide-sm">{t.validityDays} days</td>
                    <td>{t.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="mute">Inactive</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
        </QueryStates>
      </section>
      <TemplateDialog target={editing} canEdit={isAdmin} onClose={() => setEditing(null)} onSaved={list.reload} />
    </>
  );
}

function TemplateDialog({ target, canEdit, onClose, onSaved }: { target: Template | 'new' | null; canEdit: boolean; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const isNew = target === 'new';
  const template = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [planId, setPlanId] = useState('');
  const [validity, setValidity] = useState('30');
  const [termsId, setTermsId] = useState('');
  const [notes, setNotes] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const open = target !== null;
  const plans = useQuery(() => api.get<Page<Plan>>('/plans?active=true&pageSize=100'), [open]);
  const products = useQuery(() => api.get<Page<Product>>('/products?active=true&pageSize=100'), [open]);
  const terms = useQuery(() => api.get<{ items: PaymentTerms[] }>('/payment-terms'), [open]);

  useEffect(() => {
    setErrors({});
    setLineErrors({});
    setFormError('');
    setName(template?.name ?? '');
    setPlanId(template ? String(template.plan.id) : '');
    setValidity(template ? String(template.validityDays) : '30');
    setTermsId(template?.paymentTerms ? String(template.paymentTerms.id) : '');
    setNotes(template?.notes ?? '');
    setIsActive(template?.isActive ?? true);
    setLines(template ? template.lines.map((l) => newLine({ productId: String(l.productId), variantId: l.variantId ? String(l.variantId) : '', quantity: String(l.quantity) })) : [newLine()]);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedPlan = (plans.data?.items ?? []).find((p) => String(p.id) === planId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Name is required';
    if (!planId) next.planId = 'Choose a plan';
    const days = parseWhole(validity, 'Validity', 1);
    if (!days.ok) next.validityDays = days.error;
    else if (days.value > 365) next.validityDays = 'Validity cannot exceed 365 days';
    const req = linesToRequest(lines);
    setErrors(next);
    setLineErrors(req.ok ? {} : req.errors);
    setFormError('');
    if (Object.keys(next).length || !req.ok || !days.ok) return;

    const body = {
      name: name.trim(),
      planId: Number(planId),
      validityDays: days.value,
      paymentTermsId: termsId ? Number(termsId) : null,
      notes: notes.trim() || null,
      lines: req.value,
      ...(isNew ? {} : { isActive }),
    };
    setBusy(true);
    try {
      await (isNew ? api.post('/quotation-templates', body) : api.patch(`/quotation-templates/${template!.id}`, body));
      toast.success(`${body.name} saved.`);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setErrors(err.fields);
        setLineErrors(lineErrorsFrom(err.fields));
      } else setFormError(err instanceof Error ? err.message : 'Could not save the template.');
    } finally {
      setBusy(false);
    }
  }

  const off = !canEdit;
  return (
    <Dialog
      open={open}
      wide
      title={isNew ? 'New template' : (template?.name ?? 'Template')}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form="template-form" loading={busy}>{isNew ? 'Create template' : 'Save changes'}</Button>}
        </>
      }
    >
      <form id="template-form" className="dialog__body" onSubmit={submit} noValidate>
        {off && <Alert tone="info">Only admins can change templates.</Alert>}
        {formError && <Alert>{formError}</Alert>}
        <div className="form-grid">
          <div className="span-2"><TextField label="Name" value={name} onChange={setName} error={errors.name} disabled={off} autoFocus /></div>
          <SelectField label="Plan" value={planId} onChange={setPlanId} error={errors.planId} disabled={off} hint={selectedPlan && selectedPlan.minQuantity > 1 ? `Each product line needs a quantity of at least ${selectedPlan.minQuantity}.` : undefined}>
            <option value="">Choose a plan</option>
            {(plans.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
          <TextField label="Quotation valid for (days)" inputMode="numeric" value={validity} onChange={setValidity} error={errors.validityDays} disabled={off} />
          <SelectField label="Payment terms" value={termsId} onChange={setTermsId} error={errors.paymentTermsId} disabled={off} hint="Leave on default to use the standard terms.">
            <option value="">Default terms</option>
            {(terms.data?.items ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </SelectField>
          <span />
          <div className="span-2"><TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} disabled={off} rows={2} /></div>
        </div>
        <div className="form-section">
          <h3>Product lines</h3>
          <LinesEditor lines={lines} onChange={setLines} products={products.data?.items ?? []} errors={lineErrors} disabled={off} emptyHint="No product lines: quotations from this template carry only the plan fee." />
        </div>
        {!isNew && canEdit && <CheckboxField label="Template is active" hint="Turn off to stop offering it when creating a quotation." checked={isActive} onChange={setIsActive} />}
      </form>
    </Dialog>
  );
}
