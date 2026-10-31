import { Check } from 'lucide-react';
import { type Page, type Account, type Role, api, qs } from '../api';
import { useAuth } from '../auth';
import { capitalize } from '../format';
import { useQuery, usePageTitle } from '../hooks';
import { Alert, Badge } from '../ui/Feedback';
import { PageHeader } from '../ui/Layout';
import { Skeleton } from '../ui/Spinner';

const ACCESS: Record<Role, { summary: string; can: string[] }> = {
  admin: {
    summary: 'You control the whole system.',
    can: ['Add and deactivate staff accounts', 'Manage products, plans, taxes and discount rules', 'See every customer, subscription, invoice and payment'],
  },
  staff: {
    summary: 'You handle day-to-day customer work with limited access.',
    can: ['Work with customers, subscriptions and invoices', 'Record payments and chase overdue invoices', 'Not permitted: adding staff or creating discount rules'],
  },
  customer: {
    summary: 'You see only your own subscriptions and invoices.',
    can: ['View and manage your own subscriptions', 'See your own invoices and whether each one is paid', 'Your records are never visible to other customers'],
  },
};

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function useCount(role?: Role) {
  return useQuery(() => api.get<Page<Account>>(`/users${qs({ pageSize: 1, role })}`), [role]);
}

function AccountStats() {
  const all = useCount();
  const staff = useCount('staff');
  const customers = useCount('customer');
  const error = all.error ?? staff.error ?? customers.error;
  if (error) return <Alert>Could not load account totals: {error.message}</Alert>;

  const tiles = [
    { label: 'Accounts', q: all },
    { label: 'Staff', q: staff },
    { label: 'Customers', q: customers },
  ];
  return (
    <div className="stat-grid">
      {tiles.map(({ label, q }) => (
        <div key={label} className="card stat">
          <div className="stat__label">{label}</div>
          <div className="stat__value">{q.data ? q.data.total : <Skeleton width={48} />}</div>
        </div>
      ))}
    </div>
  );
}

export function OverviewPage() {
  usePageTitle('Overview');
  const { user } = useAuth();
  if (!user) return null;
  const access = ACCESS[user.role];

  return (
    <>
      <PageHeader title={`${greeting()}, ${user.name.split(' ')[0]}`} description={access.summary} />
      {user.role === 'admin' && <AccountStats />}
      <div className="grid-2">
        <section className="card">
          <div className="card__head">
            <h2>Your access</h2>
            <Badge tone={user.role === 'admin' ? 'info' : user.role === 'staff' ? 'ok' : 'mute'}>{capitalize(user.role)}</Badge>
          </div>
          <div className="card__body">
            <ul className="checklist">
              {access.can.map((line) => (
                <li key={line}>
                  <Check size={16} />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <section className="card">
          <div className="card__head">
            <h2>Your account</h2>
          </div>
          <div className="card__body">
            <dl className="kv">
              <dt>Name</dt>
              <dd>{user.name}</dd>
              <dt>Email</dt>
              <dd>{user.email}</dd>
              <dt>Role</dt>
              <dd>{capitalize(user.role)}</dd>
            </dl>
          </div>
        </section>
      </div>
    </>
  );
}
