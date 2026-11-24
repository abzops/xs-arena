// RC fleet: cars, batteries and controllers — status, charge cycles, damage with photo, repairs (→ expenses), deposits.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BatteryCharging, Camera, Car, Gamepad2, Plus, Wrench } from 'lucide-react';
import { useRef, useState } from 'react';
import { useCentre } from '../../app/centre';
import { Empty, Field, Loading, Notice, Sheet, useToast } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR, parseINR } from '../../lib/money';
import { billPhotoUrl, uploadBillPhoto } from '../../lib/photos';
import { rpc, supabase } from '../../lib/supabase';

type Status = 'ready' | 'charging' | 'in_use' | 'repair' | 'retired';
type Log = { kind: string; status: string | null; note: string | null; cost_paise: number; photo_path: string | null; at: string };
type Item = {
  id: string; kind: 'car' | 'battery' | 'controller'; name: string; activity_id: string | null; activity: string | null; status: Status;
  charge_cycles: number; last_charged_at: string | null; deposit_paise: number; notes: string | null;
  deposit_held_paise: number; repairs_paise: number; logs: Log[];
};
const STATUS: Record<Status, string> = { ready: 'Ready', charging: 'Charging', in_use: 'In use', repair: 'In repair', retired: 'Retired' };
const KIND_ICON = { car: Car, battery: BatteryCharging, controller: Gamepad2 };
const LOG_LABEL: Record<string, string> = {
  charge: 'Charged', damage: 'Damage', repair: 'Repaired', status: 'Status', deposit_in: 'Deposit taken', deposit_out: 'Deposit returned', note: 'Note',
};

