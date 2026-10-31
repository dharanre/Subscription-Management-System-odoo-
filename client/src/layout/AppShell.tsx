import { Calculator, CalendarCheck, CalendarClock, FileStack, Hourglass, Receipt, Wallet, LayoutDashboard, LogOut, Mail, Menu, Package, Percent, Repeat, Tag, UserRound, Users, X } from 'lucide-react';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '../api';
import { useAuth } from '../auth';
import { MetaProvider } from '../meta';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Feedback';
import { LogoMark } from '../ui/Layout';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  roles: Role[];
  end?: boolean;
  devOnly?: boolean;
  /** Wording for a role that should see a different label for the same page. */
  labelFor?: Partial<Record<Role, string>>;
}
interface NavGroup {
  label?: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  { items: [{ to: '/', label: 'Overview', icon: LayoutDashboard, roles: ['admin', 'staff', 'customer'], end: true, labelFor: { admin: 'Dashboard', staff: 'Dashboard' } }] },
  {
    label: 'Sales',
    items: [
      { to: '/subscriptions', label: 'Subscriptions', icon: Repeat, roles: ['admin', 'staff', 'customer'], labelFor: { customer: 'My subscriptions' } },
      { to: '/customers', label: 'Customers', icon: UserRound, roles: ['admin', 'staff'] },
      { to: '/templates', label: 'Quotation templates', icon: FileStack, roles: ['admin', 'staff'] },
    ],
  },
  {
    label: 'Billing',
    items: [
      { to: '/billing', label: 'Billing', icon: CalendarCheck, roles: ['admin', 'staff'] },
      { to: '/invoices', label: 'Invoices', icon: Receipt, roles: ['admin', 'staff', 'customer'], labelFor: { customer: 'My invoices' } },
      { to: '/payments', label: 'Payments', icon: Wallet, roles: ['admin', 'staff'] },
      { to: '/receivables', label: 'Receivables', icon: Hourglass, roles: ['admin', 'staff'] },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { to: '/products', label: 'Products', icon: Package, roles: ['admin', 'staff'] },
      { to: '/plans', label: 'Plans', icon: CalendarClock, roles: ['admin', 'staff'] },
    ],
  },
  {
    label: 'Pricing',
    items: [
      { to: '/taxes', label: 'Taxes', icon: Percent, roles: ['admin', 'staff'] },
      { to: '/discounts', label: 'Discounts', icon: Tag, roles: ['admin', 'staff'] },
      { to: '/calculator', label: 'Price calculator', icon: Calculator, roles: ['admin', 'staff'] },
    ],
  },
  { label: 'Administration', items: [{ to: '/team', label: 'Team', icon: Users, roles: ['admin'] }] },
  { label: 'Developer', items: [{ to: '/dev/mailbox', label: 'Dev mailbox', icon: Mail, roles: ['admin'], devOnly: true }] },
];

export function AppShell() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [navOpen, setNavOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);

  // On a short window the menu scrolls, so keep the page you are on in view (only the menu moves, never the page).
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const menu = navRef.current;
    const current = menu?.querySelector<HTMLElement>('a.active');
    if (!menu || !current) return;
    const m = menu.getBoundingClientRect();
    const c = current.getBoundingClientRect();
    if (c.top < m.top) menu.scrollTop -= m.top - c.top;
    else if (c.bottom > m.bottom) menu.scrollTop += c.bottom - m.bottom;
  }, [location.pathname, user?.role]);

  if (!user) return null;

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.roles.includes(user.role) && (!i.devOnly || import.meta.env.DEV)),
  })).filter((g) => g.items.length);

  async function signOut() {
    setSigningOut(true);
    try {
      await logout();
    } catch {
      toast.error('Could not sign out cleanly. Your session has been cleared on this device.');
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="shell" data-nav-open={navOpen}>
      <header className="topbar">
        <Button variant="ghost" size="sm" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen(true)} icon={<Menu size={20} />} />
        <span className="brand">
          <LogoMark size={26} /> Brightloop
        </span>
      </header>

      <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <aside className="sidebar" aria-label="Main navigation">
        <div className="row-between">
          <span className="brand">
            <LogoMark />
            <span>
              Brightloop
              <small>Billing</small>
            </span>
          </span>
          {navOpen && <Button variant="ghost" size="sm" aria-label="Close navigation" onClick={() => setNavOpen(false)} icon={<X size={18} />} />}
        </div>
        <nav className="nav" ref={navRef}>
          {groups.map((g, i) => (
            <div key={g.label ?? i} style={{ display: 'contents' }}>
              {g.label && <div className="nav__label">{g.label}</div>}
              {g.items.map(({ to, label: defaultLabel, labelFor, icon: Icon, end }) => (
                <NavLink key={to} to={to} end={end}>
                  <Icon size={19} />
                  {labelFor?.[user.role] ?? defaultLabel}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="user-chip">
          <span className="avatar" aria-hidden="true">
            {user.name.charAt(0).toUpperCase()}
          </span>
          <div className="user-chip__meta">
            <div className="user-chip__name">{user.name}</div>
            <div className="user-chip__role">{user.role}</div>
          </div>
          <Button variant="ghost" size="sm" aria-label="Sign out" title="Sign out" onClick={signOut} loading={signingOut} icon={<LogOut size={18} />} />
        </div>
      </aside>

      <main className="main">
        <div className="content">
          <MetaProvider>
            <Outlet />
          </MetaProvider>
        </div>
      </main>
    </div>
  );
}
