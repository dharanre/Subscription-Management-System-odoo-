import { Search, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { fmtDate } from '../format';
import { useDebounced, usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import { isDate } from '../parse';
import { PAYMENT_METHODS, type PaymentsResponse } from '../billingTypes';
import { Badge } from '../ui/Feedback';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';

const PAGE_SIZE = 12;

/** Every payment that has been recorded, with filters and a running total of what the filter adds up to. */
export function PaymentsPage() {
  usePageTitle('Payments');
  const { money } = useMoney();
  const [q, setQ] = useState('');
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState<'recorded' | 'voided' | 'all'>('recorded');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());

  const dates = (!from || isDate(from)) && (!to || isDate(to)) && !(from && to && from > to);
  const list = useQuery(
    () => (dates ? api.get<PaymentsResponse>(`/payments${qs({ page, pageSize: PAGE_SIZE, q: search, method, status, from, to })}`) : Promise.resolve(null)),
    [page, search, method, status, from, to, dates],
    { pollMs: 20000 },
  );
  const items = list.data?.items ?? [];
  const filtered = !!(search || method || from || to || status !== 'recorded');
  const reset = () => setPage(1);

  return (
    <>
      <PageHeader title="Payments" description="Money received and entered against invoices. Recording a payment updates the invoice straight away; a mistake is voided, never deleted." />
      <section className="card">
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input className="input" type="search" placeholder="Search invoice, customer or reference" aria-label="Search payments" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} />
          </div>
          <select className="select" aria-label="Filter by method" value={method} onChange={(e) => { setMethod(e.target.value); reset(); }}>
            <option value="">All methods</option>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <select className="select" aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); reset(); }}>
            <option value="recorded">Recorded</option>
            <option value="voided">Voided</option>
            <option value="all">Both</option>
          </select>
          <label className="date-filter">
            <span className="sr-only">Received from</span>
            <input className="input" type="date" aria-label="Received from" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); reset(); }} />
          </label>
          <label className="date-filter">
            <span className="sr-only">Received to</span>
            <input className="input" type="date" aria-label="Received to" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); reset(); }} />
          </label>
        </div>
        {list.data && (
          <div className="summary-line" aria-live="polite">
            <strong>{money(list.data.totals.amount)}</strong> across {list.data.totals.count} payment{list.data.totals.count === 1 ? '' : 's'}
            {filtered && <span className="muted"> · filtered</span>}
          </div>
        )}
        <QueryStates
          query={list}
          isEmpty={!!list.data && items.length === 0}
          emptyIcon={<Wallet size={22} />}
          emptyTitle={filtered ? 'No payments match' : 'No payments yet'}
          emptyText={filtered ? 'Try widening the dates or clearing a filter.' : 'Open an invoice and choose Record payment when money arrives.'}
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Invoice</th>
                  <th className="hide-sm">Method</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} style={p.status === 'voided' ? { opacity: 0.6 } : undefined}>
                    <td className="num">
                      {fmtDate(p.paidOn)}
                      {p.status === 'voided' && <div><Badge tone="bad" plain>Voided</Badge></div>}
                    </td>
                    <td>
                      <Link className="cell-main" to={`/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link>
                      <div className="cell-sub">{p.customer?.company || p.customer?.name}</div>
                    </td>
                    <td className="hide-sm">
                      {p.methodLabel}
                      <div className="cell-sub">{p.status === 'voided' ? p.voidReason : p.reference ?? ''}</div>
                    </td>
                    <td className="num" style={{ textAlign: 'right', textDecoration: p.status === 'voided' ? 'line-through' : undefined }}>{money(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
        </QueryStates>
      </section>
    </>
  );
}
