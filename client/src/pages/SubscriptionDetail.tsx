import { ArrowLeft, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type ApiError, api } from '../api';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime } from '../format';
import { usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import type { SubAction, SubscriptionDetail } from '../salesTypes';
import { periodUnit } from '../types';
import { BreakdownTable } from '../ui/Breakdown';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/Dialog';
import { Alert, Badge, EmptyState, useToast } from '../ui/Feedback';
import { TextAreaField } from '../ui/Field';
import { Spinner } from '../ui/Spinner';
import { InvoiceStatusBadge } from '../ui/InvoiceStatus';
import { LifecycleStepper, STATUS_UI, SubStatusBadge } from '../ui/Status';

const DONE: Record<SubAction, string> = {
  send_quote: 'Quotation sent.',
  revert_to_draft: 'Moved back to draft.',
  confirm: 'Confirmed.',
  activate: 'The subscription is now active.',
  pause: 'Paused.',
  resume: 'Resumed.',
  close: 'The subscription is closed.',
  cancel: 'Cancelled.',
  renew: 'Renewed for another term.',
};
const FORWARD: SubAction[] = ['send_quote', 'confirm', 'activate'];
const NEEDS_CONFIRM: SubAction[] = ['close', 'cancel', 'renew'];
const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  send_quote: 'Quotation sent',
  revert_to_draft: 'Moved back to draft',
  confirm: 'Confirmed',
  activate: 'Activated',
  pause: 'Paused',
  resume: 'Resumed',
  close: 'Closed early',
  cancel: 'Cancelled',
  renew: 'Renewed',
  auto_close: 'Closed automatically',
  invoice: 'Invoiced',
};

