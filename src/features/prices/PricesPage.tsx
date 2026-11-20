// Prices per game: billing mode, rate, minimum, grace, overtime, players, peak / happy-hour prices.
// Saving creates a new version; games already running keep the price they started with.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useCentre } from '../../app/centre';
import { Field, Loading, Notice, Sheet, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { KIND_LABEL, MODE_LABEL, priceSummary, type Activity, type BillingMode, type RateCard, type TimeRule } from '../../lib/floor';
import { formatINR, paiseToInput, parseINR } from '../../lib/money';
import { rpc } from '../../lib/supabase';
import { useFloorState } from '../floor/useFloor';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COLORS = ['#1BAF7A', '#2A78D6', '#9B5DE5', '#EB6834', '#EDA100', '#E0457B', '#00A3B4', '#6B7A8F'];

export function PricesPage() {
  const { can } = useCentre();
  const state = useFloorState();
  const [edit, setEdit] = useState<Activity | null>(null);
  const [adding, setAdding] = useState(false);
  if (state.isPending) return <Loading rows={5} />;
  if (state.error) return <Notice tone="bad">{errorMessage(state.error)}</Notice>;
  const acts = state.data!.activities;
  const manage = can('pricing.manage');
  return (
    <div className="stack lg">
      <div className="page-head">
        <h1>Games & prices</h1>
        {manage && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={18} /> <span className="btn-text">Add game</span></button>}
      </div>
      <p className="muted">Changing a price never changes games already running or bills already made.</p>
      <ul className="list card flush">
        {acts.map((a) => (
          <li key={a.id}>
            <button className="item" disabled={!manage} onClick={() => setEdit(a)} style={!a.active ? { opacity: 0.55 } : undefined}>
              <span className="avatar" aria-hidden style={{ background: a.color, color: '#fff' }}>{a.name.slice(0, 2)}</span>
              <span className="main-col"><span className="title">{a.name}</span>
                <span className="meta"><span>{priceSummary(a.rate_card)}</span>{a.rate_card?.time_rules.length ? <span>{a.rate_card.time_rules.length} special price{a.rate_card.time_rules.length > 1 ? 's' : ''}</span> : null}
                  {a.rate_card && a.rate_card.grace_minutes > 0 && <span>{a.rate_card.grace_minutes} min grace</span>}</span></span>
              <span className="end-col">{!a.active && <span className="badge neutral">Hidden</span>}{manage && <Pencil size={16} />}</span>
            </button>
          </li>
        ))}
      </ul>
      {edit && <RateSheet a={edit} onClose={() => setEdit(null)} />}
      {adding && <NewActivitySheet onClose={() => setAdding(false)} />}
    </div>
  );
}

function RateSheet({ a, onClose }: { a: Activity; onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const rc = a.rate_card ?? ({ billing_mode: 'per_minute', price_paise: 0, block_minutes: 30, slot_minutes: 15, min_minutes: 0, grace_minutes: 0,
    overtime_price_paise: null, per_player: false, included_players: 1, extra_player_paise: 0, time_rules: [], addons: [] } as unknown as RateCard);
  const [f, setF] = useState({
    name: a.name, color: a.color, active: a.active, mode: rc.billing_mode, price: paiseToInput(rc.price_paise), block: rc.block_minutes, slot: rc.slot_minutes,
    min: rc.min_minutes, grace: rc.grace_minutes, overtime: rc.overtime_price_paise != null ? paiseToInput(rc.overtime_price_paise) : '',
    perPlayer: rc.per_player, included: rc.included_players, extra: rc.extra_player_paise ? paiseToInput(rc.extra_player_paise) : '',
    rules: rc.time_rules.map((r) => ({ ...r, price: paiseToInput(r.price_paise) })),
  });
  const price = parseINR(f.price || '0') ?? (f.price.trim() === '0' ? 0 : null);
  const save = useMutation({
    mutationFn: async () => {
      if (price == null) throw new Error('Enter a valid price');
      const rules: TimeRule[] = f.rules.map((r) => {
        const p = parseINR(r.price);
        if (!p || !r.days.length || !r.start || !r.end) throw new Error('Each special price needs a name, days, times and a price');
        return { label: r.label.trim() || 'Special', days: r.days, start: r.start, end: r.end, price_paise: p };
      });
      if (f.name !== a.name || f.color !== a.color || f.active !== a.active) {
        await rpc('save_activity', { p_centre: centre.id, p_activity: a.id, p_name: f.name.trim(), p_kind: a.kind, p_icon: a.icon, p_color: f.color, p_active: f.active });
      }
      await rpc('save_rate_card', { p_centre: centre.id, p_activity: a.id, p_card: {
        billing_mode: f.mode, price_paise: price, block_minutes: f.block, slot_minutes: f.slot, min_minutes: f.min, grace_minutes: f.grace,
        overtime_price_paise: f.overtime ? parseINR(f.overtime) : null, per_player: f.perPlayer, included_players: f.included,
        extra_player_paise: f.extra ? parseINR(f.extra) ?? 0 : 0, time_rules: rules, addons: rc.addons ?? [],
      } });
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['floor', centre.id] }); toast(`${f.name} prices saved`); onClose(); },
  });
  const unit = f.mode === 'per_frame' ? 'per frame' : f.mode === 'per_slot' ? 'per slot' : 'per hour';
  const setRule = (i: number, patch: Partial<(typeof f.rules)[number]>) => setF({ ...f, rules: f.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <Sheet title={a.name} onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid-2">
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="How to charge"><select className="input" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as BillingMode })}>
            {(Object.keys(MODE_LABEL) as BillingMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select></Field>
        </div>
        <div className="grid-2">
          <Field label={`Price ${unit} (₹)`} error={price == null ? 'Enter a valid price' : null}><input className="input num" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
          {f.mode === 'hourly_block' && <Field label="Block (minutes)"><input className="input num" inputMode="numeric" value={f.block} onChange={(e) => setF({ ...f, block: Number(e.target.value) || 30 })} /></Field>}
          {f.mode === 'per_slot' && <Field label="Slot length (minutes)"><input className="input num" inputMode="numeric" value={f.slot} onChange={(e) => setF({ ...f, slot: Number(e.target.value) || 15 })} /></Field>}
        </div>
        {(f.mode === 'per_minute' || f.mode === 'hourly_block') && (
          <Field label="Minimum charge (minutes)" hint="Short games are charged at least this much"><input className="input num" inputMode="numeric" value={f.min} onChange={(e) => setF({ ...f, min: Number(e.target.value) || 0 })} /></Field>
        )}
        {f.mode !== 'per_frame' && (
          <div className="grid-2">
            <Field label="Grace (minutes)" hint="Free minutes after booked time"><input className="input num" inputMode="numeric" value={f.grace} onChange={(e) => setF({ ...f, grace: Math.min(60, Number(e.target.value) || 0) })} /></Field>
            <Field label="Overtime price per hour (₹)" hint="Empty = normal price"><input className="input num" inputMode="decimal" value={f.overtime} onChange={(e) => setF({ ...f, overtime: e.target.value })} /></Field>
          </div>
        )}
        <label className="check-row" style={{ padding: 0 }}><input type="checkbox" checked={f.perPlayer} onChange={(e) => setF({ ...f, perPlayer: e.target.checked })} />
          <span className="grow">Price is per player{a.kind === 'track' ? ' (per car)' : ''}</span></label>
        {!f.perPlayer && (
          <div className="grid-2">
            <Field label="Players included"><input className="input num" inputMode="numeric" value={f.included} onChange={(e) => setF({ ...f, included: Math.max(1, Number(e.target.value) || 1) })} /></Field>
            <Field label={`Each extra player (₹ ${f.mode === 'per_minute' || f.mode === 'hourly_block' ? 'per hour' : unit})`}><input className="input num" inputMode="decimal" value={f.extra} onChange={(e) => setF({ ...f, extra: e.target.value })} placeholder="0" /></Field>
          </div>
        )}

        {(f.mode === 'per_minute' || f.mode === 'hourly_block') && (
          <div className="stack">
            <h3 style={{ margin: 0 }}>Special prices</h3>
            <p className="muted" style={{ margin: 0, fontSize: 'var(--t-sm)' }}>Peak hours, weekends or happy hour. Games crossing into a special time are split and charged correctly.</p>
            {f.rules.map((r, i) => (
              <div key={i} className="card stack" style={{ background: 'var(--paper-2)' }}>
                <div className="grid-2">
                  <Field label="Name"><input className="input" value={r.label} onChange={(e) => setRule(i, { label: e.target.value })} placeholder="Peak / Happy hour" /></Field>
                  <Field label="Price per hour (₹)"><input className="input num" inputMode="decimal" value={r.price} onChange={(e) => setRule(i, { price: e.target.value })} /></Field>
                </div>
                <div className="chips">{DAYS.map((d, n) => (
                  <button type="button" key={d} className="chip" aria-pressed={r.days.includes(n)} onClick={() => setRule(i, { days: r.days.includes(n) ? r.days.filter((x) => x !== n) : [...r.days, n].sort() })}>{d}</button>
                ))}</div>
                <div className="grid-2">
                  <Field label="From"><input className="input" type="time" value={r.start} onChange={(e) => setRule(i, { start: e.target.value })} /></Field>
                  <Field label="To"><input className="input" type="time" value={r.end} onChange={(e) => setRule(i, { end: e.target.value })} /></Field>
                </div>
                <button type="button" className="btn small ghost danger" style={{ justifySelf: 'start' }} onClick={() => setF({ ...f, rules: f.rules.filter((_, j) => j !== i) })}><Trash2 size={14} /> Remove</button>
              </div>
            ))}
            <button type="button" className="btn small" style={{ justifySelf: 'start' }}
              onClick={() => setF({ ...f, rules: [...f.rules, { label: 'Peak', days: [5, 6, 0], start: '18:00', end: '23:00', price_paise: 0, price: '' }] })}><Plus size={14} /> Add special price</button>
          </div>
        )}

        <div className="field"><span>Colour on the floor</span>
          <div className="chips">{COLORS.map((c) => (
            <button type="button" key={c} aria-label={c} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })}
              style={{ width: 30, height: 30, borderRadius: '50%', border: 0, cursor: 'pointer', background: c, boxShadow: f.color === c ? '0 0 0 3px var(--paper), 0 0 0 5px var(--ink)' : 'none' }} />
          ))}</div></div>
        <label className="check-row" style={{ padding: 0 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          <span className="grow">Offer this game</span></label>
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={save.isPending || !f.name.trim() || price == null}>Save {a.name}</button>
        {price != null && <p className="muted" style={{ textAlign: 'center', margin: 0, fontSize: 'var(--t-sm)' }}>Example: {example(f.mode, price, f.min, f.slot, f.block)}</p>}
      </form>
    </Sheet>
  );
}

