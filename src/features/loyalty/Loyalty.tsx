// Loyalty points: owner settings (every rule editable) and a customer's points card with history + manual adjust.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCentre } from '../../app/centre';
import { Field, Notice, Sheet, useToast } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';
import { usePoints, type Reward, type Tier } from '../billing/BillSheet';

type HappyHour = { label: string; days: number[]; start: string; end: string; multiplier: number };
type Settings = {
  enabled: boolean; available: boolean; earn_points_per_100: number; earn_on_snacks: boolean; point_value_paise: number; min_redeem_points: number;
  max_redeem_pct: number; welcome_points: number; birthday_points: number; expiry_months: number | null;
  multipliers: Record<string, number>; happy_hours: HappyHour[];
  rewards: Reward[]; tiers: Tier[];
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KIND: Record<string, string> = { earn: 'Earned', redeem: 'Used', welcome: 'Welcome bonus', birthday: 'Birthday bonus', adjust: 'Adjusted', expire: 'Expired', reverse: 'Bill voided' };

export function LoyaltySettings() {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['loyalty', centre.id], queryFn: () => rpc<Settings>('loyalty_settings_get', { p_centre: centre.id }) });
  const acts = useQuery({
    queryKey: ['activities-lite', centre.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('activities').select('id,name').eq('centre_id', centre.id).eq('active', true).order('sort');
      if (error) throw error;
      return data as { id: string; name: string }[];
    },
  });
  const [f, setF] = useState<Settings | null>(null);
  const [value, setValue] = useState('0.50');
  useEffect(() => { if (q.data) { setF(q.data); setValue((q.data.point_value_paise / 100).toFixed(2)); } }, [q.data]);
  const save = useMutation({
    mutationFn: () => {
      const v = Math.round(Number(value) * 100);
      if (!Number.isFinite(v) || v < 1) throw new Error('Point value must be at least ₹0.01');
      return rpc('save_loyalty_settings', { p_centre: centre.id, p_settings: { ...f, point_value_paise: v } });
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['loyalty', centre.id] }); await qc.invalidateQueries({ queryKey: ['points', centre.id] }); toast('Loyalty settings saved'); },
  });
  if (!f) return null;
  if (!f.available) return <section className="card stack" id="loyalty"><h2>Loyalty points</h2><Notice tone="info">Loyalty points are available on the Growth and Pro plans.</Notice></section>;
  const num = (k: keyof Settings) => (e: { target: { value: string } }) => setF({ ...f, [k]: Math.max(0, Math.round(Number(e.target.value) || 0)) });
  const pv = Math.round(Number(value) * 100) || 0;
  const back = f.earn_points_per_100 * pv / 100; // ₹ back per ₹100
  const setHH = (i: number, h: Partial<HappyHour>) => setF({ ...f, happy_hours: f.happy_hours.map((x, j) => j === i ? { ...x, ...h } : x) });

  return (
    <section className="card stack lg" id="loyalty">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h2>Loyalty points</h2><p className="muted" style={{ fontSize: 'var(--t-sm)' }}>Customers earn points on every bill and use them on the next one. Changes apply to new bills only.</p></div>
        <label className="switch-row"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> {f.enabled ? 'On' : 'Off'}</label>
      </div>
      <Notice tone="info">
        Spend ₹1,000 → <b>{f.earn_points_per_100 * 10} points</b> worth <b>{formatINR(f.earn_points_per_100 * 10 * pv)}</b> ({back.toFixed(1)}% back).
        Points can pay up to {f.max_redeem_pct}% of a bill, from {f.min_redeem_points} points.
      </Notice>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Field label="Points per ₹100 spent"><input className="input num" inputMode="numeric" value={f.earn_points_per_100} onChange={num('earn_points_per_100')} /></Field>
        <Field label="Value of 1 point (₹)"><input className="input num" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        <Field label="Use from (points)"><input className="input num" inputMode="numeric" value={f.min_redeem_points} onChange={num('min_redeem_points')} /></Field>
        <Field label="Points can pay up to (% of bill)"><input className="input num" inputMode="numeric" value={f.max_redeem_pct} onChange={num('max_redeem_pct')} /></Field>
        <Field label="Welcome bonus (first bill)"><input className="input num" inputMode="numeric" value={f.welcome_points} onChange={num('welcome_points')} /></Field>
        <Field label="Birthday bonus" hint="Given on a bill on their birthday, once a year"><input className="input num" inputMode="numeric" value={f.birthday_points} onChange={num('birthday_points')} /></Field>
        <Field label="Points expire after">
          <select className="input" value={f.expiry_months ?? ''} onChange={(e) => setF({ ...f, expiry_months: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Never</option>{[3, 6, 12, 24].map((m) => <option key={m} value={m}>{m} months</option>)}</select></Field>
        <label className="check-row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.earn_on_snacks} onChange={(e) => setF({ ...f, earn_on_snacks: e.target.checked })} />
          <span>Snacks & drinks earn points too</span></label>
      </div>

      <div className="field"><span>Extra points by game</span><span className="hint">e.g. 2× on RC tracks to fill them up</span>
        <div className="chips">{acts.data?.map((a) => {
          const m = f.multipliers[a.id] ?? 1;
          return (
            <label key={a.id} className="chip mult-chip">{a.name}
              <select value={m} aria-label={`${a.name} points multiplier`} onChange={(e) => {
                const v = Number(e.target.value); const next = { ...f.multipliers };
                if (v === 1) delete next[a.id]; else next[a.id] = v;
                setF({ ...f, multipliers: next });
              }}>{[0, 1, 1.5, 2, 3].map((x) => <option key={x} value={x}>{x === 0 ? 'none' : `${x}×`}</option>)}</select>
            </label>
          );
        })}</div>
      </div>

      <div className="field"><span>Happy hours (bonus points)</span><span className="hint">Games started in these hours earn extra points</span>
        {f.happy_hours.map((h, i) => (
          <div key={i} className="hh-row">
            <div className="chips">{DAYS.map((d, n) => (
              <button key={d} type="button" className="chip" aria-pressed={h.days.includes(n)}
                onClick={() => setHH(i, { days: h.days.includes(n) ? h.days.filter((x) => x !== n) : [...h.days, n].sort() })}>{d}</button>
            ))}</div>
            <div className="row">
              <input className="input" type="time" value={h.start} onChange={(e) => setHH(i, { start: e.target.value })} aria-label="From" />
              <span>to</span>
              <input className="input" type="time" value={h.end} onChange={(e) => setHH(i, { end: e.target.value })} aria-label="To" />
              <select className="input" style={{ width: 'auto' }} value={h.multiplier} onChange={(e) => setHH(i, { multiplier: Number(e.target.value) })} aria-label="Multiplier">
                {[1.5, 2, 3].map((x) => <option key={x} value={x}>{x}×</option>)}</select>
              <button type="button" className="btn small ghost icon-btn" aria-label="Remove happy hour" onClick={() => setF({ ...f, happy_hours: f.happy_hours.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        <button type="button" className="btn small" style={{ justifySelf: 'start' }}
          onClick={() => setF({ ...f, happy_hours: [...f.happy_hours, { label: 'Happy hour', days: [1, 2, 3, 4], start: '14:00', end: '17:00', multiplier: 2 }] })}>
          <Plus size={16} /> Add happy hour</button>
      </div>
      <div className="field"><span>Rewards</span><span className="hint">Fixed rewards the counter can give for points, e.g. "30 min snooker free". Taken off the bill at checkout.</span>
        {(f.rewards ?? []).map((r, i) => (
          <div key={r.id || i} className="row reward-row">
            <input className="input grow" value={r.name} placeholder="Reward name" aria-label="Reward name"
              onChange={(e) => setF({ ...f, rewards: f.rewards.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
            <label className="row" style={{ gap: 4 }}><input className="input num" style={{ width: 80 }} inputMode="numeric" value={r.points || ''} aria-label="Points needed"
              onChange={(e) => setF({ ...f, rewards: f.rewards.map((x, j) => j === i ? { ...x, points: Number(e.target.value.replace(/\D/g, '')) || 0 } : x) })} /> pts</label>
            <label className="row" style={{ gap: 4 }}>₹<input className="input num" style={{ width: 80 }} inputMode="numeric" value={r.value_paise ? r.value_paise / 100 : ''} aria-label="Worth in rupees"
              onChange={(e) => setF({ ...f, rewards: f.rewards.map((x, j) => j === i ? { ...x, value_paise: (Number(e.target.value.replace(/\D/g, '')) || 0) * 100 } : x) })} /></label>
            <button type="button" className="btn small ghost icon-btn" aria-label="Remove reward" onClick={() => setF({ ...f, rewards: f.rewards.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
          </div>
        ))}
        <button type="button" className="btn small" style={{ justifySelf: 'start' }}
          onClick={() => setF({ ...f, rewards: [...(f.rewards ?? []), { id: '', name: '30 min free game', points: 300, value_paise: 10000 }] })}><Plus size={16} /> Add reward</button>
      </div>

      <div className="field"><span>Tiers</span><span className="hint">Regulars earn more. Based on points earned from bills (bonuses don't count).</span>
        {(f.tiers ?? []).map((t, i) => (
          <div key={i} className="row reward-row">
            <input className="input grow" value={t.name} placeholder="Tier name" aria-label="Tier name"
              onChange={(e) => setF({ ...f, tiers: f.tiers.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
            <label className="row" style={{ gap: 4 }}>from<input className="input num" style={{ width: 80 }} inputMode="numeric" value={t.min_points} aria-label="From points"
              onChange={(e) => setF({ ...f, tiers: f.tiers.map((x, j) => j === i ? { ...x, min_points: Number(e.target.value.replace(/\D/g, '')) || 0 } : x) })} /> pts</label>
            <select className="input" style={{ width: 'auto' }} value={t.multiplier} aria-label="Extra earning"
              onChange={(e) => setF({ ...f, tiers: f.tiers.map((x, j) => j === i ? { ...x, multiplier: Number(e.target.value) } : x) })}>
              {[1.25, 1.5, 2, 3].map((m) => <option key={m} value={m}>{m}× points</option>)}</select>
            <button type="button" className="btn small ghost icon-btn" aria-label="Remove tier" onClick={() => setF({ ...f, tiers: f.tiers.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
          </div>
        ))}
        <button type="button" className="btn small" style={{ justifySelf: 'start' }}
          onClick={() => setF({ ...f, tiers: [...(f.tiers ?? []), (f.tiers ?? []).length ? { name: 'Gold', min_points: 2000, multiplier: 1.5 } : { name: 'Silver', min_points: 500, multiplier: 1.25 }] })}><Plus size={16} /> Add tier</button>
      </div>

      {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
      <button className="btn primary" style={{ justifySelf: 'start' }} disabled={save.isPending} onClick={() => save.mutate()}>Save loyalty settings</button>
    </section>
  );
}

/** Points card on a customer's page. */
export function CustomerPointsCard({ customerId }: { customerId: string }) {
  const { centre, can } = useCentre();
  const pts = usePoints(customerId);
  const [adjust, setAdjust] = useState(false);
  if (!pts?.enabled) return null;
  return (
    <section className="card stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2><Star size={18} style={{ verticalAlign: -2 }} /> {pts.balance} points</h2>
        {can('loyalty.manage') && <button className="btn small" onClick={() => setAdjust(true)}>Adjust</button>}
      </div>
      {(pts.tier || pts.next_tier) && (
        <p style={{ fontSize: 'var(--t-sm)' }}>{pts.tier && <span className="tier-badge" style={{ marginLeft: 0, marginRight: 8 }}>{pts.tier.name} · {pts.tier.multiplier}× points</span>}
          {pts.next_tier && <span className="muted">{pts.next_tier.min_points - (pts.lifetime ?? 0)} more points to {pts.next_tier.name}</span>}</p>
      )}
      <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>Worth {formatINR(pts.value_paise)}{pts.next_expiry ? ` · some expire ${new Date(pts.next_expiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</p>
      {pts.history.length > 0 && (
        <ul className="list flush">{pts.history.slice(0, 10).map((h, i) => (
          <li key={i} className="item" style={{ justifyContent: 'space-between' }}>
            <span className="main-col"><span className="title">{KIND[h.kind] ?? h.kind}</span><span className="meta">{h.note ? `${h.note} · ` : ''}{formatDateTime(h.at, centre.timezone)}</span></span>
            <b className="num" style={{ color: h.points > 0 ? 'var(--ok)' : 'var(--graphite)' }}>{h.points > 0 ? '+' : ''}{h.points}</b>
          </li>
        ))}</ul>
      )}
      {adjust && <AdjustSheet customerId={customerId} balance={pts.balance} onClose={() => setAdjust(false)} />}
    </section>
  );
}

function AdjustSheet({ customerId, balance, onClose }: { customerId: string; balance: number; onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [n, setN] = useState('');
  const [reason, setReason] = useState('');
  const [sign, setSign] = useState<1 | -1>(1);
  const run = useMutation({
    mutationFn: () => rpc<number>('adjust_points', { p_centre: centre.id, p_customer: customerId, p_points: sign * Math.round(Number(n)), p_reason: reason }),
    onSuccess: async (bal) => { await qc.invalidateQueries({ queryKey: ['points', centre.id] }); toast(`Balance now ${bal} points`); onClose(); },
  });
  return (
    <Sheet title="Adjust points" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <p className="muted">Current balance: {balance} points</p>
        <div className="chips">
          <button type="button" className="chip" aria-pressed={sign === 1} onClick={() => setSign(1)}>Add</button>
          <button type="button" className="chip" aria-pressed={sign === -1} onClick={() => setSign(-1)}>Remove</button>
        </div>
        <Field label="Points"><input className="input num" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
        <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Tournament prize" /></Field>
        {run.error && <Notice tone="bad">{errorMessage(run.error)}</Notice>}
        <button className="btn primary block" disabled={!n || !reason.trim() || run.isPending}>Save</button>
      </form>
    </Sheet>
  );
}
