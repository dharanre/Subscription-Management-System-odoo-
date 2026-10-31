import { Percent, Plus } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, type Page, api } from '../api';
import { useAuth } from '../auth';
import { usePageTitle, useQuery } from '../hooks';
import { numToInput, parsePercent } from '../parse';
import type { Tax } from '../types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Alert, Badge, useToast } from '../ui/Feedback';
import { AffixField, CheckboxField, TextField } from '../ui/Field';
import { PageHeader } from '../ui/Layout';
import { QueryStates } from '../ui/Query';

export function TaxesPage() {
  usePageTitle('Taxes');
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [editing, setEditing] = useState<Tax | 'new' | null>(null);
  const list = useQuery(() => api.get<Page<Tax>>('/taxes?pageSize=100'), []);
  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Taxes"
        description="Tax is worked out automatically on every line. A product uses its own tax if it has one, otherwise the default tax below."
        actions={isAdmin && <Button icon={<Plus size={18} />} onClick={() => setEditing('new')}>New tax</Button>}
      />
      <section className="card">
        <QueryStates
          query={list}
          isEmpty={!!list.data && items.length === 0}
          emptyIcon={<Percent size={22} />}
          emptyTitle="No tax rules yet"
          emptyText="Without a tax rule, invoices are issued with no tax."
          emptyAction={isAdmin ? <Button onClick={() => setEditing('new')}>New tax</Button> : undefined}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Tax</th><th style={{ textAlign: 'right' }}>Rate</th><th className="hide-sm">Applies to</th><th>Status</th></tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id}>
                    <td><button className="link-btn" onClick={() => setEditing(t)}>{t.name}</button> {t.isDemo && <Badge plain>Demo</Badge>}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{t.ratePercent}%</td>
                    <td className="hide-sm">{t.isDefault ? <Badge tone="info" plain>Default for products without a tax</Badge> : <span className="muted">Products that choose it</span>}</td>
                    <td>{t.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="mute">Inactive</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryStates>
      </section>
      <TaxDialog target={editing} canEdit={isAdmin} onClose={() => setEditing(null)} onSaved={list.reload} />
    </>
  );
}

function TaxDialog({ target, canEdit, onClose, onSaved }: { target: Tax | 'new' | null; canEdit: boolean; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const isNew = target === 'new';
  const tax = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setErrors({});
    setFormError('');
    setName(tax?.name ?? '');
    setRate(tax ? numToInput(tax.ratePercent) : '');
    setIsDefault(tax?.isDefault ?? false);
    setIsActive(tax?.isActive ?? true);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Name is required';
    const r = parsePercent(rate, 'Tax rate');
    if (!r.ok) next.ratePercent = r.error;
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length || !r.ok) return;

    setBusy(true);
    try {
      const body = { name: name.trim(), ratePercent: r.value, isDefault, ...(isNew ? {} : { isActive }) };
      await (isNew ? api.post('/taxes', body) : api.patch(`/taxes/${tax!.id}`, body));
      toast.success(`${body.name} saved.`);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof Error ? err.message : 'Could not save the tax.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      title={isNew ? 'New tax' : (tax?.name ?? 'Tax')}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form="tax-form" loading={busy}>{isNew ? 'Create tax' : 'Save changes'}</Button>}
        </>
      }
    >
      <form id="tax-form" className="dialog__body" onSubmit={submit} noValidate>
        {!canEdit && <Alert tone="info">Only admins can change tax rules.</Alert>}
        {formError && <Alert>{formError}</Alert>}
        <TextField label="Name" value={name} onChange={setName} error={errors.name} disabled={!canEdit} autoFocus />
        <AffixField label="Rate" suffix="%" value={rate} onChange={setRate} error={errors.ratePercent} disabled={!canEdit} placeholder="0" />
        <CheckboxField label="Default tax" hint="Used for every product that does not choose its own tax. Only one tax can be the default." checked={isDefault} onChange={setIsDefault} disabled={!canEdit || (!isNew && !isActive)} />
        {!isNew && canEdit && <CheckboxField label="Tax is active" hint="A tax still used by active products cannot be switched off." checked={isActive} onChange={(v) => { setIsActive(v); if (!v) setIsDefault(false); }} />}
      </form>
    </Dialog>
  );
}
