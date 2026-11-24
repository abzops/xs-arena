import {
  Banknote, Home, IndianRupee, LayoutGrid, LogOut, Menu, Package, PencilRuler, Receipt, Settings, Sparkles, Users, UsersRound, CalendarCheck, Car, ClipboardList, Megaphone, Wallet,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { AppearanceButton, AppearanceControl } from '../components/Appearance';
import { Logo, Notice, Sheet } from '../components/ui';
import { daysBetween, todayInCentre } from '../lib/dates';
import { setTransition } from '../lib/motion';
import { supabase } from '../lib/supabase';
import { ROLE_LABEL } from '../lib/types';
import { useCentre } from './centre';

type NavItem = { to: string; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }>; perm?: string; feature?: string };

const NAV: NavItem[] = [
  { to: '', label: 'Home', icon: Home },
  { to: 'floor', label: 'Floor', icon: LayoutGrid, perm: 'floor.operate' },
  { to: 'ai', label: 'XS AI', icon: Sparkles, perm: 'floor.operate', feature: 'xs_ai' },
  { to: 'bookings', label: 'Bookings', icon: CalendarCheck, perm: 'floor.operate' },
  { to: 'bills', label: 'Bills', icon: Receipt, perm: 'billing.create' },
  { to: 'customers', label: 'Customers', icon: Users },
  { to: 'offers', label: 'Send offer', icon: Megaphone, perm: 'customers.manage' },
  { to: 'shift', label: 'Shift & cash', icon: Banknote, perm: 'floor.operate' },
  { to: 'snacks', label: 'Snacks', icon: Package },
  { to: 'rc', label: 'RC fleet', icon: Car, perm: 'floor.operate', feature: 'rc_fleet' },
  { to: 'expenses', label: 'Expenses', icon: Wallet, perm: 'expenses.manage' },
  { to: 'day', label: 'Day summary', icon: ClipboardList, perm: 'reports.view' },
  { to: 'prices', label: 'Prices', icon: IndianRupee, perm: 'pricing.manage' },
  { to: 'designer', label: 'Floor designer', icon: PencilRuler, perm: 'floor.design' },
  { to: 'team', label: 'Team', icon: UsersRound },
  { to: 'settings', label: 'Settings', icon: Settings },
];

// Transparent badge: black on light backgrounds, white on dark (brand rule).
const mark = `${import.meta.env.BASE_URL}brand/badge-black.svg`;
const markOnDark = `${import.meta.env.BASE_URL}brand/badge-white.svg`;

export function Shell() {
  const { centre, role, can, canWrite, subscription, hasFeature } = useCentre();
  const [more, setMore] = useState(false);
  const location = useLocation();
  const items = NAV.filter((n) => (!n.perm || can(n.perm)) && (!n.feature || hasFeature(n.feature)));
  const primary = items.slice(0, 4);
  const overflow = items.slice(4);
  const base = `/s/${centre.slug}`;
  const link = (n: NavItem) => (n.to ? `${base}/${n.to}` : base);
  const onOverflowRoute = overflow.some((n) => location.pathname.startsWith(link(n)));
  const trialDays = subscription?.status === 'trialing'
    ? Math.max(0, daysBetween(todayInCentre(centre.timezone), subscription.trial_ends_at.slice(0, 10)))
    : null;
  const tab = () => setTransition('tab');

  // Liquid Glass tab bar: an indicator glides to the active tab.
  const tabbar = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const active = tabbar.current?.querySelector<HTMLElement>('a.active, button.active');
      const ind = indicator.current;
      if (!ind) return;
      if (!active) { ind.style.opacity = '0'; return; }
      ind.style.opacity = '1';
      ind.style.width = `${active.offsetWidth}px`;
      ind.style.transform = `translateX(${active.offsetLeft}px)`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [location.pathname, more]);

  return (
    <div className="shell">
      {/* Laptop and tablet landscape: full sidebar. Tablet portrait: icon rail. */}
      <nav className="sidebar" aria-label="Main">
        <Logo onDark width={148} className="logo full" />
        <img className="rail-mark" src={markOnDark} alt="Xelorsoft" width={36} height={36} />
        <div className="gym-block">
          <strong>{centre.name}</strong>
          <span>XS Arena · {ROLE_LABEL[role]}</span>
          {trialDays !== null && <span>Trial ends in {trialDays} day{trialDays === 1 ? '' : 's'}</span>}
        </div>
        {items.map((n) => (
          <NavLink key={n.label} to={link(n)} end={!n.to} onClick={tab} title={n.label}>
            <n.icon size={20} strokeWidth={1.9} /> <span className="nav-label">{n.label}</span>
          </NavLink>
        ))}
        <div className="grow" />
        <AppearanceButton className="signout" />
        <button className="signout" onClick={() => supabase.auth.signOut()} title="Sign out">
          <LogOut size={20} strokeWidth={1.9} /> <span className="nav-label">Sign out</span>
        </button>
      </nav>

      <div className="content">
        <header className="topbar">
          <img className="brand-mark only-light" src={mark} alt="" width={26} height={26} />
          <img className="brand-mark only-dark" src={markOnDark} alt="" width={26} height={26} />
          <span className="gym">{centre.name}</span>
        </header>
        <main className="main">
          {!canWrite && (
            <div style={{ marginBottom: 20 }}>
              <Notice tone="warn">This centre is suspended. You can view and export, but changes are paused.</Notice>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      {/* Phone: iOS-style tab bar */}
      <nav className="tabbar" aria-label="Main" ref={tabbar}>
        <span className="tab-indicator" ref={indicator} aria-hidden />
        {primary.map((n) => (
          <NavLink key={n.label} to={link(n)} end={!n.to} onClick={tab}>
            <n.icon size={23} strokeWidth={1.8} /> <span>{n.label}</span>
          </NavLink>
        ))}
        <button onClick={() => setMore(true)} className={onOverflowRoute || more ? 'active' : ''} aria-haspopup="dialog">
          <Menu size={23} strokeWidth={1.8} /> <span>More</span>
        </button>
      </nav>

      {more && (
        <Sheet title="More" onClose={() => setMore(false)}>
          <div className="appearance-row">
            <span>Appearance</span>
            <AppearanceControl />
          </div>
          <ul className="list grouped">
            {overflow.map((n) => (
              <li key={n.label}>
                <NavLink className="item" to={link(n)} onClick={() => { tab(); setMore(false); }}>
                  <n.icon size={20} /> <span className="main-col"><span className="title">{n.label}</span></span>
                </NavLink>
              </li>
            ))}
            <li>
              <button className="item" onClick={() => supabase.auth.signOut()}>
                <LogOut size={20} /> <span className="main-col"><span className="title">Sign out</span></span>
              </button>
            </li>
          </ul>
        </Sheet>
      )}
    </div>
  );
}
