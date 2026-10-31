import { ArrowLeft, Banknote, Printer } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type ApiError, api } from '../api';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime } from '../format';
import { usePageTitle, useQuery } from '../hooks';
import { useMoney } from '../meta';
import type { InvoiceAction, InvoiceDetail, Payment } from '../billingTypes';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/Dialog';
import { Alert, Badge, EmptyState, useToast } from '../ui/Feedback';
import { TextAreaField } from '../ui/Field';
import { InvoiceDocument } from '../ui/InvoiceDocument';
import { RecordPaymentDialog } from '../ui/RecordPaymentDialog';
import { Spinner } from '../ui/Spinner';

const DONE: Record<InvoiceAction, string> = { confirm: 'Invoice confirmed.', send: 'Invoice emailed to the customer.', cancel: 'Invoice cancelled.' };
const EVENT_LABEL: Record<string, string> = { create: 'Created by billing', confirm: 'Confirmed', send: 'Emailed', cancel: 'Cancelled', paid: 'Marked paid', payment: 'Payment recorded', payment_void: 'Payment voided' };

export function InvoiceDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const { money } = useMoney();
  const isStaff = user?.role !== 'customer';
  const q = useQuery(() => api.get<{ invoice: InvoiceDetail }>(`/invoices/${id}`), [id], { pollMs: 15000 });
  const inv = q.data?.invoice;
  usePageTitle(inv?.number ?? 'Invoice');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<InvoiceAction | null>(null);
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState('');

  async function run(action: InvoiceAction, note?: string) {
    setBusy(action);
    try {
      await api.post(`/invoices/${id}/actions/${action}`, note ? { note } : {});
      toast.success(DONE[action]);
      setCancelling(false);
      setReason('');
    } catch (err) {
      toast.error((err as ApiError).message);
    } finally {
      setBusy(null);
      q.reload();
    }
  }

  async function voidIt() {
    if (!voiding) return;
    if (!voidReason.trim()) {
      setVoidError('Say why this payment is being voided');
      return;
    }
    setVoidBusy(true);
    try {
      await api.post(`/payments/${voiding.id}/void`, { reason: voidReason.trim() });
      toast.success(`The ${money(voiding.amount)} payment was voided.`);
      setVoiding(null);
      setVoidReason('');
      setVoidError('');
    } catch (err) {
      setVoidError((err as ApiError).message);
    } finally {
      setVoidBusy(false);
      q.reload();
    }
  }

  if (q.error && !inv) {
    return (
      <EmptyState icon={<ArrowLeft size={22} />} title={q.error.status === 404 ? 'Invoice not found' : 'Could not load this invoice'} action={<Link className="btn btn--secondary" to="/invoices">Back to invoices</Link>}>
        {q.error.status === 404 ? 'It may not exist, or it is not one of yours.' : q.error.message}
      </EmptyState>
    );
  }
  if (!inv) {
    return (
      <div className="state">
        <Spinner large />
      </div>
    );
  }

  return (
    <>
      <Link to="/invoices" className="back-link"><ArrowLeft size={16} /> {isStaff ? 'Invoices' : 'My invoices'}</Link>
      <header className="page-head">
        <div>
          <h1>{inv.number}</h1>
          <p>
            {isStaff ? `${inv.customer.company || inv.customer.name} · ` : ''}
            for <Link to={`/subscriptions/${inv.subscription.id}`}>{inv.subscription.number}</Link>
          </p>
        </div>
        <div className="page-head__actions">
          {inv.canRecordPayment && <Button icon={<Banknote size={16} />} onClick={() => setPaying(true)}>Record payment</Button>}
          {inv.actions.map((a) => (
            <Button key={a.action} variant={a.action === 'confirm' ? 'primary' : 'secondary'} loading={busy === a.action} disabled={busy !== null} onClick={() => (a.action === 'cancel' ? setCancelling(true) : void run(a.action))}>
              {a.action === 'send' && inv.isOverdue ? 'Send reminder' : a.label}
            </Button>
          ))}
          <Link className="btn btn--secondary" to={`/invoices/${inv.id}/print`} target="_blank" rel="noreferrer"><Printer size={16} /> Print</Link>
        </div>
      </header>

      {inv.status === 'draft' && isStaff && <div style={{ marginBottom: 16 }}><Alert tone="info">This invoice is a draft made by billing. Confirm it when it looks right; the customer cannot see it until then.</Alert></div>}
      {inv.isOverdue && <div style={{ marginBottom: 16 }}><Alert tone="error">This invoice was due on {fmtDate(inv.dueDate)} and is {inv.daysOverdue} day{inv.daysOverdue === 1 ? '' : 's'} overdue. {money(inv.balance)} is still owing.</Alert></div>}
      {inv.status === 'cancelled' && <div style={{ marginBottom: 16 }}><Alert tone="info">Cancelled on {fmtDate(inv.cancelledAt!)}{inv.cancelReason ? `: ${inv.cancelReason}` : ''}. This billing period will not be invoiced again.</Alert></div>}
      {inv.status === 'paid' && <div style={{ marginBottom: 16 }}><Alert tone="success">Paid in full{inv.paidAt ? ` on ${fmtDate(inv.paidAt)}` : ''}.</Alert></div>}

      <div className="detail-grid">
        <section className="card">
          <div className="card__body"><InvoiceDocument invoice={inv} /></div>
        </section>
        <div className="stack">
          <section className="card" aria-labelledby="payments">
            <div className="card__head">
              <h2 id="payments">Payments</h2>
              {inv.totals.paid > 0 && <span className="muted small">{money(inv.totals.paid)} of {money(inv.totals.total)}</span>}
            </div>
            {inv.payments.length === 0 ? (
              <div className="card__body muted small">
                {inv.status === 'draft' ? 'Payments can be recorded once the invoice is confirmed.' : inv.status === 'cancelled' ? 'This invoice was cancelled.' : 'No payment has been recorded yet.'}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {inv.payments.map((p) => (
                      <tr key={p.id} style={p.status === 'voided' ? { opacity: 0.6 } : undefined}>
                        <td>
                          <span className="cell-main" style={{ textDecoration: p.status === 'voided' ? 'line-through' : undefined }}>{money(p.amount)}</span>
                          <div className="cell-sub">
                            {p.methodLabel} · {fmtDate(p.paidOn)}
                            {p.reference && <> · {p.reference}</>}
                          </div>
                          {p.note && <div className="cell-sub">{p.note}</div>}
                          {p.status === 'voided' && <div className="cell-sub"><Badge tone="bad" plain>Voided</Badge> {p.voidReason}</div>}
                        </td>
                        {isStaff && (
                          <td className="cell-actions">
                            {p.status === 'recorded' && <Button size="sm" variant="ghost" onClick={() => { setVoiding(p); setVoidReason(''); setVoidError(''); }}>Void</Button>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {isStaff && (
            <>
              <section className="card">
                <div className="card__head"><h2>History</h2></div>
                <div className="card__body">
                  <ol className="timeline">
                    {[...inv.events].reverse().map((e) => (
                      <li key={e.id}>
                        <div className="timeline__title">{EVENT_LABEL[e.action] ?? e.action}</div>
                        <div className="timeline__meta">{fmtDateTime(e.at)} · {e.actor ?? 'Billing'}</div>
                        {e.note && <div className="timeline__note">{e.note}</div>}
                      </li>
                    ))}
                  </ol>
                </div>
              </section>
              {inv.sentAt && (
                <section className="card">
                  <div className="card__body small">
                    Emailed {inv.sentCount} time{inv.sentCount === 1 ? '' : 's'}, most recently {fmtDateTime(inv.sentAt)}.
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>

      <RecordPaymentDialog invoice={paying ? { id: inv.id, number: inv.number, balance: inv.balance, issueDate: inv.issueDate } : null} onClose={() => setPaying(false)} onRecorded={q.reload} />

      <ConfirmDialog open={cancelling} title="Cancel this invoice?" confirmLabel="Cancel invoice" danger busy={busy === 'cancel'} onConfirm={() => run('cancel', reason.trim() || undefined)} onClose={() => busy === null && setCancelling(false)}>
        <p>{inv.number} will no longer count as money owed, and billing will not create another invoice for the same period. This cannot be undone.</p>
        <TextAreaField label="Reason (optional)" value={reason} onChange={setReason} rows={2} hint="Kept on the invoice." />
      </ConfirmDialog>

      <ConfirmDialog open={voiding !== null} title="Void this payment?" confirmLabel="Void payment" danger busy={voidBusy} onConfirm={voidIt} onClose={() => !voidBusy && setVoiding(null)}>
        {voiding && <p>The {money(voiding.amount)} received on {fmtDate(voiding.paidOn)} will stop counting towards {inv.number}, and the invoice will owe it again. The entry stays on record, marked as voided.</p>}
        <TextAreaField label="Why is it being voided?" value={voidReason} onChange={(v) => { setVoidReason(v); setVoidError(''); }} rows={2} error={voidError || undefined} />
      </ConfirmDialog>
    </>
  );
}
