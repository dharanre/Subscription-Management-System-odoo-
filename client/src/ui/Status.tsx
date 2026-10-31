import type { CloseReason, SubStatus } from '../salesTypes';
import { Badge } from './Feedback';

export const STATUS_UI: Record<SubStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'mute' }> = {
  draft: { label: 'Draft', tone: 'mute' },
  quotation: { label: 'Quotation', tone: 'info' },
  confirmed: { label: 'Confirmed', tone: 'warn' },
  active: { label: 'Active', tone: 'ok' },
  paused: { label: 'Paused', tone: 'warn' },
  closed: { label: 'Closed', tone: 'mute' },
};

export const CLOSE_REASON: Record<CloseReason, string> = {
  cancelled: 'Cancelled',
  closed_early: 'Closed early',
  expired: 'Expired',
};

export function SubStatusBadge({ status, closeReason, quoteExpired }: { status: SubStatus; closeReason?: CloseReason | null; quoteExpired?: boolean }) {
  const ui = STATUS_UI[status];
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      <Badge tone={ui.tone}>{ui.label}</Badge>
      {status === 'closed' && closeReason && <Badge tone="mute" plain>{CLOSE_REASON[closeReason]}</Badge>}
      {quoteExpired && <Badge tone="bad" plain>Quote expired</Badge>}
    </span>
  );
}

const STEPS: { status: Exclude<SubStatus, 'paused'>; label: string }[] = [
  { status: 'draft', label: 'Draft' },
  { status: 'quotation', label: 'Quotation' },
  { status: 'confirmed', label: 'Confirmed' },
  { status: 'active', label: 'Active' },
  { status: 'closed', label: 'Closed' },
];

/** Draft -> Quotation -> Confirmed -> Active -> Closed, with Paused shown on the Active step. */
export function LifecycleStepper({ status, closeReason }: { status: SubStatus; closeReason?: CloseReason | null }) {
  const current = STEPS.findIndex((s) => s.status === (status === 'paused' ? 'active' : status));
  return (
    <ol className="stepper" aria-label="Lifecycle">
      {STEPS.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        const tone = s.status === 'closed' ? 'mute' : status === 'paused' && s.status === 'active' ? 'warn' : undefined;
        const note = s.status === 'active' && status === 'paused' ? 'Paused' : s.status === 'closed' && status === 'closed' && closeReason ? CLOSE_REASON[closeReason] : undefined;
        return (
          <li key={s.status} data-state={state} data-tone={tone} aria-current={state === 'current' ? 'step' : undefined}>
            <span>{s.label}</span>
            {note && <span className="step-note">{note}</span>}
          </li>
        );
      })}
    </ol>
  );
}
