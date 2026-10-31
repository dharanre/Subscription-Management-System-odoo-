import { AlertTriangle, CalendarCheck, Play, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type Page, api, qs } from '../api';
import { fmtDate, fmtDateTime } from '../format';
import { usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import { isDate } from '../parse';
import type { BillingFailureRow, BillingRunResult, BillingRunRow, DueResponse } from '../billingTypes';
import { Button } from '../ui/Button';
import { Alert, Badge, EmptyState, useToast } from '../ui/Feedback';
import { CheckboxField, TextField } from '../ui/Field';
import { PageHeader, Pagination } from '../ui/Layout';
import { QueryStates } from '../ui/Query';

const today = () => new Date().toISOString().slice(0, 10);

/** Billing day: see what is due, run it, and chase anything that could not be billed. */
export function BillingPage() {
  usePageTitle('Billing');
  const { money } = useMoney();
  const toast = useToast();
  const [asOf, setAsOf] = useState(today());
  const [confirmNow, setConfirmNow] = useState(false);
  const [page, setPage] = useState(1);
  const [running, setRunning] = useState(false);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [result, setResult] = useState<BillingRunResult | null>(null);

  const dateOk = isDate(asOf) && asOf <= today();
  const due = useQuery(() => (dateOk ? api.get<DueResponse>(`/billing/due${qs({ asOf, page, pageSize: 8 })}`) : Promise.resolve(null)), [asOf, page, dateOk], { pollMs: 15000 });
  const failures = useQuery(() => api.get<Page<BillingFailureRow>>('/billing/failures?pageSize=20'), [], { pollMs: 15000 });
  const runs = useQuery(() => api.get<Page<BillingRunRow>>('/billing/runs?pageSize=6'), [], { pollMs: 15000 });
  const refresh = () => {
    due.reload();
    failures.reload();
    runs.reload();
  };

  const d = due.data;
  const openFailures = failures.data?.items ?? [];

  async function runBilling() {
    setRunning(true);
    try {
      const res = await api.post<{ run: BillingRunResult }>('/billing/run', { asOf, confirm: confirmNow });
      setResult(res.run);
      setPage(1);
      if (res.run.failed.length) toast.error(`${res.run.failed.length} subscription${res.run.failed.length === 1 ? '' : 's'} could not be billed. See "Needs attention".`);
      else toast.success(res.run.created.length ? `${res.run.created.length} invoice${res.run.created.length === 1 ? '' : 's'} created.` : 'Nothing was due, so nothing was created.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Billing could not run.');
    } finally {
      setRunning(false);
      refresh();
    }
  }

  async function retry(f: BillingFailureRow) {
    setRetrying(f.id);
    try {
      const res = await api.post<{ resolved: boolean; run: BillingRunResult }>(`/billing/failures/${f.id}/retry`, { confirm: confirmNow });
      setResult(res.run); // replaces the earlier result, so a fixed problem is not still shown as failed
      if (res.resolved) toast.success(`${f.subscription.number} is sorted${res.run.created.length ? `: ${res.run.created.length} invoice${res.run.created.length === 1 ? '' : 's'} created` : ''}.`);
      else toast.error(`${f.subscription.number} still cannot be billed: ${res.run.failed[0]?.message ?? 'see the message'}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not retry.');
    } finally {
      setRetrying(null);
      refresh();
    }
  }

  return (
    <>
      <PageHeader
        title="Billing"
        description="Invoices are created from subscriptions, never typed by hand. Each billing period is invoiced once, so running billing again is always safe."
        actions={<Link className="btn btn--secondary" to="/invoices">All invoices</Link>}
      />

      <div className="stack">
        {openFailures.length > 0 && (
          <section className="card" aria-labelledby="attention">
            <div className="card__head">
              <h2 id="attention" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <AlertTriangle size={18} color="var(--bad)" /> Needs attention
              </h2>
              <Badge tone="bad">{failures.data?.total} open</Badge>
            </div>
            <div className="card__body" style={{ paddingBottom: 0 }}>
              <Alert tone="error">These subscriptions are due but could not be invoiced. They stay here, and are tried again on every run, until they are fixed.</Alert>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Subscription</th>
                    <th>What went wrong</th>
                    <th className="hide-sm">Tries</th>
                    <th className="cell-actions"><span className="sr-only">Retry</span></th>
                  </tr>
                </thead>
                <tbody>
                  {openFailures.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <Link className="cell-main" to={`/subscriptions/${f.subscription.id}`}>{f.subscription.number}</Link>
                        <div className="cell-sub">{f.customer} · period {f.periodIndex + 1}</div>
                      </td>
                      <td>{f.message}</td>
                      <td className="num hide-sm">
                        {f.attempts}
                        <div className="cell-sub">last {fmtDateTime(f.lastFailedAt)}</div>
                      </td>
                      <td className="cell-actions">
                        <Button size="sm" variant="secondary" icon={<RotateCw size={14} />} loading={retrying === f.id} disabled={retrying !== null} onClick={() => retry(f)}>
                          Retry
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="card" aria-labelledby="ready">
          <div className="card__head">
            <h2 id="ready">Ready to bill</h2>
            <div style={{ width: 190 }}>
              <TextField label="Bill up to" type="date" value={asOf} max={today()} onChange={setAsOf} error={dateOk ? undefined : 'Choose today or an earlier date'} />
            </div>
          </div>
          <div className="stat-grid" style={{ padding: '16px 20px 0', marginBottom: 0 }}>
            <div className="card stat" style={{ boxShadow: 'none' }}>
              <div className="stat__label">Subscriptions due</div>
              <div className="stat__value">{d ? d.subscriptionsDue : '–'}</div>
            </div>
            <div className="card stat" style={{ boxShadow: 'none' }}>
              <div className="stat__label">Billing periods due</div>
              <div className="stat__value">{d ? d.periodsDue : '–'}</div>
              <div className="stat__sub">{d && d.periodsDue > d.subscriptionsDue ? 'Some are catching up on missed periods' : 'One per subscription'}</div>
            </div>
          </div>
          <QueryStates
            query={due}
            isEmpty={!!d && d.items.length === 0}
            emptyIcon={<CalendarCheck size={22} />}
            emptyTitle="Nothing is due"
            emptyText={`Every active subscription is invoiced up to ${fmtDate(asOf)}. Invoices appear here as new billing periods begin.`}
          >
            {d && (
              <>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Subscription</th>
                        <th className="hide-sm">Plan</th>
                        <th>Next period</th>
                        <th style={{ textAlign: 'right' }}>Per period</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.items.map((i) => (
                        <tr key={i.subscriptionId}>
                          <td>
                            <Link className="cell-main" to={`/subscriptions/${i.subscriptionId}`}>{i.number}</Link>
                            <div className="cell-sub">{i.customer}</div>
                          </td>
                          <td className="hide-sm">{i.plan}</td>
                          <td className="num">
                            {fmtDate(i.nextPeriodStart)}
                            {i.periodsDue > 1 && <div className="cell-sub">{i.periodsDue} periods due</div>}
                          </td>
                          <td className="num" style={{ textAlign: 'right' }}>
                            {money(i.perPeriod)}
                            <div className="cell-sub">before discounts</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
              </>
            )}
          </QueryStates>
          <div className="card__body" style={{ borderTop: '1px solid var(--line)', display: 'flex', gap: 16, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
            <CheckboxField label="Confirm invoices as they are created" hint="Otherwise they are left as drafts for you to review first." checked={confirmNow} onChange={setConfirmNow} />
            <Button icon={<Play size={16} />} loading={running} disabled={!dateOk || (d?.subscriptionsDue ?? 0) === 0} onClick={runBilling}>
              Run billing{d && d.subscriptionsDue > 0 ? ` for ${d.subscriptionsDue}` : ''}
            </Button>
          </div>
        </section>

        {result && (
          <section className="card" aria-live="polite">
            <div className="card__head">
              <h2>Result of run #{result.runId}</h2>
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>Dismiss</Button>
            </div>
            <div className="card__body" style={{ display: 'grid', gap: 12 }}>
              <Alert tone={result.failed.length ? 'info' : 'success'}>
                {result.created.length} invoice{result.created.length === 1 ? '' : 's'} created from {result.due} subscription{result.due === 1 ? '' : 's'} due for {fmtDate(result.asOf)}.
                {result.failed.length > 0 && ` ${result.failed.length} could not be billed.`}
              </Alert>
              {result.created.length > 0 && (
                <div className="chips">
                  {result.created.slice(0, 12).map((c) => (
                    <Link key={c.id} className="chip" to={`/invoices/${c.id}`}>{c.number} · {money(c.total)}</Link>
                  ))}
                  {result.created.length > 12 && <Link className="chip" to="/invoices">+{result.created.length - 12} more</Link>}
                </div>
              )}
              {result.failed.map((f) => (
                <Alert key={`${f.subscriptionId}-${f.periodIndex}`} tone="error"><strong>{f.subscriptionNumber}:</strong> {f.message}</Alert>
              ))}
            </div>
          </section>
        )}

        <section className="card" aria-labelledby="history">
          <div className="card__head"><h2 id="history">Recent runs</h2></div>
          <QueryStates query={runs} isEmpty={!!runs.data && runs.data.items.length === 0} emptyIcon={<CalendarCheck size={22} />} emptyTitle="No billing runs yet" emptyText="Each run is recorded here with how many invoices it created.">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Billed up to</th>
                    <th style={{ textAlign: 'right' }}>Due</th>
                    <th style={{ textAlign: 'right' }}>Created</th>
                    <th style={{ textAlign: 'right' }}>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {(runs.data?.items ?? []).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <span className="cell-main">#{r.id}</span>
                        <div className="cell-sub">{fmtDateTime(r.startedAt)} · {r.by ?? 'System'}{r.autoConfirm ? ' · confirmed' : ''}</div>
                      </td>
                      <td className="num">{fmtDate(r.asOf)}</td>
                      <td className="num" style={{ textAlign: 'right' }}>{r.due}</td>
                      <td className="num" style={{ textAlign: 'right' }}>{r.created}</td>
                      <td className="num" style={{ textAlign: 'right' }}>{r.failed > 0 ? <Badge tone="bad">{r.failed}</Badge> : 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryStates>
        </section>
      </div>
      <span className="sr-only">{failures.error ? 'Could not load failures' : ''}</span>
      {!d && !due.loading && !dateOk && <EmptyState icon={<CalendarCheck size={22} />} title="Choose a valid date">Billing can run for today or any earlier date.</EmptyState>}
    </>
  );
}
