import { CheckCircle2, Receipt } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDate } from '../format';
import { useQuery } from '../hooks';
import { useMoney } from '../meta';
import type { PortalSummary } from '../dashboardTypes';
import type { SubStatus } from '../salesTypes';
import { periodUnit, type BillingPeriod } from '../types';
import { Alert, EmptyState } from '../ui/Feedback';
import { InvoiceStatusBadge } from '../ui/InvoiceStatus';
import { Kpi } from '../ui/Kpi';
import { PageHeader } from '../ui/Layout';
import { Skeleton } from '../ui/Spinner';
import { SubStatusBadge } from '../ui/Status';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const METHOD: Record<string, string> = { bank_transfer: 'Bank transfer', cash: 'Cash', cheque: 'Cheque', card: 'Card', upi: 'UPI', other: 'Other' };

/** What a customer sees first: where their subscriptions and invoices stand. Everything here is theirs alone. */
export function PortalHome() {
  const { user } = useAuth();
  const { money, count } = useMoney();
  const q = useQuery(() => api.get<{ summary: PortalSummary | null }>('/portal/summary'), [], { pollMs: 20000 });
  const s = q.data?.summary;
  const first = user?.name.split(' ')[0] ?? '';

  return (
    <>
      <PageHeader title={`${greeting()}, ${first}`} description="Here is where your subscriptions and invoices with Brightloop stand." />

      {q.error && !q.data && <Alert>Could not load your overview: {q.error.message}</Alert>}
      {q.loading && !q.data && (
        <div className="card"><div className="card__body" style={{ display: 'grid', gap: 14 }}><Skeleton width="40%" /><Skeleton /><Skeleton width="70%" /></div></div>
      )}
      {q.data && s === null && (
        <EmptyState icon={<Receipt size={22} />} title="Your account is not linked to a customer record yet">
          Ask your Brightloop contact to link it, and your subscriptions and invoices will appear here.
        </EmptyState>
      )}

      {s && (
        <>
          {s.invoices.next ? (
            <div className="next-due" data-late={s.invoices.next.isOverdue}>
              <div>
                <h2>{s.invoices.next.isOverdue ? 'An invoice is overdue' : 'Your next invoice is due'}</h2>
                <p>
                  <Link to={`/invoices/${s.invoices.next.id}`}>{s.invoices.next.number}</Link>: {money(s.invoices.next.balance)} {s.invoices.next.isOverdue ? 'was due' : 'due'} on {fmtDate(s.invoices.next.dueDate)}.
                </p>
              </div>
              <Link className="btn btn--secondary" to={`/invoices/${s.invoices.next.id}`}>View invoice</Link>
            </div>
          ) : (
            <div className="next-due">
              <div>
                <h2 style={{ display: 'flex', gap: 8, alignItems: 'center' }}><CheckCircle2 size={20} color="var(--ok)" /> You are all paid up</h2>
                <p>There is nothing owing on your account right now.</p>
              </div>
            </div>
          )}

          <div className="stat-grid">
            <Kpi to="/subscriptions" label="Active subscriptions" value={count(s.subscriptions.active)} sub={s.subscriptions.byStatus.paused ? `${count(s.subscriptions.byStatus.paused)} paused` : 'Manage them any time'} />
            <Kpi to="/invoices?status=outstanding" label="You owe" value={money(s.invoices.outstanding.amount)} sub={`${count(s.invoices.outstanding.count)} invoice${s.invoices.outstanding.count === 1 ? '' : 's'}`} />
            <Kpi to="/invoices?status=overdue" tone={s.invoices.overdue.count > 0 ? 'bad' : undefined} label="Overdue" value={money(s.invoices.overdue.amount)} sub={s.invoices.overdue.count > 0 ? `${count(s.invoices.overdue.count)} invoice${s.invoices.overdue.count === 1 ? '' : 's'} past due` : 'Nothing overdue'} />
            <Kpi label="Paid to date" value={money(s.payments.totalPaid)} sub={`${count(s.payments.count)} payment${s.payments.count === 1 ? '' : 's'}`} />
          </div>

          <div className="portal-grid">
            <section className="card">
              <div className="card__head"><h2>Your subscriptions</h2><Link to="/subscriptions" className="small">All</Link></div>
              {s.subscriptions.items.length === 0 ? (
                <div className="card__body muted">No subscriptions yet.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      {s.subscriptions.items.map((i) => (
                        <tr key={i.id}>
                          <td>
                            <Link className="cell-main" to={`/subscriptions/${i.id}`}>{i.number}</Link>
                            <div className="cell-sub">{i.plan}{i.nextBillingDate ? ` · next invoice ${fmtDate(i.nextBillingDate)}` : ''}</div>
                          </td>
                          <td className="num" style={{ textAlign: 'right' }}>
                            {money(i.perPeriod)}
                            <div className="cell-sub">per {periodUnit(i.billingPeriod as BillingPeriod)}</div>
                          </td>
                          <td><SubStatusBadge status={i.status as SubStatus} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="stack">
              <section className="card">
                <div className="card__head"><h2>Recent invoices</h2><Link to="/invoices" className="small">All</Link></div>
                {s.invoices.recent.length === 0 ? (
                  <div className="card__body muted">No invoices yet.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        {s.invoices.recent.map((i) => (
                          <tr key={i.id}>
                            <td>
                              <Link className="cell-main" to={`/invoices/${i.id}`}>{i.number}</Link>
                              <div className="cell-sub">Due {fmtDate(i.dueDate)}</div>
                            </td>
                            <td className="num" style={{ textAlign: 'right' }}>{money(i.total)}</td>
                            <td><InvoiceStatusBadge status={i.status as 'confirmed' | 'paid'} overdue={i.status === 'confirmed' && i.balance > 0 && i.dueDate < new Date().toISOString().slice(0, 10)} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="card">
                <div className="card__head"><h2>Recent payments</h2></div>
                {s.payments.recent.length === 0 ? (
                  <div className="card__body muted">No payments recorded yet.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        {s.payments.recent.map((p) => (
                          <tr key={p.id}>
                            <td>
                              <span className="cell-main">{money(p.amount)}</span>
                              <div className="cell-sub">{METHOD[p.method] ?? p.method} · {fmtDate(p.paidOn)}</div>
                            </td>
                            <td className="cell-actions"><Link to={`/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </>
  );
}
