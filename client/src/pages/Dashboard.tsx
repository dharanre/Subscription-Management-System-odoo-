import { CheckCircle2, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type Page, api, qs } from '../api';
import { fmtDate } from '../format';
import { useDebounced, useQuery } from '../hooks';
import { useMoney } from '../meta';
import { isDate } from '../parse';
import type { InvoiceSummary, PaymentsResponse } from '../billingTypes';
import { PAYMENT_METHODS } from '../billingTypes';
import type { DashboardData } from '../dashboardTypes';
import type { SubscriptionSummary } from '../salesTypes';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Feedback';
import { InvoiceStatusBadge } from '../ui/InvoiceStatus';
import { Kpi } from '../ui/Kpi';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';
import { StatusMix } from '../ui/StatusMix';
import { SubStatusBadge } from '../ui/Status';
import { TrendChart } from '../ui/TrendChart';

type Preset = 'last30' | 'month' | 'lastMonth' | 'last90' | 'last180' | 'ytd' | 'custom';
const PRESETS: { value: Preset; label: string }[] = [
  { value: 'last30', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'last180', label: 'Last 6 months' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'custom', label: 'Custom range' },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const todayIso = () => iso(new Date());
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

function rangeFor(preset: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (preset) {
    case 'last30':
      return { from: daysAgo(29), to: todayIso() };
    case 'month':
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: todayIso() };
    case 'lastMonth':
      return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case 'last90':
      return { from: daysAgo(89), to: todayIso() };
    case 'last180':
      return { from: daysAgo(179), to: todayIso() };
    case 'ytd':
      return { from: `${y}-01-01`, to: todayIso() };
  }
}

