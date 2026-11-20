// Floor designer (owner only): draw the hall, drop in tables/consoles/tracks and fixtures, save.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, RotateCw, Save, Shapes, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useBlocker } from 'react-router';
import { useCentre } from '../../app/centre';
import { Empty, Field, Loading, Notice, Segmented, Sheet, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { defaultSize, FIXTURE_LABEL, uid, type Activity, type Fixture, type FixtureType, type Floor, type Resource } from '../../lib/floor';
import { rpc } from '../../lib/supabase';
import { FloorMap, type DragKind } from './FloorMap';
import { useFloorState } from './useFloor';
import './floor.css';

const SNAP = 10;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
type Draft = { floor: Floor; resources: Resource[] };

export function DesignerPage() {
  const { centre } = useCentre();
  const state = useFloorState();
  const [floorId, setFloorId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<{ id: string; kind: 'resource' | 'fixture' } | null>(null);
  const [editOutline, setEditOutline] = useState(false);
  const [quick, setQuick] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const data = state.data;
  const floors = data?.floors ?? [];
  const current = floors.find((f) => f.id === floorId) ?? floors[0];

  // load a floor into the draft (only when not editing)
  useEffect(() => {
    if (!data || !current || dirty) return;
    setFloorId(current.id);
    setDraft({ floor: structuredClone(current), resources: structuredClone(data.resources.filter((r) => r.floor_id === current.id)) });
  }, [data, current, dirty]);

  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state === 'blocked') { if (window.confirm('Leave without saving the floor?')) blocker.proceed(); else blocker.reset(); }
  }, [blocker]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      const res = await rpc<{ floor_id: string; version: number }>('save_floor', {
        p_centre: centre.id,
        p_floor: {
          id: draft.floor.id, version: draft.floor.version, name: draft.floor.name, width: Math.round(draft.floor.width), height: Math.round(draft.floor.height),
          outline: draft.floor.outline, fixtures: draft.floor.fixtures,
          resources: draft.resources.map((r) => ({
            id: r.id, activity_id: r.activity_id, name: r.name.trim(), shape: r.shape, x: r.x, y: r.y, w: r.w, h: r.h, rotation: r.rotation,
            points: r.points, capacity: r.capacity, online_bookable: r.online_bookable, status: r.status,
          })),
        },
      });
      return res;
    },
    onSuccess: async () => { setDirty(false); await qc.invalidateQueries({ queryKey: ['floor', centre.id] }); toast('Floor saved'); },
  });
  const addFloor = useMutation({
    mutationFn: () => rpc<{ floor_id: string }>('save_floor', {
      p_centre: centre.id, p_floor: { name: `Hall ${floors.length + 1}`, width: 2000, height: 1200, outline: rect(2000, 1200), fixtures: [], resources: [] },
    }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['floor', centre.id] }); setFloorId(r.floor_id); setDirty(false); toast('Hall added'); },
  });

  const activities = useMemo(() => (data?.activities ?? []).filter((a) => a.active), [data]);
  if (state.isPending) return <Loading rows={6} />;
  if (state.error) return <Notice tone="bad">{errorMessage(state.error)}</Notice>;
  if (!draft) return <Empty title="No hall yet" />;

  const update = (fn: (d: Draft) => void) => { setDraft((d) => { if (!d) return d; const n = structuredClone(d); fn(n); return n; }); setDirty(true); };
  const allNames = new Set((data?.resources ?? []).filter((r) => r.floor_id !== draft.floor.id).map((r) => r.name.toLowerCase()));
  draft.resources.forEach((r) => allNames.add(r.name.toLowerCase()));
  const nextName = (a: Activity) => {
    const base = a.kind === 'console' ? `${a.name} #` : a.kind === 'track' ? `${a.name} track` : `${a.name} `;
    if (a.kind === 'track' && !allNames.has(base.toLowerCase())) return base;
    for (let i = 1; i < 200; i++) { const n = a.kind === 'track' ? `${base} ${i + 1}` : `${base}${i}`; if (!allNames.has(n.toLowerCase())) return n; }
    return `${a.name} ${uid().slice(0, 4)}`;
  };
  const addResource = (a: Activity) => {
    const sz = defaultSize(a);
    const id = uid();
    update((d) => {
      const n = d.resources.length;
      d.resources.push({
        id, floor_id: d.floor.id, activity_id: a.id, name: nextName(a), shape: sz.shape, w: sz.w, h: sz.h, rotation: 0, points: null,
        x: snap(Math.min(d.floor.width - sz.w, 60 + (n % 5) * 80)), y: snap(Math.min(d.floor.height - sz.h, 60 + (n % 5) * 60)),
        capacity: sz.capacity, online_bookable: true, status: 'active', session: null,
      });
    });
    setSel({ id, kind: 'resource' });
  };
  const addFixture = (type: FixtureType) => {
    const id = uid();
    const size = type === 'wall' ? { w: 400, h: 20 } : type === 'entrance' ? { w: 160, h: 60 } : type === 'counter' ? { w: 300, h: 100 } : { w: 200, h: 140 };
    update((d) => d.floor.fixtures.push({ id, type, label: FIXTURE_LABEL[type], x: 40, y: 40, rotation: 0, ...size }));
    setSel({ id, kind: 'fixture' });
  };
  const onDrag = (g: DragKind, x: number, y: number, dx: number, dy: number) => {
    setDirty(true);
    setDraft((d) => {
      if (!d) return d;
      const n = { ...d, floor: { ...d.floor }, resources: d.resources };
      if (g.kind === 'vertex') {
        n.floor.outline = d.floor.outline.map((p, i) => (i === g.index ? [snap(clamp(x, 0, d.floor.width)), snap(clamp(y, 0, d.floor.height))] : p)) as [number, number][];
        return n;
      }
      const resize = g.handle === 'resize';
      const apply = <T extends { x: number; y: number; w: number; h: number }>(o: T): T => resize
        ? { ...o, w: Math.max(40, o.w + dx), h: Math.max(type(o) ? 10 : 40, o.h + dy) }
        : { ...o, x: clamp(o.x + dx, -o.w / 2, d.floor.width - o.w / 2), y: clamp(o.y + dy, -o.h / 2, d.floor.height - o.h / 2) };
      if (g.kind === 'resource') n.resources = d.resources.map((r) => (r.id === g.id ? apply(r) : r));
      else n.floor.fixtures = d.floor.fixtures.map((f) => (f.id === g.id ? apply(f) : f));
      return n;
    });
  };
  const onDragEnd = () => update((d) => {
    d.resources.forEach((r) => { r.x = snap(r.x); r.y = snap(r.y); r.w = snap(r.w); r.h = snap(r.h); });
    d.floor.fixtures.forEach((f) => { f.x = snap(f.x); f.y = snap(f.y); f.w = snap(f.w); f.h = Math.max(10, snap(f.h)); });
  });

  const selRes = sel?.kind === 'resource' ? draft.resources.find((r) => r.id === sel.id) : undefined;
  const selFix = sel?.kind === 'fixture' ? draft.floor.fixtures.find((f) => f.id === sel.id) : undefined;
  const live = (id: string) => !!data?.resources.find((r) => r.id === id)?.session;

  return (
    <div className="designer">
      <div className="page-head">
        <h1>Floor designer</h1>
        <div className="row">
          <button className="btn" onClick={() => setQuick(true)}><Sparkles size={18} /> <span className="btn-text">Quick layout</span></button>
          <button className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Save size={18} /> {save.isPending ? 'Saving…' : dirty ? 'Save floor' : 'Saved'}</button>
        </div>
      </div>
      {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}

      <div className="floor-tabs">
        {floors.map((f) => (
          <button key={f.id} className={`chip`} aria-pressed={f.id === draft.floor.id}
            onClick={() => { if (dirty && !window.confirm('Switch hall without saving?')) return; setDirty(false); setSel(null); setFloorId(f.id); }}>{f.name}</button>
        ))}
        <button className="chip" disabled={addFloor.isPending} onClick={() => { if (!dirty || window.confirm('Add a hall without saving this one?')) addFloor.mutate(); }}><Plus size={14} /> Hall</button>
      </div>

      <div className="card stack">
        <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>Tap to add, then drag into place. Drag the corner square to resize.</span>
        <div className="palette">
          {activities.map((a) => (
            <button key={a.id} className="btn small" onClick={() => addResource(a)}><span className="dot" style={{ background: a.color }} /> {a.name}</button>
          ))}
          {(['counter', 'entrance', 'cafe', 'toilet', 'wall', 'tv'] as FixtureType[]).map((t) => (
            <button key={t} className="btn small ghost" onClick={() => addFixture(t)}><Shapes size={14} /> {FIXTURE_LABEL[t]}</button>
          ))}
        </div>
      </div>

      <div className="designer-body">
        <div className="designer-stage">
          <FloorMap floor={draft.floor} resources={draft.resources} activities={data?.activities ?? []} mode="design"
            selectedId={sel?.id} onSelect={(id, kind) => setSel(id ? { id, kind: kind ?? 'resource' } : null)}
            editOutline={editOutline} onDrag={onDrag} onDragEnd={onDragEnd} />
        </div>

        <aside className="inspector card">
          {selRes ? (
            <ResourceInspector r={selRes} activities={activities} live={live(selRes.id)}
              onChange={(patch) => update((d) => { Object.assign(d.resources.find((x) => x.id === selRes.id)!, patch); })}
              onDuplicate={() => { const a = activities.find((x) => x.id === selRes.activity_id); if (!a) return; const id = uid();
                update((d) => d.resources.push({ ...selRes, id, name: nextName(a), x: selRes.x + 40, y: selRes.y + 40, session: null })); setSel({ id, kind: 'resource' }); }}
              onDelete={() => { update((d) => { d.resources = d.resources.filter((x) => x.id !== selRes.id); }); setSel(null); }} />
          ) : selFix ? (
            <FixtureInspector f={selFix} onChange={(patch) => update((d) => { Object.assign(d.floor.fixtures.find((x) => x.id === selFix.id)!, patch); })}
              onDelete={() => { update((d) => { d.floor.fixtures = d.floor.fixtures.filter((x) => x.id !== selFix.id); }); setSel(null); }} />
          ) : (
            <HallInspector floor={draft.floor} editOutline={editOutline} setEditOutline={setEditOutline}
              onChange={(patch) => update((d) => { Object.assign(d.floor, patch); })} count={draft.resources.length} />
          )}
        </aside>
      </div>
      {quick && <QuickLayout activities={activities} floor={draft.floor} onClose={() => setQuick(false)}
        onApply={(resources) => { update((d) => { d.resources = [...d.resources.filter((r) => live(r.id)), ...resources]; }); setQuick(false); setSel(null); }} />}
    </div>
  );
}