export function SubscriptionDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const { money } = useMoney();
  const isStaff = user?.role !== 'customer';
  const q = useQuery(() => api.get<{ subscription: SubscriptionDetail }>(`/subscriptions/${id}`), [id], { pollMs: 15000 });
  const sub = q.data?.subscription;
  usePageTitle(sub?.number ?? 'Subscription');

  const [confirming, setConfirming] = useState<SubAction | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<SubAction | null>(null);

  async function run(action: SubAction, withNote?: string) {
    setBusy(action);
    try {
      await api.post(`/subscriptions/${id}/actions/${action}`, withNote ? { note: withNote } : {});
      toast.success(DONE[action]);
      setConfirming(null);
      setNote('');
      q.reload();
    } catch (err) {
      toast.error((err as ApiError).message);
      setConfirming(null);
      q.reload();
    } finally {
      setBusy(null);
    }
  }

  if (q.error && !sub) {
    return (
      <EmptyState icon={<ArrowLeft size={22} />} title={q.error.status === 404 ? 'Subscription not found' : 'Could not load this subscription'} action={<Link className="btn btn--secondary" to="/subscriptions">Back to subscriptions</Link>}>
        {q.error.status === 404 ? 'It may have been removed, or it belongs to someone else.' : q.error.message}
      </EmptyState>
    );
  }
  if (!sub) {
    return (
      <div className="state">
        <Spinner large />
      </div>
    );
  }

  const act = (a: SubAction) => (NEEDS_CONFIRM.includes(a) ? (setNote(''), setConfirming(a)) : void run(a));
  const confirmLabel = sub.actions.find((a) => a.action === confirming)?.label ?? '';
  const rows = sub.lines.map((l) => ({
    key: l.id,
    description: l.description,
    detail: `${l.quantity} × ${money(l.unitPrice)} · ${l.taxName ? `${l.taxName} ${l.taxRatePercent}%` : 'No tax'}`,
    subtotal: l.subtotal,
    discount: l.discount,
    tax: l.tax,
    total: l.total,
  }));
  const rules = [sub.planRules.autoClose && 'Closes automatically at expiry', sub.planRules.allowPause && 'Can be paused', sub.planRules.allowEarlyClose && 'Can be closed early', sub.planRules.allowRenewal && 'Can be renewed'].filter(Boolean) as string[];

  return (
    <>
      <Link to="/subscriptions" className="back-link"><ArrowLeft size={16} /> {isStaff ? 'Subscriptions' : 'My subscriptions'}</Link>
      <header className="page-head">
        <div>
          <h1 style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {sub.number} <SubStatusBadge status={sub.status} closeReason={sub.closeReason} quoteExpired={sub.quoteExpired} />
          </h1>
          <p>
            {isStaff ? `${sub.customer.company || sub.customer.name} · ` : ''}
            {sub.plan.name}, billed every {periodUnit(sub.plan.billingPeriod)}
          </p>
        </div>
        <div className="page-head__actions">
          {isStaff && sub.status === 'draft' && <Link className="btn btn--secondary" to={`/subscriptions/${sub.id}/edit`}><Pencil size={16} /> Edit</Link>}
          {sub.actions.map((a) => (
            <Button key={a.action} variant={FORWARD.includes(a.action) ? 'primary' : a.action === 'cancel' || a.action === 'close' ? 'secondary' : 'secondary'} loading={busy === a.action} disabled={busy !== null} onClick={() => act(a.action)}>
              {a.label}
            </Button>
          ))}
        </div>
      </header>

      {sub.quoteExpired && <div style={{ marginBottom: 16 }}><Alert tone="error">This quotation expired on {fmtDate(sub.quoteValidUntil!)} and can no longer be confirmed.{isStaff ? ' Move it back to draft and send a new one.' : ' Ask Brightloop for a new quotation.'}</Alert></div>}
      {sub.status === 'quotation' && !sub.quoteExpired && sub.quoteValidUntil && <div style={{ marginBottom: 16 }}><Alert tone="info">This quotation is valid until {fmtDate(sub.quoteValidUntil)}.</Alert></div>}
      {sub.status === 'paused' && <div style={{ marginBottom: 16 }}><Alert tone="info">Billing is paused. Resume the subscription to start billing again.</Alert></div>}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card__body"><LifecycleStepper status={sub.status} closeReason={sub.closeReason} /></div>
      </section>

      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <div className="card__head">
              <h2>Lines</h2>
              <span className="muted small">Cost of one billing period</span>
            </div>
            {sub.lines.length === 0 ? (
              <div className="card__body muted">This subscription has no lines yet.</div>
            ) : (
              <BreakdownTable rows={rows} totals={sub.totals} totalLabel="Per billing period" />
            )}
            {sub.estimatedDiscount && (
              <div className="card__body" style={{ borderTop: '1px solid var(--line)' }}>
                <Alert tone="success"><strong>{sub.estimatedDiscount.name}</strong> would currently save {money(sub.estimatedDiscount.amount)} per invoice. Discounts are applied automatically when an invoice is created.</Alert>
              </div>
            )}
          </section>
          {sub.invoices.length > 0 && (
            <section className="card">
              <div className="card__head">
                <h2>Invoices</h2>
                <Link to={`/invoices?subscriptionId=${sub.id}`} className="small">All</Link>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {sub.invoices.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <Link className="cell-main" to={`/invoices/${i.id}`}>{i.number}</Link>
                          <div className="cell-sub">{fmtDate(i.periodStart)} to {fmtDate(i.periodEnd)}</div>
                        </td>
                        <td className="num" style={{ textAlign: 'right' }}>{money(i.total)}</td>
                        <td><InvoiceStatusBadge status={i.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <section className="card">
            <div className="card__head"><h2>History</h2></div>
            <div className="card__body">
              <ol className="timeline">
                {[...sub.events].reverse().map((e) => (
                  <li key={e.id}>
                    <div className="timeline__title">
                      {ACTION_LABEL[e.action] ?? e.action}
                      {e.fromStatus && e.fromStatus !== e.toStatus && <span className="muted" style={{ fontWeight: 500 }}> · {STATUS_UI[e.fromStatus].label} → {STATUS_UI[e.toStatus].label}</span>}
                    </div>
                    <div className="timeline__meta">{fmtDateTime(e.at)} · {e.actor?.name ?? 'Automatic'}</div>
                    {e.note && <div className="timeline__note">{e.note}</div>}
                  </li>
                ))}
              </ol>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="card__head"><h2>Details</h2></div>
            <div className="card__body">
              <dl className="kv">
                <dt>Customer</dt>
                <dd>
                  {sub.customer.company || sub.customer.name}
                  {sub.customer.company && <div className="muted small">{sub.customer.name}</div>}
                  <div className="muted small">{sub.customer.email}</div>
                </dd>
                <dt>Plan</dt>
                <dd>{sub.plan.name}</dd>
                <dt>Starts</dt>
                <dd>{fmtDate(sub.startDate)}</dd>
                <dt>Expires</dt>
                <dd>{fmtDate(sub.expiryDate)}</dd>
                {sub.nextBillingDate && sub.status !== 'closed' && (
                  <>
                    <dt>Next invoice</dt>
                    <dd>{fmtDate(sub.nextBillingDate)}</dd>
                  </>
                )}
                <dt>Payment terms</dt>
                <dd>{sub.paymentTerms ? `${sub.paymentTerms.name} (${sub.paymentTerms.daysDue === 0 ? 'due on receipt' : `${sub.paymentTerms.daysDue} days`})` : 'Not set'}</dd>
                {sub.closedAt && (
                  <>
                    <dt>Closed</dt>
                    <dd>{fmtDate(sub.closedAt)}</dd>
                  </>
                )}
              </dl>
              {rules.length > 0 && (
                <div className="chips" style={{ marginTop: 16 }}>
                  {rules.map((r) => <Badge key={r} tone="mute" plain>{r}</Badge>)}
                </div>
              )}
              {isStaff && sub.notes && (
                <p className="small" style={{ marginTop: 16 }}>
                  <strong>Internal notes</strong>
                  <br />
                  {sub.notes}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={`${confirmLabel}?`}
        confirmLabel={confirmLabel}
        danger={confirming === 'close' || confirming === 'cancel'}
        busy={busy !== null}
        onConfirm={() => confirming && run(confirming, note.trim() || undefined)}
        onClose={() => busy === null && setConfirming(null)}
      >
        {confirming === 'close' && <p>Billing stops and the subscription is closed before its expiry date of {fmtDate(sub.expiryDate)}. This cannot be undone.</p>}
        {confirming === 'cancel' && <p>This {STATUS_UI[sub.status].label.toLowerCase()} will be cancelled and cannot be reopened.</p>}
        {confirming === 'renew' && <p>The expiry date moves forward by one more term of the same length as the current one.</p>}
        <TextAreaField label="Note (optional)" value={note} onChange={setNote} rows={2} hint="Saved in the history." />
      </ConfirmDialog>
    </>
  );
}
