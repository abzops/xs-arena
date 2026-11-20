import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Gift, LayoutGrid, Package, Search, UserPlus, UsersRound, Wallet } from 'lucide-react';
import { Link } from 'react-router';
import { useCentre } from '../../app/centre';
import { Loading, Notice, PushLink } from '../../components/ui';
import { formatDay } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR } from '../../lib/money';
import { rpc } from '../../lib/supabase';
import './dashboard.css';

type Summary = {
  today: string; revenue_today: number; collected_today: number; bills_today: number; methods_today: Record<string, number>;
  revenue_month: number; expenses_month: number; expenses_by_category: Record<string, number>;
  new_customers_month: number; customers_total: number; team_total: number; low_stock: number;
  birthdays_week: { id: string; name: string; phone: string; date: string }[];
};

function greeting(timeZone: string) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function Dashboard() {
  const { centre, can } = useCentre();
  const base = `/s/${centre.slug}`;
  const summary = useQuery({
    queryKey: ['dashboard', centre.id],
    queryFn: () => rpc<Summary>('dashboard_summary', { p_centre: centre.id }),
    refetchInterval: 60_000,
  });

  if (summary.isPending) return <Loading rows={6} />;
  if (summary.error) return <Notice tone="bad">{errorMessage(summary.error)}</Notice>;
  const s = summary.data;
  const day = formatDay(s.today, { weekday: 'long', day: 'numeric', month: 'long' });
  const m = s.methods_today ?? {};
  const cash = m.cash ?? 0, upi = m.upi ?? 0, other = (m.card ?? 0) + (m.bank ?? 0) + (m.other ?? 0);
  const total = cash + upi + other;
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : '0%');
  const net = s.revenue_month - s.expenses_month;

  return (
    <div className="dash">
      <header className="dash-head">
        <p>{day}</p>
        <h1>{greeting(centre.timezone)}</h1>
      </header>

      <nav className="quick" aria-label="Quick actions">
        {can('floor.operate') && <Link className="q primary" to={`${base}/floor`}><span className="q-ico"><LayoutGrid size={22} /></span><span>Floor</span></Link>}
        <Link className="q" to={`${base}/customers`}><span className="q-ico"><Search size={21} /></span><span>Find customer</span></Link>
        {can('expenses.manage') && <Link className="q" to={`${base}/expenses?new=1`}><span className="q-ico"><Wallet size={21} /></span><span>Add expense</span></Link>}
        <Link className="q" to={`${base}/snacks`}><span className="q-ico"><Package size={21} /></span><span>Snacks</span></Link>
      </nav>

      <div className="hero-card">
        <span className="hc-top"><span>Sales today · {s.bills_today} bill{s.bills_today === 1 ? '' : 's'}</span></span>
        <span className="hc-value num">{formatINR(s.revenue_today)}</span>
        <span className="paybar" aria-hidden>
          <i className="s-cash" style={{ width: pct(cash) }} />
          <i className="s-upi" style={{ width: pct(upi) }} />
          <i className="s-other" style={{ width: pct(other) }} />
        </span>
        <span className="legend">
          <span><i className="s-cash" />Cash <b className="num">{formatINR(cash)}</b></span>
          <span><i className="s-upi" />UPI <b className="num">{formatINR(upi)}</b></span>
          {other > 0 && <span><i className="s-other" />Card & other <b className="num">{formatINR(other)}</b></span>}
        </span>
      </div>

      <section className="stats" aria-label="At a glance">
        <PushLink className="stat" to={`${base}/customers`}>
          <span className="st-label"><UserPlus size={16} />New customers</span>
          <span className="st-value num">{s.new_customers_month}</span>
          <span className="st-sub">this month · {s.customers_total} total</span>
        </PushLink>
        <PushLink className="stat" to={`${base}/snacks?low=1`}>
          <span className="st-label"><Package size={16} className={s.low_stock > 0 ? 'tone-warn' : undefined} />Low stock</span>
          <span className="st-value num">{s.low_stock}</span>
          <span className="st-sub">snacks to reorder</span>
        </PushLink>
        <PushLink className="stat" to={`${base}/team`}>
          <span className="st-label"><UsersRound size={16} />Team</span>
          <span className="st-value num">{s.team_total}</span>
          <span className="st-sub">active logins</span>
        </PushLink>
        {can('expenses.manage') && (
          <PushLink className="stat" to={`${base}/expenses`}>
            <span className="st-label"><Wallet size={16} />Expenses</span>
            <span className="st-value num">{formatINR(s.expenses_month)}</span>
            <span className="st-sub">this month</span>
          </PushLink>
        )}
      </section>

      {can('reports.view') && (
        <section className="month">
          <h2>This month</h2>
          <ul className="ios-list">
            <li><span>Sales</span><b className="num">{formatINR(s.revenue_month)}</b></li>
            <li><span>Expenses</span><b className="num neg">{s.expenses_month > 0 ? "−" : ""}{formatINR(s.expenses_month)}</b></li>
            <li className="total"><span>Net profit</span><b className="num">{net < 0 ? '−' : ''}{formatINR(Math.abs(net))}</b></li>
            {can('expenses.manage') && <li><Link to={`${base}/expenses`}><span>Expenses by category</span><ChevronRight size={16} /></Link></li>}
          </ul>
        </section>
      )}

      {s.birthdays_week.length > 0 && (
        <section className="recent">
          <h2>Birthdays this week</h2>
          <ul className="ios-list people">
            {s.birthdays_week.map((b) => (
              <li key={b.id}>
                <PushLink to={`${base}/customers/${b.id}`}>
                  <span className="avatar" aria-hidden><Gift size={17} /></span>
                  <span className="who"><b>{b.name}</b><small>{b.phone}</small></span>
                  <span className="when num">{formatDay(`${s.today.slice(0, 4)}${b.date.slice(4)}`, { day: 'numeric', month: 'short' })}</span>
                </PushLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
