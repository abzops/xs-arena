// Bills for a day: totals by payment method, dues, list.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useCentre } from '../../app/centre';
import { Empty, Loading, Notice, PushLink, Segmented, StatusBadge } from '../../components/ui';
import { addDays, formatTime, todayInCentre, zoned } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR } from '../../lib/money';
import { supabase } from '../../lib/supabase';

type Row = { id: string; bill_no: string; created_at: string; status: string; total_paise: number; paid_paise: number;
  customers: { full_name: string } | null; lines: { games: { resource: string }[]; items: { name: string }[] } };

export function BillsPage() {
  const { centre } = useCentre();
  const today = todayInCentre(centre.timezone);
  const [day, setDay] = useState(today);
  const [filter, setFilter] = useState<'all' | 'due'>('all');
  const list = useQuery({
    queryKey: ['bills', centre.id, day, filter],
    queryFn: async () => {
      let q = supabase.from('bills').select('id, bill_no, created_at, status, total_paise, paid_paise, customers(full_name), lines').eq('centre_id', centre.id);
      if (filter === 'due') q = q.in('status', ['partial', 'unpaid']);
      else q = q.gte('created_at', zoned(day, '00:00', centre.timezone).toISOString()).lt('created_at', zoned(addDays(day, 1), '00:00', centre.timezone).toISOString());
      const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
      if (error) throw error;
      return data as unknown as Row[];
    },
  });
  const rows = list.data ?? [];
  const live = rows.filter((r) => r.status !== 'void');
  const total = live.reduce((a, r) => a + r.total_paise, 0);
  const due = live.reduce((a, r) => a + r.total_paise - r.paid_paise, 0);
  return (
    <div className="stack lg">
      <div className="page-head"><h1>Bills</h1></div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Segmented label="Show" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'By day' }, { value: 'due', label: 'Dues' }]} />
        {filter === 'all' && <input className="input" type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ maxWidth: 190 }} aria-label="Day" />}
      </div>
      <div className="tiles">
        <div className="tile"><span className="label">{filter === 'due' ? 'Bills with dues' : 'Sales'}</span><span className="value num">{filter === 'due' ? live.length : formatINR(total)}</span>
          <span className="sub">{filter === 'due' ? 'all dates' : `${live.length} bill${live.length === 1 ? '' : 's'}`}</span></div>
        <div className="tile"><span className="label">Balance due</span><span className={`value num ${due > 0 ? 'amount-due' : ''}`}>{formatINR(due)}</span><span className="sub">to collect</span></div>
      </div>
      {list.isPending ? <Loading rows={5} /> : list.error ? <Notice tone="bad">{errorMessage(list.error)}</Notice> : !rows.length ? (
        <div className="card"><Empty title={filter === 'due' ? 'No dues' : 'No bills on this day'} /></div>
      ) : (
        <ul className="list card flush">
          {rows.map((r) => (
            <li key={r.id}><PushLink className="item" to={`/s/${centre.slug}/bills/${r.id}`} style={r.status === 'void' ? { opacity: 0.55 } : undefined}>
              <span className="main-col"><span className="title">{r.customers?.full_name ?? 'Walk-in'} · {[...r.lines.games.map((g) => g.resource), ...r.lines.items.map((i) => i.name)].slice(0, 3).join(', ')}</span>
                <span className="meta"><span className="num">{r.bill_no}</span><span>{formatTime(r.created_at, centre.timezone)}</span></span></span>
              <span className="end-col"><b className="num">{formatINR(r.total_paise)}</b><StatusBadge status={r.status} /></span>
            </PushLink></li>
          ))}
        </ul>
      )}
    </div>
  );
}