/** The finance lead's one place: subscriptions, revenue, payments and overdue invoices, with a date range. */
export function Dashboard() {
  const { money, count } = useMoney();
  const [preset, setPreset] = useState<Preset>('last30');
  const [custom, setCustom] = useState({ from: daysAgo(29), to: todayIso() });
  const range = useMemo(() => (preset === 'custom' ? custom : rangeFor(preset)), [preset, custom]);
  const valid = isDate(range.from) && isDate(range.to) && range.from <= range.to && range.to <= todayIso();

  // Re-reads every 15 seconds and whenever the tab is shown again, so it follows what colleagues are doing.
  const dash = useQuery(() => (valid ? api.get<DashboardData>(`/dashboard${qs(range)}`) : Promise.resolve(null)), [range.from, range.to, valid], { pollMs: 15000 });
  const d = dash.data;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);
  const secondsAgo = dash.updatedAt ? Math.max(0, Math.round((now - dash.updatedAt) / 1000)) : null;

  const attention = d
    ? [
        d.attention.billingFailures > 0 && { to: '/billing', tone: 'bad', n: d.attention.billingFailures, text: d.attention.billingFailures === 1 ? 'billing failure to fix' : 'billing failures to fix' },
        d.receivables.overdue.count > 0 && { to: '/receivables', tone: 'bad', n: d.receivables.overdue.count, text: d.receivables.overdue.count === 1 ? 'overdue invoice' : 'overdue invoices' },
        d.attention.billingDue > 0 && { to: '/billing', tone: 'warn', n: d.attention.billingDue, text: d.attention.billingDue === 1 ? 'subscription due for billing' : 'subscriptions due for billing' },
        d.attention.draftInvoices > 0 && { to: '/invoices?status=draft', tone: 'warn', n: d.attention.draftInvoices, text: d.attention.draftInvoices === 1 ? 'draft invoice to confirm' : 'draft invoices to confirm' },
        d.attention.expiringSoon > 0 && { to: '/subscriptions', tone: 'warn', n: d.attention.expiringSoon, text: d.attention.expiringSoon === 1 ? 'subscription expires within 30 days' : 'subscriptions expire within 30 days' },
        d.attention.expiredQuotes > 0 && { to: '/subscriptions?status=quotation', tone: 'warn', n: d.attention.expiredQuotes, text: d.attention.expiredQuotes === 1 ? 'quotation has expired' : 'quotations have expired' },
      ].filter(Boolean) as { to: string; tone: string; n: number; text: string }[]
    : [];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Subscriptions, revenue, payments and overdue invoices, worked out from the current records each time you look."
        actions={
          <div className="range-bar">
            <div className="field">
              <label className="field__label" htmlFor="range-preset">Period</label>
              <select id="range-preset" className="select" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
                {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            {preset === 'custom' && (
              <>
                <div className="field">
                  <label className="field__label" htmlFor="range-from">From</label>
                  <input id="range-from" className="input" type="date" value={custom.from} max={custom.to || todayIso()} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="range-to">To</label>
                  <input id="range-to" className="input" type="date" value={custom.to} min={custom.from} max={todayIso()} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
                </div>
              </>
            )}
            <Button variant="secondary" aria-label="Refresh now" title="Refresh now" onClick={dash.reload} icon={<RefreshCw size={16} />} />
          </div>
        }
      />

      {!valid && <div style={{ marginBottom: 16 }}><Alert>Choose a start date on or before the end date, and an end date no later than today.</Alert></div>}
      {dash.error && !d && <div style={{ marginBottom: 16 }}><Alert>Could not load the dashboard: {dash.error.message} <button className="btn btn--secondary btn--sm" onClick={dash.reload} style={{ marginLeft: 8 }}>Retry</button></Alert></div>}

      {d && (
        <>
          <div className="attention" aria-label="Needs attention">
            {attention.length === 0 ? (
              <span className="attention__ok"><CheckCircle2 size={16} /> Nothing needs attention right now</span>
            ) : (
              attention.map((a) => (
                <Link key={a.text} to={a.to} data-tone={a.tone}><b>{count(a.n)}</b> {a.text}</Link>
              ))
            )}
            <span className="updated" style={{ alignSelf: 'center', marginLeft: 'auto' }} aria-live="off">
              {secondsAgo === null ? '' : secondsAgo < 5 ? 'Updated just now' : `Updated ${secondsAgo}s ago`}
            </span>
          </div>

          <div className="stat-grid kpis">
            <Kpi to="/subscriptions" label="Active subscriptions" value={count(d.subscriptions.active)} sub={`${count(d.subscriptions.paused)} paused · ${count(d.subscriptions.activatedInRange)} started, ${count(d.subscriptions.closedInRange)} closed in period`} />
            <Kpi label="Recurring revenue" value={money(d.recurring.mrr)} sub={`per month · ${money(d.recurring.arr)} a year`} />
            <Kpi to="/payments" label="Collected in period" value={money(d.revenue.collected)} sub={`${count(d.revenue.collectedCount)} payment${d.revenue.collectedCount === 1 ? '' : 's'} · ${money(d.revenue.invoiced)} invoiced`} />
            <Kpi to="/invoices?status=outstanding" label="Still owed" value={money(d.receivables.outstanding.amount)} sub={`${count(d.receivables.outstanding.count)} invoice${d.receivables.outstanding.count === 1 ? '' : 's'} · ${count(d.receivables.dueSoon.count)} due in 7 days`} />
            <Kpi to="/receivables" tone={d.receivables.overdue.count > 0 ? 'bad' : undefined} label="Overdue" value={money(d.receivables.overdue.amount)} sub={d.receivables.overdue.count > 0 ? `${count(d.receivables.overdue.count)} invoice${d.receivables.overdue.count === 1 ? '' : 's'} · oldest ${d.receivables.overdue.oldestDaysOverdue} days late` : 'Nothing overdue'} />
          </div>

          <div className="dash-grid">
            <section className="card" aria-labelledby="trend-title">
              <div className="card__head">
                <h2 id="trend-title">Invoiced and collected</h2>
                <span className="muted small">{fmtDate(d.range.from)} to {fmtDate(d.range.to)}, including tax</span>
              </div>
              <TrendChart points={d.trend.points} granularity={d.trend.granularity} />
            </section>
            <section className="card" aria-labelledby="mix-title">
              <div className="card__head">
                <h2 id="mix-title">Subscriptions by status</h2>
                <span className="muted small">{count(d.subscriptions.total)} in all</span>
              </div>
              <div className="card__body"><StatusMix byStatus={d.subscriptions.byStatus} /></div>
            </section>
          </div>
        </>
      )}
      {!d && dash.loading && valid && <div className="card"><div className="card__body"><div className="skeleton" style={{ height: 160 }} /></div></div>}

      <Lists range={range} valid={valid} />
    </>
  );
}

/* ---------- filtered lists under the summary ---------- */

type Tab = 'subscriptions' | 'invoices' | 'payments';

function Lists({ range, valid }: { range: { from: string; to: string }; valid: boolean }) {
  const [tab, setTab] = useState<Tab>('subscriptions');
  const tabs: { value: Tab; label: string }[] = [
    { value: 'subscriptions', label: 'Subscriptions' },
    { value: 'invoices', label: 'Invoices' },
    { value: 'payments', label: 'Payments' },
  ];
  return (
    <section className="card" aria-label="Details">
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.value} role="tab" className="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)}>{t.label}</button>
        ))}
      </div>
      {tab === 'subscriptions' && <SubscriptionsTab />}
      {tab === 'invoices' && <InvoicesTab range={range} valid={valid} />}
      {tab === 'payments' && <PaymentsTab range={range} valid={valid} />}
    </section>
  );
}

const STATUS_OPTIONS = [
  ['active', 'Active'],
  ['paused', 'Paused'],
  ['confirmed', 'Confirmed'],
  ['quotation', 'Quotation'],
  ['draft', 'Draft'],
  ['closed', 'Closed'],
  ['', 'All statuses'],
] as const;

