// End-of-day summary for the owner: money, games, payment split, and leakage alerts. Share on WhatsApp in one tap.
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useCentre } from '../../app/centre';
import { Empty, Loading, Notice } from '../../components/ui';
import { addDays, formatDay, todayInCentre } from '../../lib/dates';
import { METHOD, type DaySummary } from './text';
import { ImageSendButton } from '../../components/ImageSend';
import { summaryCard } from '../../lib/cards';
import { errorMessage } from '../../lib/errors';
import { formatINR } from '../../lib/money';
import { rpc } from '../../lib/supabase';




export function useDaySummary(date: string) {
  const { centre } = useCentre();
  return useQuery({
    queryKey: ['day-summary', centre.id, date],
    queryFn: () => rpc<DaySummary>('day_summary', { p_centre: centre.id, p_date: date }),
    refetchInterval: 60_000,
  });
}

export function DaySummaryPage() {
  const { centre } = useCentre();
  const today = todayInCentre(centre.timezone);
  const [date, setDate] = useState(today);
  const q = useDaySummary(date);
  const s = q.data;
  return (
    <div className="stack lg">
      <div className="page-head">
        <h1>Day summary</h1>
        {s && <ImageSendButton small={false} className="primary" label="Share" title="Share day summary" filename={`day-summary-${s.date}.png`}
          caption={{ en: `${centre.name} · day summary ${formatDay(s.date)}`, ml: `${centre.name} · ${formatDay(s.date)} ദിവസത്തെ കണക്ക്` }}
          build={() => summaryCard({ centre, date: s.date, revenue: s.revenue_paise, expenses: s.expenses_paise, net: s.net_paise, bills: s.bills, games: s.games,
            customers: s.customers, byGame: s.by_game, snacks: s.snacks_paise, byMethod: Object.fromEntries(Object.entries(s.by_method).map(([k, v]) => [METHOD[k] ?? k, v])),
            unpaid: s.unpaid_paise, alerts: s.alerts.length })} />}
      </div>
      <div className="chips scroll">
        {Array.from({ length: 7 }, (_, i) => addDays(today, -i)).map((d, i) => (
          <button key={d} className="chip" aria-pressed={d === date} onClick={() => setDate(d)}>{i === 0 ? 'Today' : i === 1 ? 'Yesterday' : formatDay(d)}</button>
        ))}
      </div>
      {q.isPending ? <Loading rows={4} /> : q.error ? <Notice tone="bad">{errorMessage(q.error)}</Notice> : s && (
        <>
          <div className="tiles">
            <div className="tile"><span className="label">Sales</span><span className="value num">{formatINR(s.revenue_paise)}</span><span className="sub">{s.bills} bills · {s.customers} customers</span></div>
            <div className="tile"><span className="label">Expenses</span><span className="value num">{formatINR(s.expenses_paise)}</span></div>
            <div className="tile"><span className="label">Net</span><span className={`value num ${s.net_paise < 0 ? 'neg' : ''}`}>{formatINR(s.net_paise)}</span></div>
            <div className="tile"><span className="label">Games</span><span className="value num">{s.games}</span><span className="sub">{s.bookings} bookings</span></div>
          </div>

          <section className="card stack" aria-label="Things to check">
            <h2><AlertTriangle size={18} style={{ verticalAlign: -3 }} /> Things to check</h2>
            {s.alerts.length === 0 ? <p className="muted">Nothing unusual. No voids, big discounts, unpaid bills or cash differences.</p> : (
              <ul className="list flush">{groupAlerts(s.alerts).map((a, i) => (
                <li key={i} className="item">
                  <span className={`badge ${a.level}`}>{a.level === 'bad' ? 'Check now' : 'Note'}</span>
                  <span className="main-col">
                    <span className="title" style={{ fontWeight: 500 }}>{a.text}{a.count > 1 && <b> ×{a.count}</b>}</span>
                    {a.times.length > 0 && <span className="sub">{a.times.join(', ')}</span>}
                  </span>
                </li>
              ))}</ul>
            )}
          </section>

          <section className="card stack">
            <h2>By game</h2>
            {s.by_game.length === 0 ? <Empty title="No games billed">Bills closed on this day show here.</Empty> : (
              <ul className="list flush">
                {s.by_game.map((g) => <li key={g.name} className="item" style={{ justifyContent: 'space-between' }}><span>{g.name} <span className="muted">· {g.games}</span></span><b className="num">{formatINR(g.amount_paise)}</b></li>)}
                {s.snacks_paise > 0 && <li className="item" style={{ justifyContent: 'space-between' }}><span>Snacks & drinks</span><b className="num">{formatINR(s.snacks_paise)}</b></li>}
                {(() => {
                  const off = s.by_game.reduce((t, g) => t + g.amount_paise, 0) + s.snacks_paise - s.revenue_paise;
                  return off > 0 ? <li className="item" style={{ justifyContent: 'space-between' }}><span>Points & discounts</span><b className="num">−{formatINR(off)}</b></li> : null;
                })()}
                <li className="item" style={{ justifyContent: 'space-between', fontWeight: 700 }}><span>Sales</span><b className="num">{formatINR(s.revenue_paise)}</b></li>
              </ul>
            )}
            <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
              {Object.entries(s.by_method).map(([m, v]) => `${METHOD[m] ?? m} ${formatINR(v)}`).join(' · ') || 'No payments'}
              {s.unpaid_paise > 0 && ` · Unpaid ${formatINR(s.unpaid_paise)}`}
              {s.discount_paise > 0 && ` · Discounts ${formatINR(s.discount_paise)}`}
            </p>
          </section>
        </>
      )}
    </div>
  );
}

/** Same alert text on one row with a count and the times it happened. */
function groupAlerts(alerts: { kind: string; level: string; text: string; at?: string }[]) {
  const out: { level: string; text: string; count: number; times: string[] }[] = [];
  for (const a of alerts) {
    const t = a.at ? new Date(a.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null;
    const g = out.find((x) => x.text === a.text && x.level === a.level);
    if (g) { g.count++; if (t) g.times.push(t); } else out.push({ level: a.level, text: a.text, count: 1, times: t ? [t] : [] });
  }
  return out;
}
