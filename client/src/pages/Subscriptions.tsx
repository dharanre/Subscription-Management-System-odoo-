import { Plus, Repeat, Search, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { type Page, api, qs } from '../api';
import { useAuth } from '../auth';
import { fmtDate } from '../format';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import type { Customer, SubStatus, SubscriptionSummary } from '../salesTypes';
import { periodUnit } from '../types';
import { Button } from '../ui/Button';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';
import { STATUS_UI, SubStatusBadge } from '../ui/Status';

const PAGE_SIZE = 10;
const TABS: { value: '' | SubStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'quotation', label: 'Quotation' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'closed', label: 'Closed' },
];

export function SubscriptionsPage() {
  const { user } = useAuth();
  const isStaff = user?.role !== 'customer';
  usePageTitle(isStaff ? 'Subscriptions' : 'My subscriptions');
  const { money } = useMoney();
  const [params, setParams] = useSearchParams();
  const customerId = isStaff ? params.get('customerId') : null;
  const fromLink = params.get('status') as SubStatus | null;
  const [status, setStatus] = useState<'' | SubStatus>(fromLink && TABS.some((t) => t.value === fromLink) ? fromLink : '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());

  // Both refresh quietly so the team sees changes made by colleagues.
  const counts = useQuery(() => api.get<{ counts: Record<SubStatus, number>; total: number }>('/subscriptions/counts'), [], { pollMs: 20000 });
  const list = useQuery(() => api.get<Page<SubscriptionSummary>>(`/subscriptions${qs({ page, pageSize: PAGE_SIZE, status, q: search, customerId })}`), [page, status, search, customerId], { pollMs: 20000 });
  const filterCustomer = useQuery(() => (customerId ? api.get<{ customer: Customer }>(`/customers/${customerId}`) : Promise.resolve(null)), [customerId]);
  const items = list.data?.items ?? [];
  const filtered = !!(status || search || customerId);

  return (
    <>
      <PageHeader
        title={isStaff ? 'Subscriptions' : 'My subscriptions'}
        description={isStaff ? 'Every quotation and subscription, and where each one stands.' : 'Your subscriptions with Brightloop, and where each one stands.'}
        actions={isStaff && <Link className="btn btn--primary" to="/subscriptions/new"><Plus size={18} /> New subscription</Link>}
      />
      <section className="card">
        <div className="tabs" role="tablist" aria-label="Filter by status">
          {TABS.map((t) => (
            <button key={t.value} role="tab" className="tab" aria-selected={status === t.value} onClick={() => { setStatus(t.value); setPage(1); }}>
              {t.label}
              <span className="tab__count">{t.value === '' ? (counts.data?.total ?? '–') : (counts.data?.counts[t.value] ?? '–')}</span>
            </button>
          ))}
        </div>
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input className="input" type="search" placeholder={isStaff ? 'Search number, customer or company' : 'Search by number'} aria-label="Search subscriptions" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          {customerId && (
            <span className="filter-chip">
              Customer: {filterCustomer.data?.customer.company || filterCustomer.data?.customer.name || `#${customerId}`}
              <Button variant="ghost" size="sm" aria-label="Clear customer filter" icon={<X size={14} />} onClick={() => { setParams({}); setPage(1); }} />
            </span>
          )}
        </div>
        <QueryStates
          query={list}
          isEmpty={!!list.data && items.length === 0}
          emptyIcon={<Repeat size={22} />}
          emptyTitle={filtered ? 'Nothing matches' : isStaff ? 'No subscriptions yet' : 'No subscriptions yet'}
          emptyText={filtered ? 'Try another status or search.' : isStaff ? 'Create a quotation for a customer to get started.' : 'When Brightloop sets up a subscription for you, it appears here.'}
          emptyAction={isStaff && !filtered ? <Link className="btn btn--primary" to="/subscriptions/new">New subscription</Link> : undefined}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Subscription</th>
                  <th className="hide-sm">Plan</th>
                  <th className="hide-sm">Term</th>
                  <th style={{ textAlign: 'right' }}>Per period</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link className="cell-main" to={`/subscriptions/${s.id}`}>{s.number}</Link>
                      <div className="cell-sub">{isStaff ? (s.customer.company || s.customer.name) : s.plan.name}</div>
                    </td>
                    <td className="hide-sm">{s.plan.name}</td>
                    <td className="num hide-sm">
                      {fmtDate(s.startDate)}
                      <div className="cell-sub">to {fmtDate(s.expiryDate)}</div>
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {money(s.total)}
                      <div className="cell-sub">per {periodUnit(s.plan.billingPeriod)}</div>
                    </td>
                    <td><SubStatusBadge status={s.status} closeReason={s.closeReason} quoteExpired={s.quoteExpired} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
        </QueryStates>
      </section>
      <span className="sr-only" aria-live="polite">{status ? `${STATUS_UI[status].label} subscriptions` : 'All subscriptions'}</span>
    </>
  );
}
