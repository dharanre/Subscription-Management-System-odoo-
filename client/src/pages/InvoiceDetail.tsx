import { ArrowLeft, Printer } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type ApiError, api } from '../api';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime } from '../format';
import { usePageTitle, useQuery } from '../hooks';
import type { InvoiceAction, InvoiceDetail } from '../billingTypes';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/Dialog';
import { Alert, EmptyState, useToast } from '../ui/Feedback';
import { TextAreaField } from '../ui/Field';
import { InvoiceDocument } from '../ui/InvoiceDocument';
import { Spinner } from '../ui/Spinner';

const DONE: Record<InvoiceAction, string> = { confirm: 'Invoice confirmed.', send: 'Invoice emailed to the customer.', cancel: 'Invoice cancelled.' };
const EVENT_LABEL: Record<string, string> = { create: 'Created by billing', confirm: 'Confirmed', send: 'Emailed', cancel: 'Cancelled', paid: 'Marked paid' };

export function InvoiceDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const isStaff = user?.role !== 'customer';
  const q = useQuery(() => api.get<{ invoice: InvoiceDetail }>(`/invoices/${id}`), [id], { pollMs: 15000 });
  const inv = q.data?.invoice;
  usePageTitle(inv?.number ?? 'Invoice');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<InvoiceAction | null>(null);

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
          {inv.actions.map((a) => (
            <Button key={a.action} variant={a.action === 'confirm' ? 'primary' : 'secondary'} loading={busy === a.action} disabled={busy !== null} onClick={() => (a.action === 'cancel' ? setCancelling(true) : void run(a.action))}>
              {a.label}
            </Button>
          ))}
          <Link className="btn btn--secondary" to={`/invoices/${inv.id}/print`} target="_blank" rel="noreferrer"><Printer size={16} /> Print</Link>
        </div>
      </header>

      {inv.status === 'draft' && isStaff && <div style={{ marginBottom: 16 }}><Alert tone="info">This invoice is a draft made by billing. Confirm it when it looks right; the customer cannot see it until then.</Alert></div>}
      {inv.isOverdue && <div style={{ marginBottom: 16 }}><Alert tone="error">This invoice was due on {fmtDate(inv.dueDate)} and is {inv.daysOverdue} day{inv.daysOverdue === 1 ? '' : 's'} overdue.</Alert></div>}
      {inv.status === 'cancelled' && <div style={{ marginBottom: 16 }}><Alert tone="info">Cancelled on {fmtDate(inv.cancelledAt!)}{inv.cancelReason ? `: ${inv.cancelReason}` : ''}. This billing period will not be invoiced again.</Alert></div>}

      <div className="detail-grid">
        <section className="card">
          <div className="card__body"><InvoiceDocument invoice={inv} /></div>
        </section>
        {isStaff && (
          <div className="stack">
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
          </div>
        )}
      </div>

      <ConfirmDialog open={cancelling} title="Cancel this invoice?" confirmLabel="Cancel invoice" danger busy={busy === 'cancel'} onConfirm={() => run('cancel', reason.trim() || undefined)} onClose={() => busy === null && setCancelling(false)}>
        <p>{inv.number} will no longer count as money owed, and billing will not create another invoice for the same period. This cannot be undone.</p>
        <TextAreaField label="Reason (optional)" value={reason} onChange={setReason} rows={2} hint="Kept on the invoice." />
      </ConfirmDialog>
    </>
  );
}
