// Assets: everything the centre owns in one place — equipment (cues, balls, cloth, controllers…), the tables, consoles and
// tracks themselves (with the games installed on each console), and repair tickets.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Car, Gamepad2, Plus, Wrench, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useCentre } from '../../app/centre';
import { Empty, Field, Loading, Notice, Segmented, Sheet, useToast } from '../../components/ui';
import { formatDate } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR, parseINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';
import { RaiseTicketSheet, TicketsList, useTickets } from './tickets';

export type Asset = {
  id: string; name: string; category: Category; qty: number; resource_id: string | null; condition: Condition;
  bought_on: string | null; cost_paise: number; notes: string | null;
};
type Category = 'cue' | 'balls' | 'cloth' | 'rack' | 'chalk' | 'controller' | 'console' | 'headset' | 'screen' | 'rc_car' | 'battery' | 'furniture' | 'other';
type Condition = 'good' | 'worn' | 'needs_repair' | 'retired';
type Station = { id: string; name: string; status: string; games: string[]; activity: { name: string; kind: string } | null };

export const CATEGORY_LABEL: Record<Category, string> = {
  cue: 'Cues', balls: 'Ball sets', cloth: 'Table cloth', rack: 'Racks', chalk: 'Chalk', controller: 'Controllers', console: 'Consoles',
  headset: 'Headsets', screen: 'Screens / TVs', rc_car: 'RC cars', battery: 'Batteries', furniture: 'Furniture', other: 'Other',
};
const CONDITION_LABEL: Record<Condition, string> = { good: 'Good', worn: 'Worn', needs_repair: 'Needs repair', retired: 'Retired' };
const CONDITION_TONE: Record<Condition, string> = { good: 'ok', worn: 'warn', needs_repair: 'bad', retired: 'neutral' };
/** Common console games, offered as one-tap picks. Owners can type any other name. */
const POPULAR_GAMES = ['GTA 6', 'GTA V', 'EA Sports FC 26', 'Tekken 8', 'Call of Duty', 'Mortal Kombat 1', 'NBA 2K26', 'Gran Turismo 7',
  'Spider-Man 2', 'Fortnite', 'WWE 2K25', 'Cricket 24', 'F1 25', 'God of War Ragnarök', 'Red Dead Redemption 2'];

export function useAssets() {
  const { centre } = useCentre();
  return useQuery({
    queryKey: ['assets', centre.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('assets').select('*').eq('centre_id', centre.id).order('category').order('name');
      if (error) throw error;
      return data as Asset[];
    },
  });
}

function useStations() {
  const { centre } = useCentre();
  return useQuery({
    queryKey: ['places', centre.id, 'stations'],
    queryFn: async () => {
      const { data, error } = await supabase.from('resources').select('id,name,status,games,sort,activities(name,kind)')
        .eq('centre_id', centre.id).neq('status', 'archived').order('sort');
      if (error) throw error;
      return (data as unknown as (Station & { activities: Station['activity'] })[]).map((r) => ({ ...r, activity: r.activities })) as Station[];
    },
  });
}

export function AssetsPage() {
  const { centre, can, hasFeature } = useCentre();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'items' | 'stations' | 'repairs' | null) ?? 'items';
  const setTab = (t: string) => setParams((p) => { p.set('tab', t); return p; }, { replace: true });
  const tickets = useTickets();
  const openTickets = (tickets.data ?? []).filter((t) => t.status !== 'resolved').length;
  return (
    <div className="stack lg">
      <div className="page-head"><h1>Assets</h1></div>
      <Segmented label="Section" value={tab} onChange={setTab} options={[
        { value: 'items', label: 'Equipment' }, { value: 'stations', label: 'Tables & consoles' },
        { value: 'repairs', label: `Repairs${openTickets ? ` (${openTickets})` : ''}` },
      ]} />
      {tab === 'items' && <EquipmentTab canEdit={can('inventory.manage')} />}
      {tab === 'stations' && <StationsTab canEdit={can('inventory.manage')} />}
      {tab === 'repairs' && <TicketsList />}
      {tab === 'items' && hasFeature('rc_fleet') && can('floor.operate') && (
        <Link className="card row" to={`/s/${centre.slug}/rc`} style={{ textDecoration: 'none', color: 'inherit' }}>
          <Car size={20} /> <span className="grow"><b>RC cars, batteries and remotes</b>
            <span className="muted" style={{ display: 'block', fontSize: 'var(--t-sm)' }}>Charging, damage and deposits are tracked in RC fleet.</span></span>
        </Link>
      )}
    </div>
  );
}

