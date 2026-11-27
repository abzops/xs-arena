import {
  Banknote, Boxes, ChevronDown, CircleHelp, Home, IndianRupee, LayoutGrid, LogOut, Menu, Package, PencilRuler, Receipt, Settings, SlidersHorizontal, Sparkles, Users,
  UsersRound, CalendarCheck, Car, ClipboardList, Megaphone, Wallet, Wrench, Grip,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { AiOrb } from '../features/ai/Orb';
import { AppearanceButton, AppearanceControl } from '../components/Appearance';
import { Guide } from '../components/Guide';
import { Logo, Notice, Sheet } from '../components/ui';
import { daysBetween, todayInCentre } from '../lib/dates';
import { setTransition } from '../lib/motion';
import { supabase } from '../lib/supabase';
import { ROLE_LABEL } from '../lib/types';
import { useCentre } from './centre';
import { Avatar } from '../features/settings/CentreProfile';
import { mediaUrl } from '../lib/media';

type NavGroup = 'daily' | 'more' | 'setup';
type NavItem = { to: string; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }>; perm?: string; feature?: string; group: NavGroup };

// Pilot feedback (25 Nov): a long menu looked hard to learn. The everyday six stay on top; the rest is folded away.
const NAV: NavItem[] = [
  { to: '', label: 'Home', icon: Home, group: 'daily' },
  { to: 'floor', label: 'Floor', icon: LayoutGrid, perm: 'floor.operate', group: 'daily' },
  { to: 'ai', label: 'XS AI', icon: Sparkles, perm: 'floor.operate', feature: 'xs_ai', group: 'daily' },
  { to: 'bookings', label: 'Bookings', icon: CalendarCheck, perm: 'floor.operate', group: 'daily' },
  { to: 'bills', label: 'Bills', icon: Receipt, perm: 'billing.create', group: 'daily' },
  { to: 'customers', label: 'Customers', icon: Users, group: 'daily' },
  { to: 'shift', label: 'Shift & cash', icon: Banknote, perm: 'floor.operate', group: 'more' },
  { to: 'repairs', label: 'Repairs', icon: Wrench, perm: 'floor.operate', group: 'more' },
  { to: 'assets', label: 'Assets', icon: Boxes, group: 'more' },
  { to: 'snacks', label: 'Snacks', icon: Package, feature: 'snacks', group: 'more' },
  { to: 'rc', label: 'RC fleet', icon: Car, perm: 'floor.operate', feature: 'rc_fleet', group: 'more' },
  { to: 'offers', label: 'Send offer', icon: Megaphone, perm: 'customers.manage', group: 'more' },
  { to: 'expenses', label: 'Expenses', icon: Wallet, perm: 'expenses.manage', group: 'more' },
  { to: 'day', label: 'Day summary', icon: ClipboardList, perm: 'reports.view', group: 'more' },
  { to: 'prices', label: 'Prices', icon: IndianRupee, perm: 'pricing.manage', group: 'setup' },
  { to: 'designer', label: 'Floor designer', icon: PencilRuler, perm: 'floor.design', group: 'setup' },
  { to: 'team', label: 'Team', icon: UsersRound, perm: 'staff.manage', group: 'setup' },
  { to: 'settings', label: 'Settings', icon: Settings, group: 'setup' },
];
const GROUP_LABEL: Record<Exclude<NavGroup, 'daily'>, string> = { more: 'More tools', setup: 'Setup' };
const GROUP_ICON = { more: Grip, setup: SlidersHorizontal };
const OPEN_KEY = 'xs-nav-open';

// Transparent badge: black on light backgrounds, white on dark (brand rule).
const mark = `${import.meta.env.BASE_URL}brand/badge-black.svg`;
const markOnDark = `${import.meta.env.BASE_URL}brand/badge-white.svg`;

