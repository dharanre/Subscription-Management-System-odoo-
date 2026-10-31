import { useAuth } from '../auth';
import { usePageTitle } from '../hooks';
import { Dashboard } from './Dashboard';
import { PortalHome } from './PortalHome';

/** The home screen: the finance dashboard for the team, the customer's own overview for customers. */
export function OverviewPage() {
  const { user } = useAuth();
  usePageTitle(user?.role === 'customer' ? 'Overview' : 'Dashboard');
  if (!user) return null;
  return user.role === 'customer' ? <PortalHome /> : <Dashboard />;
}
