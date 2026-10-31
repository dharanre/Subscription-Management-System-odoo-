import { BellRing, CheckCircle2, Hourglass } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type ApiError, type Page, api, qs } from '../api';
import { fmtDate } from '../format';
import { usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import type { InvoiceSummary, ReceivablesSummary } from '../billingTypes';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Feedback';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';
import { type PayableInvoice, RecordPaymentDialog } from '../ui/RecordPaymentDialog';

const PAGE_SIZE = 8;

/** Who owes what, how late it is, and the shortest route to chasing or settling it. */
export function ReceivablesPage() {
  usePageTitle('Receivables');
  const { money } = useMoney();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState<PayableInvoice | null>(null);
  const [reminding, setReminding] = useState<number | null>(null);

  const summary = useQuery(() => api.get<ReceivablesSummary>('/receivables/summary'), [], { pollMs: 20000 });
  const overdue = useQuery(() => api.get<Page<InvoiceSummary>>(`/invoices${qs({ status: 'overdue', sort: 'due', page, pageSize: PAGE_SIZE })}`), [page], { pollMs: 20000 });
  const refresh = () => {
    summary.reload();
    overdue.reload();
  };

  const s = summary.data;
  const max = Math.max(1, ...(s?.buckets.map((b) => b.amount) ?? [0]));
  const items = overdue.data?.items ?? [];

  async function remind(inv: InvoiceSummary) {
    setReminding(inv.id);
    try {
      await api.post(`/invoices/${inv.id}/actions/send`, {});
      toast.success(`Reminder for ${inv.number} emailed to the customer.`);
    } catch (err) {
      toast.error((err as ApiError).message);
    } finally {
      setReminding(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Receivables"
        description="What customers still owe, by how late it is, so overdue invoices can be chased before they turn into lost revenue."
        actions={<Link className="btn btn--secondary" to="/invoices?status=outstanding">All outstanding invoices</Link>}
      />

      <div className="stat-grid">
        <div className="card stat">
          <div className="stat__label">Outstanding</div>
          <div className="stat__value">{s ? money(s.outstanding.amount) : '–'}</div>
          <div className="stat__sub">{s ? `${s.outstanding.count} invoice${s.outstanding.count === 1 ? '' : 's'} not yet paid` : ' '}</div>
        </div>
        <div className="card stat" style={s && s.overdue.count > 0 ? { borderColor: 'var(--bad-line)' } : undefined}>
          <div className="stat__label">Overdue</div>
          <div className="stat__value" style={s && s.overdue.count > 0 ? { color: 'var(--bad)' } : undefined}>{s ? money(s.overdue.amount) : '–'}</div>
          <div className="stat__sub">{s ? (s.overdue.count > 0 ? `${s.overdue.count} invoice${s.overdue.count === 1 ? '' : 's'}, oldest ${s.overdue.oldestDaysOverdue} days late` : 'Nothing is overdue') : ' '}</div>
        </div>
        <div className="card stat">
          <div className="stat__label">Not yet due</div>
          <div className="stat__value">{s ? money(s.buckets.find((b) => b.key === 'current')?.amount ?? 0) : '–'}</div>
          <div className="stat__sub">{s ? `${s.buckets.find((b) => b.key === 'current')?.count ?? 0} invoices within terms` : ' '}</div>
        </div>
      </div>

      <div className="stack">
        <section className="card" aria-labelledby="aging">
          <div className="card__head"><h2 id="aging">How late is it?</h2></div>
          <div className="card__body">
            {summary.error ? (
              <p className="muted">Could not load the summary: {summary.error.message}</p>
            ) : (
              <ul className="aging">
                {(s?.buckets ?? []).map((b) => (
                  <li key={b.key} data-bucket={b.key}>
                    <span className="aging__label">{b.label}</span>
                    <span className="aging__track" aria-hidden="true">
                      <span className="aging__bar" style={{ width: `${(b.amount / max) * 100}%` }} />
                    </span>
                    <span className="aging__value num">
                      {money(b.amount)}
                      <span className="muted small"> · {b.count} invoice{b.count === 1 ? '' : 's'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby="chase">
          <div className="card__head">
            <h2 id="chase">Overdue invoices, longest first</h2>
            <Hourglass size={18} color="var(--ink-500)" />
          </div>
          <QueryStates query={overdue} isEmpty={!!overdue.data && items.length === 0} emptyIcon={<CheckCircle2 size={22} />} emptyTitle="Nothing is overdue" emptyText="Every invoice is either paid or still within its payment terms.">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Due</th>
                    <th style={{ textAlign: 'right' }}>Still owing</th>
                    <th className="cell-actions"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link className="cell-main" to={`/invoices/${i.id}`}>{i.number}</Link>
                        <div className="cell-sub">{i.customer.company || i.customer.name}</div>
                      </td>
                      <td className="num">
                        {fmtDate(i.dueDate)}
                        <div className="cell-sub" style={{ color: 'var(--bad)', fontWeight: 600 }}>{i.daysOverdue} day{i.daysOverdue === 1 ? '' : 's'} late</div>
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {money(i.balance)}
                        {i.paid > 0 && <div className="cell-sub">of {money(i.total)}</div>}
                      </td>
                      <td className="cell-actions">
                        <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <Button size="sm" variant="secondary" icon={<BellRing size={14} />} loading={reminding === i.id} disabled={reminding !== null} onClick={() => remind(i)}>
                            Remind
                          </Button>
                          <Button size="sm" onClick={() => setPaying({ id: i.id, number: i.number, balance: i.balance, issueDate: i.issueDate })}>Record payment</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {overdue.data && <Pagination page={page} pageSize={PAGE_SIZE} total={overdue.data.total} onPage={setPage} />}
          </QueryStates>
        </section>
      </div>

      <RecordPaymentDialog invoice={paying} onClose={() => setPaying(null)} onRecorded={refresh} />
    </>
  );
}