export function RcPage() {
  const { centre, can } = useCentre();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['rc', centre.id], queryFn: () => rpc<{ available: boolean; items: Item[] }>('rc_fleet', { p_centre: centre.id }) });
  const items = q.data?.items ?? [];
  const live = items.filter((i) => i.status !== 'retired');
  const count = (s: Status) => live.filter((i) => i.status === s).length;
  const item = items.find((i) => i.id === open) ?? null;

  if (q.data && !q.data.available) return <div className="stack lg"><h1>RC fleet</h1><Notice tone="info">RC fleet is on the Growth and Pro plans.</Notice></div>;
  return (
    <div className="stack lg">
      <div className="page-head">
        <h1>RC fleet</h1>
        {can('inventory.manage') && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={18} /> <span className="btn-text">Add</span></button>}
      </div>
      {live.length > 0 && (
        <div className="tiles">
          <div className="tile"><span className="label">Ready</span><span className="value num">{count('ready')}</span></div>
          <div className="tile"><span className="label">Charging</span><span className="value num">{count('charging')}</span></div>
          <div className="tile"><span className="label">In repair</span><span className="value num">{count('repair')}</span></div>
          <div className="tile"><span className="label">Deposits held</span><span className="value num">{formatINR(live.reduce((a, i) => a + i.deposit_held_paise, 0))}</span></div>
        </div>
      )}
      {q.isPending ? <Loading rows={4} /> : q.error ? <Notice tone="bad">{errorMessage(q.error)}</Notice> : items.length === 0 ? (
        <div className="card"><Empty title="No RC cars yet">Add your cars, batteries and controllers to track charging, damage and repairs.</Empty></div>
      ) : (
        <ul className="list card flush">
          {items.map((i) => {
            const Icon = KIND_ICON[i.kind];
            return (
              <li key={i.id}>
                <button className="item" onClick={() => setOpen(i.id)} style={i.status === 'retired' ? { opacity: 0.5 } : undefined}>
                  <Icon size={20} />
                  <span className="main-col">
                    <span className="title">{i.name}</span>
                    <span className="meta">
                      {i.activity && <span>{i.activity}</span>}
                      {i.kind !== 'controller' && <span>{i.charge_cycles} charge{i.charge_cycles === 1 ? '' : 's'}</span>}
                      {i.deposit_held_paise > 0 && <span>Deposit {formatINR(i.deposit_held_paise)} held</span>}
                      {i.repairs_paise > 0 && <span>Repairs {formatINR(i.repairs_paise)}</span>}
                    </span>
                  </span>
                  <span className="end-col"><span className={`badge rc-${i.status}`}>{STATUS[i.status]}</span></span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {adding && <ItemSheet onClose={() => setAdding(false)} />}
      {item && <ActionSheet item={item} onClose={() => setOpen(null)} onChanged={() => qc.invalidateQueries({ queryKey: ['rc', centre.id] })} />}
    </div>
  );
}

function ItemSheet({ onClose }: { onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const acts = useQuery({
    queryKey: ['activities-lite', centre.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('activities').select('id,name').eq('centre_id', centre.id).eq('active', true).order('sort');
      if (error) throw error;
      return data as { id: string; name: string }[];
    },
  });
  const [f, setF] = useState({ kind: 'car', name: '', activity: '', deposit: '' });
  const save = useMutation({
    mutationFn: () => rpc('save_rc_item', { p_centre: centre.id, p_item: {
      kind: f.kind, name: f.name, activity_id: f.activity || null, deposit_paise: f.deposit ? parseINR(f.deposit) ?? 0 : 0,
    } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['rc', centre.id] }); toast(`${f.name} added`); onClose(); },
  });
  return (
    <Sheet title="Add to fleet" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="chips">{(['car', 'battery', 'controller'] as const).map((k) => (
          <button key={k} type="button" className="chip" aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })}>{k[0].toUpperCase() + k.slice(1)}</button>
        ))}</div>
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.kind === 'car' ? 'Car 4' : f.kind === 'battery' ? 'Battery B' : 'Remote 2'} autoFocus /></Field>
        <div className="grid-2">
          <Field label="Used on"><select className="input" value={f.activity} onChange={(e) => setF({ ...f, activity: e.target.value })}>
            <option value="">Any track</option>{acts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          {f.kind === 'car' && <Field label="Deposit to ask (₹)" hint="Optional"><input className="input num" inputMode="numeric" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} /></Field>}
        </div>
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={!f.name.trim() || save.isPending}>Add</button>
      </form>
    </Sheet>
  );
}

function ActionSheet({ item, onClose, onChanged }: { item: Item; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const { centre, can } = useCentre();
  const toast = useToast();
  const [mode, setMode] = useState<null | 'damage' | 'repair' | 'deposit_in' | 'deposit_out'>(null);
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = useMutation({
    mutationFn: async (x: { kind: string; status?: string }) => {
      const photo = file ? await uploadBillPhoto(centre.id, file) : null;
      return rpc('rc_log', { p_centre: centre.id, p_item: item.id, p_kind: x.kind, p_note: note || null,
        p_cost_paise: amount ? parseINR(amount) ?? 0 : 0, p_status: x.status ?? null, p_photo_path: photo, p_paid_from: 'drawer' });
    },
    onSuccess: async (_r, x) => {
      await onChanged();
      toast(x.kind === 'charge' ? `${item.name} charged` : x.kind === 'repair' ? `${item.name} back to ready` : 'Saved');
      setMode(null); setNote(''); setAmount(''); setFile(null);
    },
  });
  const openPhoto = async (p: string) => { try { window.open(await billPhotoUrl(p), '_blank', 'noopener'); } catch (e) { toast(errorMessage(e)); } };
  const retired = item.status === 'retired';
  return (
    <Sheet title={item.name} onClose={onClose}>
      <div className="stack lg">
        <p className="muted">{STATUS[item.status]}{item.kind !== 'controller' ? ` · ${item.charge_cycles} charge${item.charge_cycles === 1 ? '' : 's'}` : ''}
          {item.last_charged_at ? ` · last charged ${formatDateTime(item.last_charged_at, centre.timezone)}` : ''}
          {item.deposit_held_paise > 0 ? ` · deposit ${formatINR(item.deposit_held_paise)} held` : ''}</p>
        {!retired && !mode && (
          <div className="rc-actions">
            {item.kind !== 'controller' && <button className="btn" onClick={() => run.mutate({ kind: 'status', status: 'charging' })} disabled={run.isPending}><BatteryCharging size={18} /> On charge</button>}
            {item.kind !== 'controller' && <button className="btn" onClick={() => run.mutate({ kind: 'charge' })} disabled={run.isPending}><BatteryCharging size={18} /> Charged ✓</button>}
            {item.kind === 'car' && item.status !== 'in_use' && <button className="btn" onClick={() => run.mutate({ kind: 'status', status: 'in_use' })} disabled={run.isPending}><Car size={18} /> Out on track</button>}
            {item.status === 'in_use' && <button className="btn" onClick={() => run.mutate({ kind: 'status', status: 'ready' })} disabled={run.isPending}>Back from track</button>}
            <button className="btn" onClick={() => setMode('damage')}>Report damage</button>
            {item.status === 'repair' && <button className="btn" onClick={() => setMode('repair')}><Wrench size={18} /> Repaired</button>}
            {item.kind === 'car' && <button className="btn" onClick={() => { setMode('deposit_in'); setAmount(item.deposit_paise ? String(item.deposit_paise / 100) : ''); }}>Take deposit</button>}
            {item.deposit_held_paise > 0 && <button className="btn" onClick={() => { setMode('deposit_out'); setAmount(String(item.deposit_held_paise / 100)); }}>Return deposit</button>}
          </div>
        )}
        {mode && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); run.mutate({ kind: mode }); }}>
            {(mode === 'damage' || mode === 'repair') && (
              <Field label={mode === 'damage' ? 'What is damaged?' : 'What was fixed? (optional)'}>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'damage' ? 'Front wheel broken' : 'New wheel'} autoFocus /></Field>
            )}
            {(mode === 'deposit_in' || mode === 'deposit_out') && (
              <Field label="Customer (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Name or phone" /></Field>
            )}
            {mode !== 'damage' && (
              <Field label={mode === 'repair' ? 'Repair cost (₹)' : 'Amount (₹)'} hint={mode === 'repair' ? 'Added to Expenses as RC repairs (cash from the drawer)' : undefined}>
                <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            )}
            {mode === 'repair' && amount && !can('expenses.manage') && <Notice tone="warn">Only the owner or a manager can add a repair cost. Leave it empty to just mark it repaired.</Notice>}
            {(mode === 'damage' || mode === 'repair') && (
              <div className="row">
                <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Photo" />
                <button type="button" className="btn small" onClick={() => fileRef.current?.click()}><Camera size={16} /> {file ? 'Photo added ✓' : 'Add photo'}</button>
              </div>
            )}
            {run.error && <Notice tone="bad">{errorMessage(run.error)}</Notice>}
            <div className="row">
              <button type="button" className="btn" onClick={() => setMode(null)}>Back</button>
              <button className="btn primary grow" disabled={run.isPending || (mode === 'damage' && !note.trim()) || ((mode === 'deposit_in' || mode === 'deposit_out') && !amount)}>Save</button>
            </div>
          </form>
        )}
        {item.logs.length > 0 && (
          <ul className="list flush">{item.logs.map((l, i) => (
            <li key={i} className="item" style={{ justifyContent: 'space-between' }}>
              <span className="main-col"><span className="title">{LOG_LABEL[l.kind] ?? l.kind}{l.kind === 'status' && l.status ? `: ${STATUS[l.status as Status] ?? l.status}` : ''}</span>
                <span className="meta">{l.note ? `${l.note} · ` : ''}{formatDateTime(l.at, centre.timezone)}</span></span>
              <span className="end-col">
                {l.cost_paise > 0 && <b className="num">{formatINR(l.cost_paise)}</b>}
                {l.photo_path && <button className="btn small ghost icon-btn" aria-label="Open photo" onClick={() => openPhoto(l.photo_path!)}><Camera size={16} /></button>}
              </span>
            </li>
          ))}</ul>
        )}
      </div>
    </Sheet>
  );
}