function type(o: unknown) { return (o as Fixture).type === 'wall'; }
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
function rect(w: number, h: number): [number, number][] { return [[0, 0], [w, 0], [w, h], [0, h]]; }
function lShape(w: number, h: number): [number, number][] { return [[0, 0], [w, 0], [w, Math.round(h * 0.55)], [Math.round(w * 0.55), Math.round(h * 0.55)], [Math.round(w * 0.55), h], [0, h]]; }

function HallInspector({ floor, onChange, editOutline, setEditOutline, count }: {
  floor: Floor; onChange: (p: Partial<Floor>) => void; editOutline: boolean; setEditOutline: (v: boolean) => void; count: number;
}) {
  const shape = floor.outline.length === 4 ? 'rect' : floor.outline.length === 6 ? 'l' : 'custom';
  const m = (v: number) => String(Math.round(v / 100) / 1);
  return (
    <div className="stack lg">
      <h2>Hall</h2>
      <Field label="Name"><input className="input" value={floor.name} onChange={(e) => onChange({ name: e.target.value })} /></Field>
      <div className="grid-2">
        <Field label="Width (m)"><input className="input num" inputMode="decimal" value={m(floor.width)}
          onChange={(e) => { const w = Math.max(2, Number(e.target.value) || 0) * 100; onChange({ width: w, outline: shape === 'l' ? lShape(w, floor.height) : shape === 'rect' ? rect(w, floor.height) : floor.outline }); }} /></Field>
        <Field label="Length (m)"><input className="input num" inputMode="decimal" value={m(floor.height)}
          onChange={(e) => { const h = Math.max(2, Number(e.target.value) || 0) * 100; onChange({ height: h, outline: shape === 'l' ? lShape(floor.width, h) : shape === 'rect' ? rect(floor.width, h) : floor.outline }); }} /></Field>
      </div>
      <Segmented label="Hall shape" value={shape} onChange={(v) => {
        if (v === 'rect') onChange({ outline: rect(floor.width, floor.height) });
        if (v === 'l') onChange({ outline: lShape(floor.width, floor.height) });
        if (v === 'custom') setEditOutline(true);
      }} options={[{ value: 'rect', label: 'Rectangle' }, { value: 'l', label: 'L-shape' }, { value: 'custom', label: 'Custom' }]} />
      <label className="check-row" style={{ padding: 0 }}><input type="checkbox" checked={editOutline} onChange={(e) => setEditOutline(e.target.checked)} />
        <span className="grow">Drag the corners to match your hall</span></label>
      {editOutline && (
        <div className="row">
          <button className="btn small" onClick={() => {
            const o = floor.outline; const i = o.length - 1; const a = o[i], b = o[0];
            onChange({ outline: [...o, [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2)]] as [number, number][] });
          }}><Plus size={14} /> Add corner</button>
          {floor.outline.length > 3 && <button className="btn small ghost" onClick={() => onChange({ outline: floor.outline.slice(0, -1) })}>Remove last corner</button>}
        </div>
      )}
      <p className="muted" style={{ fontSize: 'var(--t-sm)', margin: 0 }}>{count} item{count === 1 ? '' : 's'} on this hall. Select one to edit it.</p>
    </div>
  );
}

