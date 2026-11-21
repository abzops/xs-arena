import { useQuery } from '@tanstack/react-query';
import { Pencil, Phone } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { CustomerPointsCard } from '../loyalty/Loyalty';
import { useCentre } from '../../app/centre';
import { WhatsAppButton } from '../../components/centre';
import { BackLink, Empty, Loading, Notice, PushLink, Sheet, StatusBadge, initials } from '../../components/ui';
import { minutesLabel } from '../../lib/floor';
import { formatDate, todayInCentre } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR } from '../../lib/money';
import { supabase } from '../../lib/supabase';
import { SOURCE_LABEL, type Customer } from '../../lib/types';
import { CustomerForm, lastSeen } from './CustomersPage';

export function CustomerDetail() {
  const { customerId = '' } = useParams();
  const { centre, can } = useCentre();
  const [editing, setEditing] = useState(false);
  const base = `/s/${centre.slug}`;
  const tz = centre.timezone;

  const c = useQuery({
    queryKey: ['customer', centre.id, customerId],
    queryFn: async () => {
      const { data, error } = await supabase.from('customers').select('*').eq('id', customerId).maybeSingle();
      if (error) throw error;
      return data as Customer | null;
    },
  });
  const bills = useQuery({
    queryKey: ['bills', centre.id, 'customer', customerId],
    queryFn: async () => {
      const { data, error } = await supabase.from('bills').select('id, bill_no, created_at, status, total_paise, paid_paise, lines')
        .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return data as { id: string; bill_no: string; created_at: string; status: string; total_paise: number; paid_paise: number;
        lines: { games: { resource: string; activity: string; minutes: number }[]; items: { name: string }[] } }[];
    },
  });
  if (c.isPending) return <Loading rows={4} />;
  if (c.error) return <Notice tone="bad">{errorMessage(c.error)}</Notice>;
  const d = c.data;
  if (!d) return <Empty title="Customer not found" />;
  const due = (bills.data ?? []).filter((b) => ['partial', 'unpaid'].includes(b.status)).reduce((a, b) => a + b.total_paise - b.paid_paise, 0);
  const isBirthdayMonth = d.date_of_birth?.slice(5, 7) === todayInCentre(tz).slice(5, 7);
  const waKind = due > 0 ? 'dues' : isBirthdayMonth ? 'birthday' : d.last_visit_at && Date.now() - Date.parse(d.last_visit_at) > 45 * 864e5 ? 'comeback' : 'hello';

  return (
    <div className="stack xl">
      <BackLink className="btn ghost small" to={`${base}/customers`} style={{ justifySelf: 'start' }}>← Customers</BackLink>
      <div className="detail-head">
        <span className="avatar" aria-hidden>{initials(d.full_name)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{d.full_name}</h1>
          <p className="muted">{d.phone} · Customer #{d.customer_no} · {SOURCE_LABEL[d.source] ?? d.source}</p>
          {d.tags.length > 0 && <div className="row" style={{ marginTop: 6 }}>{d.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
        </div>
      </div>
      <div className="row">
        <a className="btn" href={`tel:${d.phone}`}><Phone size={18} /> Call</a>
        <WhatsAppButton phone={d.phone} kind={waKind} small={false} facts={{ name: d.full_name, amountPaise: due }} />
        {can('customers.manage') && <button className="btn" onClick={() => setEditing(true)}><Pencil size={18} /> Edit</button>}
      </div>

      <div className="tiles">
        <div className="tile"><span className="label">Visits</span><span className="value num">{d.visit_count}</span><span className="sub">Last: {lastSeen(d.last_visit_at)}</span></div>
        <div className="tile"><span className="label">Lifetime spend</span><span className="value num">{formatINR(d.total_spent_paise)}</span>
          <span className="sub">Avg {formatINR(d.visit_count ? Math.round(d.total_spent_paise / d.visit_count) : 0)}</span></div>
        <div className="tile"><span className="label">Balance due</span><span className={`value num ${due > 0 ? 'amount-due' : ''}`}>{formatINR(due)}</span>
          <span className="sub">Since {formatDate(d.created_at.slice(0, 10))}</span></div>
      </div>

      {(d.notes || d.date_of_birth) && (
        <section className="card">
          <dl className="kv">
            {d.date_of_birth && <><dt>Birthday</dt><dd>{formatDate(d.date_of_birth)}</dd></>}
            {d.anniversary && <><dt>Anniversary</dt><dd>{formatDate(d.anniversary)}</dd></>}
            {d.notes && <><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{d.notes}</dd></>}
          </dl>
        </section>
      )}

      <CustomerPointsCard customerId={customerId} />

      <section className="stack">
        <h2>Visits</h2>
        {bills.isPending ? <Loading rows={3} /> : !bills.data?.length ? <div className="card"><Empty title="No visits yet" /></div> : (
          <ul className="list card flush">{bills.data.map((b) => (
            <li key={b.id}><PushLink className="item" to={`${base}/bills/${b.id}`} style={b.status === 'void' ? { opacity: 0.55 } : undefined}>
              <span className="main-col"><span className="title">{[...b.lines.games.map((g) => `${g.activity} ${minutesLabel(g.minutes)}`), ...b.lines.items.map((i) => i.name)].slice(0, 4).join(', ')}</span>
                <span className="meta"><span className="num">{b.bill_no}</span><span>{formatDate(b.created_at.slice(0, 10))}</span></span></span>
              <span className="end-col"><b className="num">{formatINR(b.total_paise)}</b><StatusBadge status={b.status} /></span></PushLink></li>
          ))}</ul>
        )}
      </section>

      {editing && <Sheet title="Edit customer" onClose={() => setEditing(false)}><CustomerForm customer={d} onDone={() => setEditing(false)} /></Sheet>}
    </div>
  );
}
