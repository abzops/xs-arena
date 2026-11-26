// Maintenance tickets: anyone on the floor raises one (cloth torn, controller dead, RC car broken), can take the table
// out of use, and closes it with what was done and when. Owner/manager cost goes to Expenses as "Repairs".
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useCentre } from '../../app/centre';
import { Empty, Field, Loading, Notice, Segmented, Sheet, useToast } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR, parseINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';

export type Ticket = {
  id: string; ticket_no: number; title: string; details: string | null; resource_id: string | null; asset_id: string | null;
  priority: 'low' | 'normal' | 'urgent'; status: 'open' | 'in_progress' | 'resolved'; took_out: boolean;
  raised_by_name: string | null; raised_at: string; started_at: string | null; resolution: string | null; fixed_at: string | null;
  cost_paise: number; resolved_by_name: string | null; resolved_at: string | null;
};
type Place = { id: string; name: string; status: string; activity: string | null };
type AssetLite = { id: string; name: string; resource_id: string | null };

export const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', urgent: 'Urgent' } as const;
export const STATUS_LABEL = { open: 'Open', in_progress: 'Being fixed', resolved: 'Closed' } as const;
const STATUS_TONE = { open: 'bad', in_progress: 'warn', resolved: 'ok' } as const;
const QUICK = ['Cloth torn', 'Cue broken', 'Ball missing', 'Light not working', 'Controller not working', 'Console not starting',
  'Screen problem', 'RC car damaged', 'Battery not charging'];

export function useTickets() {
  const { centre } = useCentre();
  return useQuery({
    queryKey: ['tickets', centre.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('tickets').select('*').eq('centre_id', centre.id).order('raised_at', { ascending: false }).limit(300);
      if (error) throw error;
      return data as Ticket[];
    },
  });
}

export function usePlaces() {
  const { centre } = useCentre();
  return useQuery({
    queryKey: ['places', centre.id],
    queryFn: async () => {
      const [r, a] = await Promise.all([
        supabase.from('resources').select('id,name,status,sort,activities(name)').eq('centre_id', centre.id).neq('status', 'archived').order('sort'),
        supabase.from('assets').select('id,name,resource_id').eq('centre_id', centre.id).neq('condition', 'retired').order('name'),
      ]);
      if (r.error) throw r.error;
      if (a.error) throw a.error;
      const places = (r.data as unknown as { id: string; name: string; status: string; activities: { name: string } | null }[])
        .map((x) => ({ id: x.id, name: x.name, status: x.status, activity: x.activities?.name ?? null }));
      return { places: places as Place[], assets: a.data as AssetLite[] };
    },
  });
}

const refreshAll = (qc: ReturnType<typeof useQueryClient>, centreId: string) =>
  Promise.all(['tickets', 'floor', 'places', 'assets', 'expenses', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k, centreId] })));