function EquipmentTab({ canEdit }: { canEdit: boolean }) {
  const q = useAssets();
  const stations = useStations();
  const [edit, setEdit] = useState<Partial<Asset> | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const list = (q.data ?? []).filter((a) => showRetired || a.condition !== 'retired');
  const stationName = (id: string | null) => stations.data?.find((s) => s.id === id)?.name;
  const total = (q.data ?? []).filter((a) => a.condition !== 'retired').reduce((t, a) => t + a.cost_paise, 0);
  const needs = (q.data ?? []).filter((a) => a.condition === 'needs_repair').length;
  const groups = useMemo(() => {
    const m = new Map<Category, Asset[]>();
    list.forEach((a) => m.set(a.category, [...(m.get(a.category) ?? []), a]));
    return [...m.entries()];
  }, [list]);
  return (
    <div className="stack lg">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
          {(q.data ?? []).filter((a) => a.condition !== 'retired').reduce((t, a) => t + a.qty, 0)} items{total > 0 ? ` · ${formatINR(total)} spent` : ''}{needs ? ` · ${needs} need repair` : ''}
        </span>
        {canEdit && <button className="btn primary" onClick={() => setEdit({ category: 'cue', qty: 1, condition: 'good' })} data-testid="add-asset"><Plus size={18} /> <span className="btn-text">Add item</span></button>}
      </div>
      {q.isPending ? <Loading rows={4} /> : q.error ? <Notice tone="bad">{errorMessage(q.error)}</Notice> : list.length === 0 ? (
        <div className="card"><Empty title="No equipment yet">Add cues, ball sets, cloth, controllers and anything else you buy — with how many, what it cost and its condition.</Empty></div>
      ) : groups.map(([cat, items]) => (
        <section key={cat} className="stack">
          <h2 style={{ fontSize: 'var(--t-md)', margin: 0 }}>{CATEGORY_LABEL[cat]}</h2>
          <ul className="list card flush" data-testid={`assets-${cat}`}>
            {items.map((a) => (
              <li key={a.id}>
                <button className="item" onClick={() => canEdit && setEdit(a)} disabled={!canEdit} style={a.condition === 'retired' ? { opacity: 0.5 } : undefined}>
                  <Boxes size={20} />
                  <span className="main-col">
                    <span className="title">{a.name}</span>
                    <span className="meta">
                      <span className="num">Qty {a.qty}</span>
                      {stationName(a.resource_id) && <span>{stationName(a.resource_id)}</span>}
                      {a.bought_on && <span>Bought {formatDate(a.bought_on)}</span>}
                      {a.cost_paise > 0 && <span className="num">{formatINR(a.cost_paise)}</span>}
                    </span>
                  </span>
                  <span className="end-col"><span className={`badge ${CONDITION_TONE[a.condition]}`}>{CONDITION_LABEL[a.condition]}</span></span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {(q.data ?? []).some((a) => a.condition === 'retired') && (
        <button className="text-link" onClick={() => setShowRetired((v) => !v)}>{showRetired ? 'Hide retired items' : 'Show retired items'}</button>
      )}
      {edit && <AssetSheet a={edit} stations={stations.data ?? []} onClose={() => setEdit(null)} />}
    </div>
  );
}

function AssetSheet({ a, stations, onClose }: { a: Partial<Asset>; stations: Station[]; onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [reporting, setReporting] = useState(false);
  const [f, setF] = useState({
    name: a.name ?? '', category: (a.category ?? 'cue') as Category, qty: String(a.qty ?? 1), resource_id: a.resource_id ?? '',
    condition: (a.condition ?? 'good') as Condition, bought_on: a.bought_on ?? '', cost: a.cost_paise ? String(a.cost_paise / 100) : '', notes: a.notes ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const qty = Number(f.qty);
      if (!Number.isInteger(qty) || qty < 0) throw new Error('Quantity must be a whole number');
      const cost = f.cost ? parseINR(f.cost) : 0;
      if (cost === null) throw new Error('Cost looks wrong');
      return rpc('save_asset', { p_centre: centre.id, p_asset: {
        id: a.id ?? null, name: f.name, category: f.category, qty, resource_id: f.resource_id || null, condition: f.condition,
        bought_on: f.bought_on || null, cost_paise: cost, notes: f.notes || null,
      } });
    },
    onSuccess: async () => {
      await Promise.all(['assets', 'places'].map((k) => qc.invalidateQueries({ queryKey: [k, centre.id] })));
      toast(a.id ? 'Saved' : `${f.name} added`); onClose();
    },
  });
  if (reporting && a.id) return <RaiseTicketSheet assetId={a.id} resourceId={a.resource_id ?? undefined} onClose={onClose} />;
  return (
    <Sheet title={a.id ? a.name ?? 'Item' : 'Add item'} onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Type"><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Category })} data-testid="asset-category">
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></Field>
        <div className="grid-2">
          <Field label="Name"><input className="input" value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Peradon cues" data-testid="asset-name" /></Field>
          <Field label="How many"><input className="input num" inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} data-testid="asset-qty" /></Field>
        </div>
        <div className="grid-2">
          <Field label="Used at (optional)"><select className="input" value={f.resource_id} onChange={(e) => setF({ ...f, resource_id: e.target.value })}>
            <option value="">Anywhere</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Condition"><select className="input" value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value as Condition })}>
            {(Object.keys(CONDITION_LABEL) as Condition[]).map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}</select></Field>
        </div>
        <div className="grid-2">
          <Field label="Bought on (optional)"><input className="input" type="date" value={f.bought_on} onChange={(e) => setF({ ...f, bought_on: e.target.value })} /></Field>
          <Field label="Total cost ₹ (optional)"><input className="input num" inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} data-testid="asset-cost" /></Field>
        </div>
        <Field label="Notes (optional)"><input className="input" value={f.notes} maxLength={500} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Shop, warranty, serial no." /></Field>
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={save.isPending || !f.name.trim()}>{a.id ? 'Save' : 'Add item'}</button>
        {a.id && <button type="button" className="btn block" onClick={() => setReporting(true)}><Wrench size={18} /> Report a problem with this</button>}
      </form>
    </Sheet>
  );
}

function StationsTab({ canEdit }: { canEdit: boolean }) {
  const q = useStations();
  const tickets = useTickets();
  const [games, setGames] = useState<Station | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const openOn = (id: string) => (tickets.data ?? []).filter((t) => t.resource_id === id && t.status !== 'resolved').length;
  const allGames = useMemo(() => [...new Set((q.data ?? []).flatMap((s) => s.games))].sort((a, b) => a.localeCompare(b)), [q.data]);
  if (q.isPending) return <Loading rows={4} />;
  if (q.error) return <Notice tone="bad">{errorMessage(q.error)}</Notice>;
  if (!q.data?.length) return <div className="card"><Empty title="No tables yet">Draw your hall in the Floor designer first.</Empty></div>;
  return (
    <>
      <ul className="list card flush" data-testid="stations-list">
        {q.data.map((s) => {
          const console = s.activity?.kind === 'console';
          const n = openOn(s.id);
          return (
            <li key={s.id} className="station-row">
              <div className="item" style={{ cursor: 'default' }}>
                {console ? <Gamepad2 size={20} /> : <Boxes size={20} />}
                <span className="main-col">
                  <span className="title">{s.name}{s.activity ? <span className="muted"> · {s.activity.name}</span> : null}</span>
                  {console && (
                    <span className="meta game-chips" data-testid={`games-${s.name}`}>
                      {s.games.length ? s.games.map((g) => <span key={g} className="game-chip">{g}</span>) : <span>No games listed</span>}
                    </span>
                  )}
                </span>
                <span className="end-col row" style={{ gap: 6 }}>
                  {s.status === 'out_of_service' && <span className="badge bad">Out of use</span>}
                  {n > 0 && <span className="badge warn">{n} repair{n > 1 ? 's' : ''}</span>}
                  {console && canEdit && <button className="btn small" onClick={() => setGames(s)} data-testid={`edit-games-${s.name}`}>Games</button>}
                  <button className="btn small ghost icon-btn" title="Report a problem" aria-label={`Report a problem with ${s.name}`} onClick={() => setReport(s.id)}><Wrench size={16} /></button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {games && <GamesSheet s={games} known={allGames} onClose={() => setGames(null)} />}
      {report && <RaiseTicketSheet resourceId={report} onClose={() => setReport(null)} />}
    </>
  );
}

/** Tick or type the games installed on a console. Customers see these when booking. */
export function GamesSheet({ s, known, onClose }: { s: { id: string; name: string; games: string[] }; known: string[]; onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [list, setList] = useState<string[]>(s.games);
  const [typed, setTyped] = useState('');
  const has = (g: string) => list.some((x) => x.toLowerCase() === g.toLowerCase());
  const toggle = (g: string) => setList(has(g) ? list.filter((x) => x.toLowerCase() !== g.toLowerCase()) : [...list, g]);
  const addTyped = () => { const g = typed.trim().slice(0, 40); if (g && !has(g)) setList([...list, g]); setTyped(''); };
  const picks = [...new Set([...known, ...POPULAR_GAMES])].filter((g) => !has(g)).slice(0, 18);
  const save = useMutation({
    mutationFn: () => rpc<string[]>('set_resource_games', { p_centre: centre.id, p_resource: s.id, p_games: list }),
    onSuccess: async () => {
      await Promise.all(['places', 'floor'].map((k) => qc.invalidateQueries({ queryKey: [k, centre.id] })));
      toast(`Games saved for ${s.name}`); onClose();
    },
  });
  return (
    <Sheet title={`Games on ${s.name}`} onClose={onClose}>
      <div className="stack lg">
        <p className="muted" style={{ margin: 0 }}>Customers pick a game when they book, and only consoles with that game are offered.</p>
        <div className="chips" data-testid="games-selected">
          {list.length === 0 && <span className="muted">No games yet</span>}
          {list.map((g) => <button key={g} type="button" className="chip" aria-pressed onClick={() => toggle(g)}>{g} <X size={14} aria-label="remove" /></button>)}
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); addTyped(); }}>
          <input className="input grow" value={typed} maxLength={40} onChange={(e) => setTyped(e.target.value)} placeholder="Type a game, e.g. GTA 6" data-testid="game-input" />
          <button className="btn" disabled={!typed.trim()}>Add</button>
        </form>
        {picks.length > 0 && (
          <div className="field"><span>Quick add</span>
            <div className="chips">{picks.map((g) => <button key={g} type="button" className="chip" onClick={() => toggle(g)}><Plus size={14} /> {g}</button>)}</div>
          </div>
        )}
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={save.isPending} onClick={() => save.mutate()} data-testid="save-games">Save games</button>
      </div>
    </Sheet>
  );
}