function ResourceInspector({ r, activities, live, onChange, onDuplicate, onDelete }: {
  r: Resource; activities: Activity[]; live: boolean; onChange: (p: Partial<Resource>) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  return (
    <div className="stack lg">
      <h2>{r.name || 'Item'}</h2>
      <Field label="Name"><input className="input" value={r.name} onChange={(e) => onChange({ name: e.target.value })} /></Field>
      <Field label="Game"><select className="input" value={r.activity_id} onChange={(e) => onChange({ activity_id: e.target.value })} disabled={live}>
        {activities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      <div className="grid-2">
        <Field label="Width (cm)"><input className="input num" inputMode="numeric" value={Math.round(r.w)} onChange={(e) => onChange({ w: Math.max(40, Number(e.target.value) || 40) })} /></Field>
        <Field label="Length (cm)"><input className="input num" inputMode="numeric" value={Math.round(r.h)} onChange={(e) => onChange({ h: Math.max(40, Number(e.target.value) || 40) })} /></Field>
      </div>
      <div className="grid-2">
        <Field label="Shape"><select className="input" value={r.shape} onChange={(e) => onChange({ shape: e.target.value as Resource['shape'] })}>
          <option value="rect">Rectangle</option><option value="round">Round / oval</option></select></Field>
        <Field label="Max players"><input className="input num" inputMode="numeric" value={r.capacity} onChange={(e) => onChange({ capacity: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} /></Field>
      </div>
      <div className="row">
        <button className="btn small" onClick={() => onChange({ rotation: (r.rotation + 90) % 360 })}><RotateCw size={14} /> Turn 90°</button>
        <button className="btn small" onClick={() => onChange({ rotation: (r.rotation + 15) % 360 })}>+15°</button>
        <button className="btn small" onClick={onDuplicate}><Copy size={14} /> Duplicate</button>
      </div>
      <label className="check-row" style={{ padding: 0 }}><input type="checkbox" checked={r.online_bookable} onChange={(e) => onChange({ online_bookable: e.target.checked })} />
        <span className="grow">Customers can book it online</span></label>
      <label className="check-row" style={{ padding: 0 }}><input type="checkbox" checked={r.status === 'out_of_service'} disabled={live}
        onChange={(e) => onChange({ status: e.target.checked ? 'out_of_service' : 'active' })} /><span className="grow">Out of service</span></label>
      {live ? <Notice tone="info">A game is running here. End it before removing or changing the game type.</Notice>
        : <button className="btn danger block" onClick={onDelete}><Trash2 size={16} /> Remove from floor</button>}
    </div>
  );
}

function FixtureInspector({ f, onChange, onDelete }: { f: Fixture; onChange: (p: Partial<Fixture>) => void; onDelete: () => void }) {
  return (
    <div className="stack lg">
      <h2>{FIXTURE_LABEL[f.type]}</h2>
      {f.type !== 'wall' && <Field label="Label"><input className="input" value={f.label} onChange={(e) => onChange({ label: e.target.value })} /></Field>}
      <div className="grid-2">
        <Field label="Width (cm)"><input className="input num" value={Math.round(f.w)} onChange={(e) => onChange({ w: Math.max(10, Number(e.target.value) || 10) })} /></Field>
        <Field label="Length (cm)"><input className="input num" value={Math.round(f.h)} onChange={(e) => onChange({ h: Math.max(10, Number(e.target.value) || 10) })} /></Field>
      </div>
      <button className="btn small" style={{ justifySelf: 'start' }} onClick={() => onChange({ rotation: (f.rotation + 90) % 360 })}><RotateCw size={14} /> Turn 90°</button>
      <button className="btn danger block" onClick={onDelete}><Trash2 size={16} /> Remove</button>
    </div>
  );
}

/** "4 pool, 2 snooker, 6 PS5, 1 drift track" → a tidy starter layout. */
function QuickLayout({ activities, floor, onClose, onApply }: {
  activities: Activity[]; floor: Floor; onClose: () => void; onApply: (r: Resource[]) => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>(() => Object.fromEntries(activities.map((a) => [a.id, a.kind === 'track' ? 1 : 2])));
  const build = () => {
    const out: Resource[] = [];
    const gap = 80;
    let x = gap, y = gap, rowH = 0;
    const tracks = activities.filter((a) => a.kind === 'track');
    const others = activities.filter((a) => a.kind !== 'track');
    // tracks along the right side, everything else fills rows from the top-left
    let ty = gap;
    for (const a of tracks) {
      const sz = defaultSize(a);
      for (let i = 0; i < (counts[a.id] ?? 0); i++) {
        out.push(res(a, floor, floor.width - sz.w - gap, ty, `${a.name}${counts[a.id] > 1 ? ` ${i + 1}` : ''} track`.replace(' track track', ' track'), sz));
        ty += sz.h + gap;
      }
    }
    const maxX = tracks.some((a) => counts[a.id]) ? floor.width - defaultSize(tracks[0]).w - gap * 2 : floor.width - gap;
    for (const a of others) {
      const sz = defaultSize(a);
      for (let i = 0; i < (counts[a.id] ?? 0); i++) {
        if (x + sz.w > maxX) { x = gap; y += rowH + gap; rowH = 0; }
        out.push(res(a, floor, x, y, a.kind === 'console' ? `${a.name} #${i + 1}` : `${a.name} ${i + 1}`, sz));
        x += sz.w + gap; rowH = Math.max(rowH, sz.h);
      }
      x = gap; y += rowH + gap; rowH = 0;
    }
    return out;
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <Sheet title="Quick layout" onClose={onClose}>
      <div className="stack lg">
        <p className="muted" style={{ margin: 0 }}>How many of each do you have? We lay them out in rows; then drag them to where they really are. Items with a game running stay where they are.</p>
        {activities.map((a) => (
          <div key={a.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span><span className="dot" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 4, background: a.color, marginRight: 8 }} />{a.name}</span>
            <span className="row">
              <button className="btn small icon-btn" aria-label={`Fewer ${a.name}`} onClick={() => setCounts({ ...counts, [a.id]: Math.max(0, (counts[a.id] ?? 0) - 1) })}>−</button>
              <b className="num" style={{ minWidth: 24, textAlign: 'center' }}>{counts[a.id] ?? 0}</b>
              <button className="btn small icon-btn" aria-label={`More ${a.name}`} onClick={() => setCounts({ ...counts, [a.id]: Math.min(30, (counts[a.id] ?? 0) + 1) })}>+</button>
            </span>
          </div>
        ))}
        <Notice tone="warn">This replaces the items on this hall (games in progress are kept). Save afterwards to keep it.</Notice>
        <button className="btn primary block xl" disabled={!total} onClick={() => onApply(build())}>Lay out {total} item{total === 1 ? '' : 's'}</button>
      </div>
    </Sheet>
  );
}

function res(a: Activity, floor: Floor, x: number, y: number, name: string, sz: ReturnType<typeof defaultSize>): Resource {
  return { id: uid(), floor_id: floor.id, activity_id: a.id, name, shape: sz.shape, x: snap(x), y: snap(y), w: sz.w, h: sz.h, rotation: 0, points: null,
    capacity: sz.capacity, online_bookable: true, status: 'active', session: null };
}
