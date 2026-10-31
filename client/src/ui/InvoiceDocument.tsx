import { fmtDate } from '../format';
import { useMoney } from '../meta';
import type { InvoiceDetail } from '../billingTypes';
import { BreakdownTable } from './Breakdown';
import { InvoiceStatusBadge } from './InvoiceStatus';
import { LogoMark } from './Layout';

/** The invoice as a document: used on screen and, unchanged, for printing. */
export function InvoiceDocument({ invoice: inv }: { invoice: InvoiceDetail }) {
  const { money } = useMoney();
  const rows = inv.lines.map((l) => ({
    key: l.id,
    description: l.description,
    detail: `${l.quantity} × ${money(l.unitPrice)} · ${l.taxName ? `${l.taxName} ${l.taxRatePercent}%` : 'No tax'}`,
    subtotal: l.subtotal,
    discount: l.discount,
    tax: l.tax,
    total: l.total,
  }));

  return (
    <article className="doc">
      <header className="doc__head">
        <span className="brand" style={{ padding: 0, color: 'var(--ink-900)' }}>
          <LogoMark size={34} />
          <span>
            Brightloop
            <small style={{ color: 'var(--ink-500)' }}>Software</small>
          </span>
        </span>
        <div className="doc__title">
          <div className="doc__kicker">Invoice</div>
          <h2>{inv.number}</h2>
          <InvoiceStatusBadge status={inv.status} overdue={inv.isOverdue} daysOverdue={inv.daysOverdue} />
        </div>
      </header>

      <div className="doc__meta">
        <div>
          <div className="doc__label">Billed to</div>
          <strong>{inv.customerDetails.company || inv.customerDetails.name}</strong>
          {inv.customerDetails.company && <div>{inv.customerDetails.name}</div>}
          <div className="muted">{inv.customerDetails.email}</div>
          {inv.customerDetails.address && <div className="muted" style={{ whiteSpace: 'pre-line' }}>{inv.customerDetails.address}</div>}
        </div>
        <dl className="kv">
          <dt>Issued</dt>
          <dd>{fmtDate(inv.issueDate)}</dd>
          <dt>Due</dt>
          <dd>{fmtDate(inv.dueDate)}{inv.paymentTerms && <span className="muted"> · {inv.paymentTerms}</span>}</dd>
          <dt>Covers</dt>
          <dd>{fmtDate(inv.periodStart)} to {fmtDate(inv.periodEnd)}</dd>
          <dt>Subscription</dt>
          <dd>{inv.subscription.number} · {inv.planName}</dd>
        </dl>
      </div>

      <BreakdownTable rows={rows} totals={inv.totals} totalLabel="Invoice total" />

      <div className="totals" style={{ marginLeft: 'auto', maxWidth: 360 }}>
        {inv.discount && (
          <div className="muted small">
            <span>Discount applied: {inv.discount.name}</span>
            <span className="num">−{money(inv.discount.amount)}</span>
          </div>
        )}
        <div>
          <span>Paid</span>
          <span className="num">{money(inv.totals.paid)}</span>
        </div>
        <div className="grand">
          <span>{inv.status === 'cancelled' ? 'Cancelled' : inv.totals.balance > 0 ? 'Balance due' : 'Nothing due'}</span>
          <span className="num">{inv.status === 'cancelled' ? '—' : money(inv.totals.balance)}</span>
        </div>
      </div>
    </article>
  );
}