function example(mode: BillingMode, price: number, min: number, slot: number, block: number) {
  switch (mode) {
    case 'per_minute': return `45 min = ${formatINR(Math.round((price * Math.max(45, min)) / 60 / 100) * 100)}${min ? `, 10 min = ${formatINR(Math.round((price * min) / 60 / 100) * 100)} (minimum)` : ''}`;
    case 'hourly_block': return `40 min = ${Math.ceil(40 / block)} blocks = ${formatINR(Math.round((Math.ceil(40 / block) * block * price) / 60 / 100) * 100)}`;
    case 'per_frame': return `3 frames = ${formatINR(price * 3)}`;
    case 'per_slot': return `${slot * 2} min = 2 slots = ${formatINR(price * 2)}`;
  }
}

function NewActivitySheet({ onClose }: { onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Activity['kind']>('table');
  const add = useMutation({
    mutationFn: () => rpc('save_activity', { p_centre: centre.id, p_activity: null, p_name: name.trim(), p_kind: kind, p_icon: 'circle', p_color: COLORS[5], p_active: true }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['floor', centre.id] }); onClose(); },
  });
  return (
    <Sheet title="Add a game" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="VR, Carrom, Foosball, Bowling…" autoFocus /></Field>
        <Field label="Type"><select className="input" value={kind} onChange={(e) => setKind(e.target.value as Activity['kind'])}>
          {(Object.keys(KIND_LABEL) as Activity['kind'][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></Field>
        <Notice tone="info">After adding, set its price, then place it on the floor in the designer.</Notice>
        {add.error && <Notice tone="bad">{errorMessage(add.error)}</Notice>}
        <button className="btn primary block xl" disabled={!name.trim() || add.isPending}>Add game</button>
      </form>
    </Sheet>
  );
}
