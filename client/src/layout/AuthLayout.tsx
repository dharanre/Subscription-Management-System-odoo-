import { CalendarClock, FileText, LineChart, ReceiptText } from 'lucide-react';
import type { ReactNode } from 'react';
import { LogoMark } from '../ui/Layout';

const POINTS = [
  { icon: CalendarClock, text: 'Plans, variants and renewals set up once, billed on schedule.' },
  { icon: FileText, text: 'Invoices created from subscriptions, with tax and discounts filled in.' },
  { icon: ReceiptText, text: 'Every payment recorded against the invoice it settles.' },
  { icon: LineChart, text: 'Recurring revenue and overdue invoices in one live view.' },
];

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth__aside">
        <span className="brand" style={{ padding: 0 }}>
          <LogoMark size={34} />
          <span>
            Brightloop
            <small>Billing</small>
          </span>
        </span>
        <div>
          <h2>Run every subscription from one place.</h2>
          <p>From the first plan to the last overdue reminder, Brightloop keeps recurring revenue in view.</p>
        </div>
        <ul className="auth__points">
          {POINTS.map(({ icon: Icon, text }) => (
            <li key={text}>
              <Icon size={18} />
              {text}
            </li>
          ))}
        </ul>
      </aside>
      <div className="auth__panel">
        <div className="auth__card">
          <span className="brand auth__mobile-brand" style={{ padding: 0 }}>
            <LogoMark size={30} /> Brightloop Billing
          </span>
          {children}
        </div>
      </div>
    </div>
  );
}
