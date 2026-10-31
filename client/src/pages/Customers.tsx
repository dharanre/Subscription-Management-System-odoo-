import { Plus, Search, UserRound } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, type Page, api, qs } from '../api';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import type { Customer } from '../salesTypes';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Alert, Badge, useToast } from '../ui/Feedback';
import { TextAreaField, TextField } from '../ui/Field';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';

const PAGE_SIZE = 10;

export function CustomersPage() {
  usePageTitle('Customers');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);

  const list = useQuery(() => api.get<Page<Customer>>(`/customers${qs({ page, pageSize: PAGE_SIZE, q: search })}`), [page, search]);
  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Customers"
        description="The companies and people Brightloop bills. A customer who signs up gets a portal login; staff can also add customers who do not."
        actions={<Button icon={<Plus size={18} />} onClick={() => setEditing('new')}>New customer</Button>}
      />
      <section className="card">
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input className="input" type="search" placeholder="Search name, company or email" aria-label="Search customers" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
        </div>
        <QueryStates
          query={list}
          isEmpty={!!list.data && items.length === 0}
          emptyIcon={<UserRound size={22} />}
          emptyTitle={search ? 'No customers match' : 'No customers yet'}
          emptyText={search ? 'Try a different name, company or email.' : 'Add a customer to start quoting.'}
          emptyAction={!search ? <Button onClick={() => setEditing('new')}>New customer</Button> : undefined}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="hide-sm">Contact</th>
                  <th>Portal</th>
                  <th style={{ textAlign: 'right' }}>Subscriptions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <button className="link-btn" onClick={() => setEditing(c)}>{c.company || c.name}</button> {c.isDemo && <Badge plain>Demo</Badge>}
                      <div className="cell-sub">{c.company ? c.name : c.email}</div>
                    </td>
                    <td className="hide-sm">
                      {c.email}
                      {c.phone && <div className="cell-sub">{c.phone}</div>}
                    </td>
                    <td>{c.hasPortalAccount ? <Badge tone="ok">Has login</Badge> : <Badge tone="mute">No login</Badge>}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {c.subscriptionCount > 0 ? <Link to={`/subscriptions?customerId=${c.id}`}>{c.subscriptionCount}</Link> : 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
        </QueryStates>
      </section>
      <CustomerDialog target={editing} onClose={() => setEditing(null)} onSaved={list.reload} />
    </>
  );
}

function CustomerDialog({ target, onClose, onSaved }: { target: Customer | 'new' | null; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const isNew = target === 'new';
  const customer = target && target !== 'new' ? target : null;
  const [form, setForm] = useState({ name: '', email: '', company: '', phone: '', address: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setErrors({});
    setFormError('');
    setForm({ name: customer?.name ?? '', email: customer?.email ?? '', company: customer?.company ?? '', phone: customer?.phone ?? '', address: customer?.address ?? '' });
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = 'Name is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) next.email = 'Enter a valid email address';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length) return;

    const body = { name: form.name.trim(), email: form.email.trim(), company: form.company.trim() || null, phone: form.phone.trim() || null, address: form.address.trim() || null };
    setBusy(true);
    try {
      await (isNew ? api.post('/customers', body) : api.patch(`/customers/${customer!.id}`, body));
      toast.success(`${body.company ?? body.name} saved.`);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof Error ? err.message : 'Could not save the customer.');
    } finally {
      setBusy(false);
    }
  }

  const locked = !!customer?.hasPortalAccount;
  return (
    <Dialog
      open={target !== null}
      wide
      title={isNew ? 'New customer' : (customer?.company || customer?.name || 'Customer')}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="customer-form" loading={busy}>{isNew ? 'Create customer' : 'Save changes'}</Button>
        </>
      }
    >
      <form id="customer-form" className="dialog__body" onSubmit={submit} noValidate>
        {formError && <Alert>{formError}</Alert>}
        <div className="form-grid">
          <TextField label="Contact name" value={form.name} onChange={set('name')} error={errors.name} autoFocus />
          <TextField label="Company" value={form.company} onChange={set('company')} error={errors.company} />
          <TextField label="Email" type="email" value={form.email} onChange={set('email')} error={errors.email} disabled={locked} hint={locked ? 'This customer signs in with this email, so it cannot be changed here.' : undefined} />
          <TextField label="Phone" value={form.phone} onChange={set('phone')} error={errors.phone} />
          <div className="span-2">
            <TextAreaField label="Billing address" value={form.address} onChange={set('address')} error={errors.address} rows={2} />
          </div>
        </div>
      </form>
    </Dialog>
  );
}