/** The tickets list (Tickets page and the Assets page's tab). */
export function TicketsList({ only }: { only?: { resource?: string; asset?: string } }) {
  const tickets = useTickets();
  const places = usePlaces();
  const [show, setShow] = useState<'open' | 'closed'>('open');
  const [open, setOpen] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const nameOf = (t: Ticket) => places.data?.places.find((p) => p.id === t.resource_id)?.name ?? places.data?.assets.find((a) => a.id === t.asset_id)?.name ?? null;
  const all = (tickets.data ?? []).filter((t) => (!only?.resource || t.resource_id === only.resource) && (!only?.asset || t.asset_id === only.asset));
  const list = all.filter((t) => (show === 'open' ? t.status !== 'resolved' : t.status === 'resolved'));
  const openCount = all.filter((t) => t.status !== 'resolved').length;
  const ticket = all.find((t) => t.id === open) ?? null;
  return (
    <div className="stack lg">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Segmented label="Show" value={show} onChange={setShow}
          options={[{ value: 'open', label: `Open${openCount ? ` (${openCount})` : ''}` }, { value: 'closed', label: 'Closed' }]} />
        <button className="btn primary" onClick={() => setRaising(true)} data-testid="raise-ticket"><Plus size={18} /> <span className="btn-text">Report a problem</span></button>
      </div>
      {tickets.isPending ? <Loading rows={3} /> : tickets.error ? <Notice tone="bad">{errorMessage(tickets.error)}</Notice> : list.length === 0 ? (
        <div className="card"><Empty title={show === 'open' ? 'Nothing to fix' : 'No closed tickets yet'}>
          {show === 'open' ? 'When a cloth tears, a controller dies or a car breaks, report it here so it gets fixed.' : 'Fixed problems show here with what was done and when.'}
        </Empty></div>
      ) : (
        <ul className="list card flush" data-testid="tickets-list">
          {list.map((t) => (
            <li key={t.id}>
              <button className="item" onClick={() => setOpen(t.id)}>
                <Wrench size={20} />
                <span className="main-col">
                  <span className="title">#{t.ticket_no} · {t.title}</span>
                  <span className="meta">
                    {nameOf(t) && <span>{nameOf(t)}</span>}
                    <span>{t.status === 'resolved' && t.fixed_at ? `Fixed ${formatDateTime(t.fixed_at)}` : `Raised ${formatDateTime(t.raised_at)}`}</span>
                    {t.raised_by_name && t.status !== 'resolved' && <span>by {t.raised_by_name}</span>}
                    {t.took_out && t.status !== 'resolved' && <span>Out of use</span>}
                  </span>
                </span>
                <span className="end-col row" style={{ gap: 6 }}>
                  {t.priority === 'urgent' && t.status !== 'resolved' && <span className="badge bad">Urgent</span>}
                  <span className={`badge ${STATUS_TONE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {raising && <RaiseTicketSheet resourceId={only?.resource} assetId={only?.asset} onClose={() => setRaising(false)} />}
      {ticket && <TicketSheet t={ticket} place={nameOf(ticket)} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Report a problem. From the floor the table is already picked. */
export function RaiseTicketSheet({ resourceId, assetId, onClose, onRaised }: { resourceId?: string; assetId?: string; onClose: () => void; onRaised?: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const places = usePlaces();
  const [f, setF] = useState({ title: '', details: '', resource: resourceId ?? '', asset: assetId ?? '', priority: 'normal', takeOut: false });
  const assets = (places.data?.assets ?? []).filter((a) => !f.resource || !a.resource_id || a.resource_id === f.resource);
  const raise = useMutation({
    mutationFn: () => rpc<Ticket>('raise_ticket', {
      p_centre: centre.id, p_title: f.title, p_details: f.details || null, p_resource: f.resource || null, p_asset: f.asset || null,
      p_priority: f.priority, p_take_out: !!f.resource && f.takeOut,
    }),
    onSuccess: async (t) => { await refreshAll(qc, centre.id); toast(`Ticket #${t.ticket_no} raised`); onRaised?.(); onClose(); },
  });
  return (
    <Sheet title="Report a problem" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); raise.mutate(); }}>
        <Field label="What's wrong?">
          <input className="input" value={f.title} maxLength={80} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Cloth torn near the top pocket"
            data-testid="ticket-title" autoFocus={window.matchMedia('(pointer: fine)').matches} />
        </Field>
        <div className="chips">{QUICK.map((q) => <button key={q} type="button" className="chip" aria-pressed={f.title === q} onClick={() => setF({ ...f, title: q })}>{q}</button>)}</div>
        <div className="grid-2">
          <Field label="Table, console or track">
            <select className="input" value={f.resource} data-testid="ticket-resource" onChange={(e) => setF({ ...f, resource: e.target.value, asset: '', takeOut: e.target.value ? f.takeOut : false })}>
              <option value="">None / general</option>
              {places.data?.places.map((p) => <option key={p.id} value={p.id}>{p.name}{p.activity ? ` · ${p.activity}` : ''}</option>)}
            </select></Field>
          <Field label="Item (optional)">
            <select className="input" value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}>
              <option value="">—</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></Field>
        </div>
        <Field label="Details (optional)"><textarea className="input" rows={2} value={f.details} maxLength={1000} onChange={(e) => setF({ ...f, details: e.target.value })} /></Field>
        <Segmented label="How urgent" value={f.priority} onChange={(v) => setF({ ...f, priority: v })}
          options={[{ value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'urgent', label: 'Urgent' }]} />
        {f.resource && (
          <label className="check-row" style={{ padding: 0 }}>
            <input type="checkbox" checked={f.takeOut} data-testid="ticket-takeout" onChange={(e) => setF({ ...f, takeOut: e.target.checked })} />
            <span className="grow">Take it out of use until fixed
              <span className="muted" style={{ display: 'block', fontSize: 'var(--t-sm)' }}>Staff can't start games on it and it won't be offered for booking.</span></span>
          </label>
        )}
        {raise.error && <Notice tone="bad">{errorMessage(raise.error)}</Notice>}
        <button className="btn primary block xl" disabled={raise.isPending || f.title.trim().length < 2}>Raise ticket</button>
      </form>
    </Sheet>
  );
}

const localInput = (d: Date) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };

function TicketSheet({ t, place, onClose }: { t: Ticket; place: string | null; onClose: () => void }) {
  const { centre, can } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [closing, setClosing] = useState(false);
  const [f, setF] = useState({ resolution: '', fixedAt: localInput(new Date()), cost: '', back: true });
  const start = useMutation({
    mutationFn: () => rpc('start_ticket', { p_centre: centre.id, p_ticket: t.id }),
    onSuccess: async () => { await refreshAll(qc, centre.id); toast('Marked as being fixed'); },
  });
  const resolve = useMutation({
    mutationFn: () => {
      const cost = f.cost ? parseINR(f.cost) : 0;
      if (cost === null) throw new Error('Cost looks wrong');
      return rpc('resolve_ticket', {
        p_centre: centre.id, p_ticket: t.id, p_resolution: f.resolution, p_fixed_at: new Date(f.fixedAt).toISOString(),
        p_cost_paise: cost, p_back_in_use: f.back,
      });
    },
    onSuccess: async () => { await refreshAll(qc, centre.id); toast(`Ticket #${t.ticket_no} closed`); onClose(); },
  });
  return (
    <Sheet title={`Ticket #${t.ticket_no}`} onClose={onClose}>
      <div className="stack lg">
        <div className="book-summary">
          <b>{t.title}</b>
          {place && <span>{place}{t.took_out && t.status !== 'resolved' ? ' · out of use' : ''}</span>}
          {t.details && <span className="muted">“{t.details}”</span>}
        </div>
        <ol className="timeline">
          <li><b>Raised</b> {formatDateTime(t.raised_at)}{t.raised_by_name ? ` by ${t.raised_by_name}` : ''} · {PRIORITY_LABEL[t.priority]}</li>
          {t.started_at && <li><b>Work started</b> {formatDateTime(t.started_at)}</li>}
          {t.status === 'resolved' && (
            <li data-testid="ticket-resolution"><b>Fixed</b> {t.fixed_at ? formatDateTime(t.fixed_at) : ''}{t.resolved_by_name ? ` · closed by ${t.resolved_by_name}` : ''}
              <span style={{ display: 'block' }}>{t.resolution}</span>
              {t.cost_paise > 0 && <span className="muted" style={{ display: 'block' }}>Cost {formatINR(t.cost_paise)} · added to Expenses as Repairs</span>}</li>
          )}
        </ol>
        {t.status !== 'resolved' && !closing && (
          <div className="stack">
            <button className="btn primary block xl" onClick={() => setClosing(true)} data-testid="close-ticket"><CheckCircle2 size={18} /> It's fixed — close ticket</button>
            {t.status === 'open' && <button className="btn block" disabled={start.isPending} onClick={() => start.mutate()}><Wrench size={18} /> Start work on it</button>}
          </div>
        )}
        {closing && (
          <form className="stack lg" onSubmit={(e) => { e.preventDefault(); resolve.mutate(); }}>
            <Field label="What was done?">
              <textarea className="input" rows={3} value={f.resolution} data-testid="ticket-fix" maxLength={1000} autoFocus
                onChange={(e) => setF({ ...f, resolution: e.target.value })} placeholder="e.g. Replaced the cloth with new Strachan cloth" /></Field>
            <div className="grid-2">
              <Field label="When was it fixed?"><input className="input" type="datetime-local" value={f.fixedAt} max={localInput(new Date())}
                onChange={(e) => setF({ ...f, fixedAt: e.target.value })} /></Field>
              {can('expenses.manage') && <Field label="Cost (₹, optional)" hint="Added to Expenses as Repairs">
                <input className="input num" inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} data-testid="ticket-cost" /></Field>}
            </div>
            {(t.resource_id || t.asset_id) && (
              <label className="check-row" style={{ padding: 0 }}>
                <input type="checkbox" checked={f.back} onChange={(e) => setF({ ...f, back: e.target.checked })} />
                <span className="grow">Put it back in use</span>
              </label>
            )}
            {resolve.error && <Notice tone="bad">{errorMessage(resolve.error)}</Notice>}
            <button className="btn primary block xl" disabled={resolve.isPending || f.resolution.trim().length < 3}>Close ticket</button>
          </form>
        )}
        {start.error && <Notice tone="bad">{errorMessage(start.error)}</Notice>}
      </div>
    </Sheet>
  );
}

export function TicketsPage() {
  return (
    <div className="stack lg">
      <div className="page-head"><h1>Repairs</h1></div>
      <p className="muted" style={{ margin: 0 }}>Report anything broken. Close the ticket with what was done, so everyone knows when it was fixed.</p>
      <TicketsList />
    </div>
  );
}
