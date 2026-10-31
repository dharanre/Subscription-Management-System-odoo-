import { LayoutDashboard, LogOut, Mail, Menu, Users, X } from 'lucide-react';
import { type ComponentType, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '../api';
import { useAuth } from '../auth';
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
}
interface NavGroup {
  label?: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  { items: [{ to: '/', label: 'Overview', icon: LayoutDashboard, roles: ['admin', 'staff', 'customer'], end: true }] },
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
        <nav className="nav">
          {groups.map((g, i) => (
            <div key={g.label ?? i} style={{ display: 'contents' }}>
              {g.label && <div className="nav__label">{g.label}</div>}
              {g.items.map(({ to, label, icon: Icon, end }) => (
                <NavLink key={to} to={to} end={end}>
                  <Icon size={19} />
                  {label}
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
          <Outlet />
        </div>
      </main>
    </div>
  );
}