export function Shell() {
  const { centre, role, can, canWrite, subscription, hasFeature, me } = useCentre();
  const [more, setMore] = useState(false);
  const location = useLocation();
  const items = NAV.filter((n) => (!n.perm || can(n.perm)) && (!n.feature || hasFeature(n.feature)));
  const primary = items.slice(0, 4);
  const overflow = items.slice(4);
  const base = `/s/${centre.slug}`;
  const link = (n: NavItem) => (n.to ? `${base}/${n.to}` : base);
  const onOverflowRoute = overflow.some((n) => location.pathname.startsWith(link(n)));
  // Folded groups open when you're on one of their pages, or when you opened them before.
  const [openGroups, setOpenGroups] = useState<NavGroup[]>(() => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]'); } catch { return []; } });
  const toggleGroup = (g: NavGroup) => setOpenGroups((cur) => {
    const next = cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g];
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  const groupActive = (g: NavGroup) => items.some((n) => n.group === g && n.to && location.pathname.startsWith(link(n)));
  const startGuide = () => window.dispatchEvent(new CustomEvent('xs-guide'));
  const trialDays = subscription?.status === 'trialing'
    ? Math.max(0, daysBetween(todayInCentre(centre.timezone), subscription.trial_ends_at.slice(0, 10)))
    : null;
  const tab = () => setTransition('tab');
  const navigate = useNavigate();
  // New centre: the owner goes through "Set up your arena" first (once per visit; they can leave and come back)
  const settingUp = !centre.onboarded_at && can('settings.manage');
  const onSetup = location.pathname === `${base}/welcome`;
  useEffect(() => {
    if (!settingUp || onSetup) return;
    const k = `xs-setup-shown-${centre.id}`;
    try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch { /* private mode */ }
    navigate(`${base}/welcome`, { replace: true });
  }, [settingUp, onSetup, centre.id, base, navigate]);
  const aiOn = hasFeature('xs_ai') && can('floor.operate');
  const onAi = location.pathname === `${base}/ai`;
  // Ctrl/⌘ + K opens XS AI from anywhere
  useEffect(() => {
    if (!aiOn) return;
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); navigate(`${base}/ai`); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [aiOn, base, navigate]);

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
        {items.filter((n) => n.group === 'daily').map((n) => (
          <NavLink key={n.label} to={link(n)} end={!n.to} onClick={tab} title={n.label} className={n.to === 'ai' ? 'nav-ai' : undefined} data-guide={`nav-${n.to || 'home'}`}>
            <n.icon size={20} strokeWidth={1.9} /> <span className="nav-label">{n.label}</span>
          </NavLink>
        ))}
        {(['more', 'setup'] as const).map((g) => {
          const list = items.filter((n) => n.group === g);
          if (!list.length) return null;
          const open = openGroups.includes(g) || groupActive(g);
          const Icon = GROUP_ICON[g];
          return (
            <div key={g} className={`nav-group${open ? ' open' : ''}`}>
              <button className="nav-group-head" onClick={() => toggleGroup(g)} aria-expanded={open} title={GROUP_LABEL[g]} data-guide={`group-${g}`}>
                <Icon size={18} strokeWidth={1.9} /> <span className="nav-label">{GROUP_LABEL[g]}</span>
                <ChevronDown size={16} className="nav-chev" aria-hidden />
              </button>
              {open && list.map((n) => (
                <NavLink key={n.label} to={link(n)} onClick={tab} title={n.label} data-guide={`nav-${n.to}`}>
                  <n.icon size={20} strokeWidth={1.9} /> <span className="nav-label">{n.label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
        <div className="grow" />
        <Link className="side-me" to={`/s/${centre.slug}/settings#my-profile`} onClick={tab} title="My profile" data-testid="side-me">
          <Avatar name={me.display_name} path={me.avatar_path} color={me.color} size={30} />
          <span className="grow nav-label">{me.display_name}</span>
        </Link>
        <button className="signout" onClick={startGuide} title="How to use XS Arena" data-guide="guide">
          <CircleHelp size={20} strokeWidth={1.9} /> <span className="nav-label">How to use</span>
        </button>
        <AppearanceButton className="signout" />
        <button className="signout" onClick={() => supabase.auth.signOut()} title="Sign out">
          <LogOut size={20} strokeWidth={1.9} /> <span className="nav-label">Sign out</span>
        </button>
      </nav>

      <div className="content">
        <header className="topbar">
          <img className="brand-mark only-light" src={mark} alt="" width={26} height={26} />
          <img className="brand-mark only-dark" src={markOnDark} alt="" width={26} height={26} />
          {centre.logo_path && <img className="topbar-logo" src={mediaUrl(centre.logo_path) ?? ''} alt="" width={26} height={26} />}
          <span className="gym">{centre.name}</span>
        </header>
        <main className="main">
          {!canWrite && (
            <div style={{ marginBottom: 20 }}>
              <Notice tone="warn">This centre is suspended. You can view and export, but changes are paused.</Notice>
            </div>
          )}
          {settingUp && !onSetup && (
            <div className="setup-banner" data-testid="setup-banner">
              <span>Your arena isn't fully set up yet.</span>
              <Link className="btn small primary" to={`${base}/welcome`}>Continue setup</Link>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      {aiOn && !onAi && (
        <Link className="xsai-fab" to={`${base}/ai`} title="Ask XS AI (Ctrl+K)">
          <AiOrb size={36} /> <span>Ask XS AI</span> <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
        </Link>
      )}

      {/* Phone: iOS-style tab bar */}
      <nav className="tabbar" aria-label="Main" ref={tabbar}>
        <span className="tab-indicator" ref={indicator} aria-hidden />
        {primary.map((n) => (
          <NavLink key={n.label} to={link(n)} end={!n.to} onClick={tab} className={n.to === 'ai' ? 'nav-ai' : undefined} data-guide={`nav-${n.to || 'home'}`}>
            <n.icon size={23} strokeWidth={1.8} /> <span>{n.label}</span>
          </NavLink>
        ))}
        <button onClick={() => setMore(true)} className={onOverflowRoute || more ? 'active' : ''} aria-haspopup="dialog" data-guide="group-more">
          <Menu size={23} strokeWidth={1.8} /> <span>More</span>
        </button>
      </nav>

      <Guide />
      {more && (
        <Sheet title="More" onClose={() => setMore(false)}>
          <div className="appearance-row">
            <span>Appearance</span>
            <AppearanceControl />
          </div>
          {(['daily', 'more', 'setup'] as const).map((g) => {
            const list = overflow.filter((n) => n.group === g);
            if (!list.length) return null;
            return (
              <div key={g} className="stack" style={{ gap: 6 }}>
                {g !== 'daily' && <span className="more-group-label">{GROUP_LABEL[g]}</span>}
                <ul className="list grouped">
                  {list.map((n) => (
                    <li key={n.label}>
                      <NavLink className="item" to={link(n)} onClick={() => { tab(); setMore(false); }}>
                        <n.icon size={20} /> <span className="main-col"><span className="title">{n.label}</span></span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <ul className="list grouped">
            <li>
              <button className="item" onClick={() => { setMore(false); startGuide(); }}>
                <CircleHelp size={20} /> <span className="main-col"><span className="title">How to use XS Arena</span></span>
              </button>
            </li>
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
