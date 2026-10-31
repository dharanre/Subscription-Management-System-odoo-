import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { useMoney } from '../meta';
import { isDate, numToInput, parseMoney } from '../parse';
import { PAYMENT_METHODS, type PaymentMethod } from '../billingTypes';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Alert, useToast } from './Feedback';
import { AffixField, SelectField, TextField } from './Field';

export interface PayableInvoice {
  id: number;
  number: string;
  balance: number;
  issueDate: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Works even where crypto.randomUUID is unavailable (plain http on a non-localhost host). */
const newRequestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/**
 * Records money received against an invoice. Each time the dialog opens it gets a fresh request id, so a double
 * click or a retry after a dropped connection can never record the same payment twice.
 */
export function RecordPaymentDialog({ invoice, onClose, onRecorded }: { invoice: PayableInvoice | null; onClose(): void; onRecorded(): void }) {
  const toast = useToast();
  const { money, symbol } = useMoney();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [paidOn, setPaidOn] = useState(today());
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [requestId, setRequestId] = useState(newRequestId());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!invoice) return;
    setAmount(numToInput(invoice.balance));
    setMethod('bank_transfer');
    setPaidOn(today());
    setReference('');
    setNote('');
    setRequestId(newRequestId());
    setErrors({});
    setFormError('');
  }, [invoice?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = parseMoney(amount, 'Amount');
  const remaining = invoice && parsed.ok ? Math.round((invoice.balance - parsed.value) * 100) / 100 : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    const next: Record<string, string> = {};
    if (!parsed.ok) next.amount = parsed.error;
    else if (parsed.value <= 0) next.amount = 'Amount must be greater than zero';
    else if (parsed.value > invoice.balance) next.amount = `Cannot be more than the ${money(invoice.balance)} still owing`;
    if (!isDate(paidOn)) next.paidOn = 'Choose a valid date';
    else if (paidOn > today()) next.paidOn = 'Cannot be in the future';
    else if (paidOn < invoice.issueDate) next.paidOn = 'Cannot be before the invoice was issued';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length || !parsed.ok) return;

    setBusy(true);
    try {
      await api.post(`/invoices/${invoice.id}/payments`, { amount: parsed.value, method, paidOn, reference: reference.trim() || null, note: note.trim() || null, requestId });
      toast.success(`${money(parsed.value)} recorded against ${invoice.number}.`);
      onRecorded();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setFormError(err instanceof Error ? err.message : 'Could not record the payment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={invoice !== null}
      title={invoice ? `Record payment for ${invoice.number}` : 'Record payment'}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="payment-form" loading={busy}>Record payment</Button>
        </>
      }
    >
      <form id="payment-form" className="dialog__body" onSubmit={submit} noValidate>
        <Alert tone="info">This records money you have already received. It does not charge a card or move any money.</Alert>
        {formError && <Alert>{formError}</Alert>}
        {invoice && (
          <div className="form-grid">
            <div className="span-2">
              <AffixField
                label={`Amount received (${money(invoice.balance)} owing)`}
                prefix={symbol}
                value={amount}
                onChange={(v) => { setAmount(v); setErrors((e) => ({ ...e, amount: '' })); }}
                error={errors.amount || undefined}
                hint={remaining === null ? undefined : remaining === 0 ? 'This clears the invoice.' : remaining > 0 ? `${money(remaining)} will still be owing after this.` : undefined}
                autoFocus
              />
              <button type="button" className="link-btn small" style={{ marginTop: 6 }} onClick={() => setAmount(numToInput(invoice.balance))}>
                Pay in full ({money(invoice.balance)})
              </button>
            </div>
            <SelectField label="Method" value={method} onChange={(v) => setMethod(v as PaymentMethod)} error={errors.method}>
              {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </SelectField>
            <TextField label="Date received" type="date" value={paidOn} min={invoice.issueDate} max={today()} onChange={(v) => { setPaidOn(v); setErrors((e) => ({ ...e, paidOn: '' })); }} error={errors.paidOn || undefined} />
            <div className="span-2"><TextField label="Reference (optional)" value={reference} onChange={setReference} error={errors.reference} hint="A bank reference, cheque number or UPI id helps match it to a statement." /></div>
            <div className="span-2"><TextField label="Note (optional)" value={note} onChange={setNote} error={errors.note} /></div>
          </div>
        )}
      </form>
    </Dialog>
  );
}
