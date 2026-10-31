import { ArrowLeft, Printer } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { usePageTitle, useQuery } from '../hooks';
import type { InvoiceDetail } from '../billingTypes';
import { EmptyState } from '../ui/Feedback';
import { InvoiceDocument } from '../ui/InvoiceDocument';
import { Spinner } from '../ui/Spinner';

/** A clean page for printing or saving as PDF from the browser; the buttons disappear when printing. */
export function InvoicePrintPage() {
  const { id } = useParams();
  const q = useQuery(() => api.get<{ invoice: InvoiceDetail }>(`/invoices/${id}`), [id]);
  const inv = q.data?.invoice;
  usePageTitle(inv ? `Invoice ${inv.number}` : 'Invoice');

  if (q.error) {
    return (
      <div style={{ padding: 32 }}>
        <EmptyState icon={<ArrowLeft size={22} />} title="Invoice not found" action={<Link className="btn btn--secondary" to="/invoices">Back to invoices</Link>}>
          {q.error.status === 404 ? 'It may not exist, or it is not one of yours.' : q.error.message}
        </EmptyState>
      </div>
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
    <div className="print-page">
      <div className="print-bar no-print">
        <Link to={`/invoices/${inv.id}`} className="back-link" style={{ margin: 0 }}><ArrowLeft size={16} /> Back to invoice</Link>
        <button className="btn btn--primary" onClick={() => window.print()}>
          <Printer size={16} /> Print or save as PDF
        </button>
      </div>
      <InvoiceDocument invoice={inv} />
      <p className="print-foot muted small">Questions about this invoice? Contact your Brightloop account manager and quote {inv.number}.</p>
    </div>
  );
}
