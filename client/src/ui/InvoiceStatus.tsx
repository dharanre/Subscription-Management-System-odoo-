import type { InvoiceStatus } from '../billingTypes';
import { Badge } from './Feedback';

const UI: Record<InvoiceStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'mute' }> = {
  draft: { label: 'Draft', tone: 'mute' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  paid: { label: 'Paid', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'mute' },
};

export const invoiceStatusLabel = (s: InvoiceStatus) => UI[s].label;

/** Overdue is not a status of its own: it is a confirmed invoice that is past its due date, so it is shown beside it. */
export function InvoiceStatusBadge({ status, overdue, daysOverdue }: { status: InvoiceStatus; overdue?: boolean; daysOverdue?: number }) {
  const ui = UI[status];
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      <Badge tone={ui.tone}>{ui.label}</Badge>
      {overdue && (
        <Badge tone="bad" plain>
          Overdue{daysOverdue ? ` · ${daysOverdue} day${daysOverdue === 1 ? '' : 's'}` : ''}
        </Badge>
      )}
    </span>
  );
}
