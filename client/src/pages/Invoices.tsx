import { CheckCheck, FileText, Search, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { type Page, api, qs } from '../api';
import { useAuth } from '../auth';
import { fmtDate } from '../format';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import type { InvoiceCounts, InvoiceSummary } from '../billingTypes';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/Dialog';
import { useToast } from '../ui/Feedback';
import { InvoiceStatusBadge } from '../ui/InvoiceStatus';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';

const PAGE_SIZE = 10;
type Tab = '' | 'draft' | 'confirmed' | 'overdue' | 'paid' | 'cancelled';

export function InvoicesPage() {
  const { user } = useAuth();
  const isStaff = user?.role !== 'customer';
  usePageTitle(isStaff ? 'Invoices' : 'My invoices');
  const { money } = useMoney();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const subscriptionId = isStaff ? params.get('subscriptionId') : null;
  const [tab, setTab] = useState<Tab>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const counts = useQuery(() => api.get<InvoiceCounts>('/invoices/counts'), [], { pollMs: 20000 });
  const list = useQuery(() => api.get<Page<InvoiceSummary>>(`/invoices${qs({ page, pageSize: PAGE_SIZE, status: tab, q: search, subscriptionId })}`), [page, tab, search, subscriptionId], { pollMs: 20000 });
  const items = list.data?.items ?? [];
  const c = counts.data?.counts;

  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: '', label: 'All', count: counts.data?.total },
    ...(isStaff ? [{ value: 'draft' as Tab, label: 'Draft', count: c?.draft }] : []),
    { value: 'confirmed', label: 'Confirmed', count: c?.confirmed },
    { value: 'overdue', label: 'Overdue', count: c?.overdue },
    { value: 'paid', label: 'Paid', count: c?.paid },
    ...(isStaff ? [{ value: 'cancelled' as Tab, label: 'Cancelled', count: c?.cancelled }] : []),
  ];

  async function confirmAll() {
    setBusy(true);
    try {
      const res = await api.post<{ confirmed: number; failed: unknown[] }>('/invoices/confirm-drafts', {});
      toast.success(`${res.confirmed} invoice${res.confirmed === 1 ? '' : 's'} confirmed.`);
      if (res.failed.length) toast.error(`${res.failed.length} could not be confirmed. Open them to see why.`);
      setConfirmingAll(false);
      list.reload();
      counts.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not confirm the drafts.');
    } finally {
      setBusy(false);
    }
  }

  const filtered = !!(tab || search || subscriptionId);
  return (
    <>
      <PageHeader
        title={isStaff ? 'Invoices' : 'My invoices'}
        description={isStaff ? 'Every invoice, from the draft billing created to the day it is paid. Overdue ones are flagged so they can be chased.' : 'Your invoices from Brightloop and whether each one has been paid.'}
        actions={
          isStaff && (
            <>
              {(c?.draft ?? 0) > 0 && (
                <Button variant="secondary" icon={<CheckCheck size={18} />} onClick={() => setConfirmingAll(true)}>
                  Confirm {c!.draft} draft{c!.draft === 1 ? '' : 's'}
                </Button>
              )}
              <Link className="btn btn--primary" to="/billing">Billing</Link>
            </>
          )
        }
      />
      <section className="card">
        <div className="tabs" role="tablist" aria-label="Filter by status">
          {tabs.map((t) => (
            <button key={t.value} role="tab" className="tab" aria-selected={tab === t.value} onClick={() => { setTab(t.value); setPage(1); }}>
              {t.label}
              <span className="tab__count">{t.count ?? '–'}</span>
            </button>
          ))}
        </div>
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input className="input" type="search" placeholder={isStaff ? 'Search invoice, customer or subscription' : 'Search by invoice number'} aria-label="Search invoices" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          {subscriptionId && (
            <span className="filter-chip">
              Subscription #{subscriptionId}
              <Button variant="ghost" size="sm" aria-label="Clear subscription filter" icon={<X size={14} />} onClick={() => { setParams({}); setPage(1); }} />
            </span>
          )}
        </div>
        <QueryStates
          query={list}
          isEmpty={!!list.data && items.length === 0}
          emptyIcon={<FileText size={22} />}
          emptyTitle={filtered ? 'No invoices match' : 'No invoices yet'}
          emptyText={filtered ? 'Try another status or search.' : isStaff ? 'Run billing to create invoices from the subscriptions that are due.' : 'When Brightloop invoices you, it appears here.'}
          emptyAction={isStaff && !filtered ? <Link className="btn btn--primary" to="/billing">Go to billing</Link> : undefined}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th className="hide-sm">Period</th>
                  <th>Due</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }} className="hide-sm">Balance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link className="cell-main" to={`/invoices/${i.id}`}>{i.number}</Link>
                      <div className="cell-sub">{isStaff ? i.customer.company || i.customer.name : i.subscription.number}</div>
                    </td>
                    <td className="num hide-sm">
                      {fmtDate(i.periodStart)}
                      <div className="cell-sub">to {fmtDate(i.periodEnd)}</div>
                    </td>
                    <td className="num">{fmtDate(i.dueDate)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(i.total)}</td>
                    <td className="num hide-sm" style={{ textAlign: 'right' }}>{i.status === 'cancelled' ? '—' : money(i.balance)}</td>
                    <td><InvoiceStatusBadge status={i.status} overdue={i.isOverdue} daysOverdue={i.daysOverdue} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
        </QueryStates>
      </section>

      <ConfirmDialog open={confirmingAll} title="Confirm all drafts?" confirmLabel={`Confirm ${c?.draft ?? 0}`} busy={busy} onConfirm={confirmAll} onClose={() => !busy && setConfirmingAll(false)}>
        <p>Every draft invoice becomes confirmed and starts counting as money owed. You can still cancel a confirmed invoice until a payment is recorded against it.</p>
      </ConfirmDialog>
    </>
  );
}