function SubscriptionsTab() {
  const { money } = useMoney();
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const list = useQuery(() => api.get<Page<SubscriptionSummary>>(`/subscriptions${qs({ status, q: search, page, pageSize: 8 })}`), [status, search, page], { pollMs: 15000 });
  const items = list.data?.items ?? [];
  return (
    <>
      <div className="toolbar">
        <div className="search">
          <Search size={17} />
          <input className="input" type="search" placeholder="Search number, customer or company" aria-label="Search subscriptions" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <select className="select" aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <QueryStates query={list} isEmpty={!!list.data && items.length === 0} emptyIcon={<Search size={22} />} emptyTitle="No subscriptions match" emptyText="Try another status or search.">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Subscription</th>
                <th className="hide-sm">Plan</th>
                <th style={{ textAlign: 'right' }}>Per period</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link className="cell-main" to={`/subscriptions/${s.id}`}>{s.number}</Link>
                    <div className="cell-sub">{s.customer.company || s.customer.name}</div>
                  </td>
                  <td className="hide-sm">{s.plan.name}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{money(s.total)}</td>
                  <td><SubStatusBadge status={s.status} closeReason={s.closeReason} quoteExpired={s.quoteExpired} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data && <Pagination page={page} pageSize={8} total={list.data.total} onPage={setPage} />}
      </QueryStates>
    </>
  );
}

function InvoicesTab({ range, valid }: { range: { from: string; to: string }; valid: boolean }) {
  const { money } = useMoney();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const list = useQuery(
    () => (valid ? api.get<Page<InvoiceSummary>>(`/invoices${qs({ status, q: search, from: range.from, to: range.to, page, pageSize: 8 })}`) : Promise.resolve(null)),
    [status, search, range.from, range.to, page, valid],
    { pollMs: 15000 },
  );
  const items = list.data?.items ?? [];
  return (
    <>
      <div className="toolbar">
        <div className="search">
          <Search size={17} />
          <input className="input" type="search" placeholder="Search invoice or customer" aria-label="Search invoices" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <select className="select" aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="outstanding">Outstanding</option>
          <option value="overdue">Overdue</option>
          <option value="paid">Paid</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <div className="table-note">Invoices issued {fmtDate(range.from)} to {fmtDate(range.to)}.</div>
      <QueryStates query={list} isEmpty={!!list.data && items.length === 0} emptyIcon={<Search size={22} />} emptyTitle="No invoices match" emptyText="Try another period, status or search.">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th className="hide-sm">Issued</th>
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
                    <div className="cell-sub">{i.customer.company || i.customer.name}</div>
                  </td>
                  <td className="num hide-sm">{fmtDate(i.issueDate)}</td>
                  <td className="num">{fmtDate(i.dueDate)}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{money(i.total)}</td>
                  <td className="num hide-sm" style={{ textAlign: 'right' }}>{i.status === 'cancelled' ? '—' : money(i.balance)}</td>
                  <td><InvoiceStatusBadge status={i.status} overdue={i.isOverdue} daysOverdue={i.daysOverdue} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data && <Pagination page={page} pageSize={8} total={list.data.total} onPage={setPage} />}
      </QueryStates>
    </>
  );
}

function PaymentsTab({ range, valid }: { range: { from: string; to: string }; valid: boolean }) {
  const { money } = useMoney();
  const [method, setMethod] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery(
    () => (valid ? api.get<PaymentsResponse>(`/payments${qs({ method, from: range.from, to: range.to, page, pageSize: 8 })}`) : Promise.resolve(null)),
    [method, range.from, range.to, page, valid],
    { pollMs: 15000 },
  );
  const items = list.data?.items ?? [];
  return (
    <>
      <div className="toolbar">
        <select className="select" aria-label="Filter by method" value={method} onChange={(e) => { setMethod(e.target.value); setPage(1); }}>
          <option value="">All methods</option>
          {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div className="table-note">
        Payments received {fmtDate(range.from)} to {fmtDate(range.to)}{list.data ? <>: <strong>{money(list.data.totals.amount)}</strong> across {list.data.totals.count}</> : null}.
      </div>
      <QueryStates query={list} isEmpty={!!list.data && items.length === 0} emptyIcon={<Search size={22} />} emptyTitle="No payments in this period" emptyText="Try a longer period, or another method.">
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
                <tr key={p.id}>
                  <td className="num">{fmtDate(p.paidOn)}</td>
                  <td>
                    <Link className="cell-main" to={`/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link>
                    <div className="cell-sub">{p.customer?.company || p.customer?.name}</div>
                  </td>
                  <td className="hide-sm">{p.methodLabel}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data && <Pagination page={page} pageSize={8} total={list.data.total} onPage={setPage} />}
      </QueryStates>
    </>
  );
}
