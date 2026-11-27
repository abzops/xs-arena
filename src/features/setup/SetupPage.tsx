// "Set up your arena": six short steps a new owner does inside XS Arena, no call needed.
// 1 Centre details · 2 What's in your arena (ready-made list + prices) · 3 Your floor (drawn for you)
// 4 Payments (their UPI QR) · 5 Team · 6 Done (booking link, first game, how-to guide)
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Copy, Minus, Plus, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useCentre } from '../../app/centre';
import { Field, Loading, Notice, useToast } from '../../components/ui';
import { CATALOGUE, GROUP_LABEL, layoutItems, priceLabel, type CatalogueGroup, type CatalogueItem } from '../../lib/catalogue';
import { errorMessage } from '../../lib/errors';
import type { Activity, Floor, Resource } from '../../lib/floor';
import { parseINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';
import { ProfilePictures, UpiSetup, type UpiForm } from '../settings/CentreProfile';
import { FloorMap } from '../floor/FloorMap';
import { useFloorState } from '../floor/useFloor';
import { TeamPage } from '../team/TeamPage';

const STEPS = ['Your centre', 'What you have', 'Your floor', 'Payments', 'Team', 'Done'] as const;

export function SetupPage() {
  const [params, setParams] = useSearchParams();
  const step = Math.min(STEPS.length, Math.max(1, Number(params.get('step')) || 1));
  const go = (n: number) => { setParams({ step: String(n) }); window.scrollTo({ top: 0 }); };
  return (
    <div className="setup stack xl" data-testid="setup">
      <div className="stack">
        <p className="book-eyebrow">Set up your arena · step {step} of {STEPS.length}</p>
        <ol className="setup-steps" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i + 1 === step ? 'now' : i + 1 < step ? 'done' : ''}>
              <button type="button" onClick={() => go(i + 1)} aria-current={i + 1 === step ? 'step' : undefined}>
                <span className="n">{i + 1 < step ? <Check size={14} /> : i + 1}</span><span className="t">{s}</span></button>
            </li>
          ))}
        </ol>
      </div>
      {step === 1 && <CentreStep onNext={() => go(2)} />}
      {step === 2 && <ItemsStep onBack={() => go(1)} onNext={() => go(3)} />}
      {step === 3 && <FloorStep onBack={() => go(2)} onNext={() => go(4)} />}
      {step === 4 && <PayStep onBack={() => go(3)} onNext={() => go(5)} />}
      {step === 5 && <TeamStep onBack={() => go(4)} onNext={() => go(6)} />}
      {step === 6 && <DoneStep onBack={() => go(5)} />}
    </div>
  );
}

function Nav({ onBack, onNext, nextLabel = 'Next', busy, disabled }: { onBack?: () => void; onNext: () => void; nextLabel?: string; busy?: boolean; disabled?: boolean }) {
  return (
    <div className="setup-nav">
      {onBack ? <button type="button" className="btn" onClick={onBack}><ChevronLeft size={18} /> Back</button> : <span />}
      <button type="button" className="btn primary xl" data-testid="setup-next" disabled={busy || disabled} onClick={onNext}>
        {busy ? <span className="spinner" /> : <>{nextLabel} <ChevronRight size={18} /></>}</button>
    </div>
  );
}

/* 1 ── Centre details */
function CentreStep({ onNext }: { onNext: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: centre.name, phone: centre.phone ?? '', address: centre.address ?? '', city: centre.city ?? '',
    open: centre.open_time.slice(0, 5), close: centre.close_time.slice(0, 5) });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: async () => {
      if (f.name.trim().length < 2) throw new Error('Enter your centre name');
      if (!/^[0-9+ -]{10,15}$/.test(f.phone.trim())) throw new Error('Enter a phone number customers can call');
      if (f.open === f.close) throw new Error('Opening and closing time cannot be the same');
      const { error } = await supabase.from('centres').update({ name: f.name.trim(), phone: f.phone.trim(), address: f.address.trim() || null,
        city: f.city.trim() || null, open_time: f.open, close_time: f.close, updated_at: new Date().toISOString() }).eq('id', centre.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ['centre'] });
    },
    onSuccess: onNext,
  });
  return (
    <section className="card stack lg">
      <div><h1>Welcome to XS Arena 👋</h1><p className="muted">Six short steps and your centre is ready. You can change everything later in Settings.</p></div>
      <div className="grid-2">
        <Field label="Centre name"><input className="input" value={f.name} onChange={set('name')} data-testid="setup-name" /></Field>
        <Field label="Phone (customers call this)"><input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} data-testid="setup-phone" placeholder="98470 12345" /></Field>
      </div>
      <div className="grid-2">
        <Field label="Address"><input className="input" value={f.address} onChange={set('address')} placeholder="Building, road" /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={set('city')} placeholder="Kochi" /></Field>
      </div>
      <div className="grid-2">
        <Field label="Opens"><input className="input" type="time" value={f.open} onChange={set('open')} /></Field>
        <Field label="Closes"><input className="input" type="time" value={f.close} onChange={set('close')} /></Field>
      </div>
      <div className="stack"><b>Logo and cover photo <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></b><ProfilePictures /></div>
      {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
      <Nav onNext={() => save.mutate()} busy={save.isPending} />
    </section>
  );
}

/* 2 ── What's in your arena */
type Pick = { count: number; price: string };
type Custom = { name: string; kind: Activity['kind']; price: string; count: number };

function ItemsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const { data, isPending } = useFloorState();
  const onFloor = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data?.resources ?? []) {
      const a = data?.activities.find((x) => x.id === r.activity_id);
      if (a?.active) m.set(a.name.toLowerCase(), (m.get(a.name.toLowerCase()) ?? 0) + 1);
    }
    return m;
  }, [data]);
  const [picks, setPicks] = useState<Record<string, Pick> | null>(null);
  const [custom, setCustom] = useState<Custom[]>([]);
  const [adding, setAdding] = useState<Custom | null>(null);
  // start from what's already on the floor (owner came back to this step), else nothing picked
  const cur = picks ?? Object.fromEntries(CATALOGUE.map((c) => {
    const a = data?.activities.find((x) => x.name.toLowerCase() === c.name.toLowerCase() && x.active);
    const price = a?.rate_card && onFloor.get(c.name.toLowerCase()) ? a.rate_card.price_paise : c.card.price_paise;
    return [c.key, { count: onFloor.get(c.name.toLowerCase()) ?? 0, price: String(price / 100) }];
  }));
  const setPick = (k: string, p: Partial<Pick>) => setPicks({ ...cur, [k]: { ...cur[k], ...p } });
  const chosen = CATALOGUE.filter((c) => cur[c.key]?.count > 0);
  const total = chosen.reduce((s, c) => s + cur[c.key].count, 0) + custom.reduce((s, c) => s + c.count, 0);

  const save = useMutation({
    mutationFn: async () => {
      const items: { item: CatalogueItem; count: number }[] = chosen.map((c) => {
        const paise = parseINR(cur[c.key].price);
        if (paise == null || paise < 0) throw new Error(`Enter a price for ${c.name}`);
        return { item: { ...c, card: { ...c.card, price_paise: paise } }, count: cur[c.key].count };
      });
      for (const x of custom) {
        const paise = parseINR(x.price);
        if (paise == null) throw new Error(`Enter a price for ${x.name}`);
        items.push({ count: x.count, item: {
          key: `custom-${x.name}`, name: x.name.trim(), kind: x.kind, icon: 'circle', color: '#6B7A8F', group: 'other', unit: 'item', units: 'items',
          size: x.kind === 'track' ? { w: 700, h: 450, shape: 'round' } : { w: 200, h: 120, shape: 'rect' }, capacity: 4,
          card: { billing_mode: 'per_minute', price_paise: paise, min_minutes: 30, grace_minutes: 5, per_player: false, included_players: 4 },
          itemName: (n) => `${x.name.trim()} ${n}`,
        } });
      }
      if (!items.length) throw new Error('Pick at least one thing your arena has');
      const ids = await rpc<Record<string, string>>('setup_arena', { p_centre: centre.id, p_items: items.map(({ item }) => ({
        name: item.name, kind: item.kind, icon: item.icon, color: item.color, card: item.card })) });
      // draw the floor only if the counts changed (coming back without changes keeps a hand-arranged floor)
      const same = items.every(({ item, count }) => onFloor.get(item.name.toLowerCase()) === count)
        && [...onFloor.values()].reduce((a, b) => a + b, 0) === items.reduce((a, b) => a + b.count, 0);
      if (!same) {
        const floor = data?.floors[0];
        if (!floor) throw new Error('No hall found. Reload and try again.');
        const lay = layoutItems(items.map(({ item, count }) => ({ item, count, activityId: ids[item.name] })), floor);
        await rpc('save_floor', { p_centre: centre.id, p_floor: {
          id: floor.id, version: floor.version, name: floor.name, width: lay.width, height: lay.height,
          outline: [[0, 0], [lay.width, 0], [lay.width, lay.height], [0, lay.height]], fixtures: floor.fixtures,
          resources: lay.resources.map((r) => ({ ...r, rotation: 0, points: null, online_bookable: true, status: 'active' })),
        } });
      }
      await qc.invalidateQueries({ queryKey: ['floor', centre.id] });
      await qc.invalidateQueries({ queryKey: ['centre'] });
    },
    onSuccess: onNext,
  });

  if (isPending) return <Loading rows={6} />;
  const groups = [...new Set(CATALOGUE.map((c) => c.group))] as CatalogueGroup[];
  return (
    <section className="stack lg">
      <div className="card stack">
        <h1>What's in your arena?</h1>
        <p className="muted" style={{ margin: 0 }}>Tap + for each thing your arena has. Prices are filled in with typical Kerala rates. Change them to yours.</p>
      </div>
      {groups.map((g) => (
        <div key={g} className="stack">
          <h2 className="setup-group">{GROUP_LABEL[g]}</h2>
          <div className="setup-grid">
            {CATALOGUE.filter((c) => c.group === g).map((c) => {
              const p = cur[c.key]; const on = p.count > 0;
              return (
                <div key={c.key} className={`setup-item card${on ? ' on' : ''}`} data-testid={`pick-${c.key}`}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div className="stack" style={{ gap: 2 }}>
                      <b><span className="dot" style={{ background: c.color }} />{c.name}</b>
                      {c.hint && <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>{c.hint}</span>}
                    </div>
                    <div className="row stepper">
                      <button type="button" className="btn small icon-btn" aria-label={`Fewer ${c.name}`} disabled={!on} onClick={() => setPick(c.key, { count: p.count - 1 })}><Minus size={16} /></button>
                      <b className="num" aria-label={`${c.name} count`}>{p.count}</b>
                      <button type="button" className="btn small icon-btn" aria-label={`More ${c.name}`} onClick={() => setPick(c.key, { count: Math.min(40, p.count + 1) })}><Plus size={16} /></button>
                    </div>
                  </div>
                  {on && (
                    <label className="row setup-price">
                      <span>₹</span>
                      <input className="input num" inputMode="decimal" value={p.price} aria-label={`${c.name} price`} data-testid={`price-${c.key}`}
                        onChange={(e) => setPick(c.key, { price: e.target.value })} />
                      <span className="muted">{priceLabel(c.card, c.kind)} · {p.count} {p.count === 1 ? c.unit : c.units}</span>
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="stack">
        <h2 className="setup-group">Something else?</h2>
        {custom.map((x, i) => (
          <div key={i} className="card row" style={{ justifyContent: 'space-between' }}>
            <span><b>{x.name}</b> × {x.count} · ₹{x.price} per hour</span>
            <button type="button" className="btn small ghost" onClick={() => setCustom(custom.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        {adding ? (
          <div className="card stack">
            <div className="grid-2">
              <Field label="Name"><input className="input" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Bowling lane" autoFocus /></Field>
              <Field label="Type"><select className="input" value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as Activity['kind'] })}>
                <option value="table">Table</option><option value="console">Console / station</option><option value="track">Track</option><option value="other">Other</option></select></Field>
              <Field label="Price per hour (₹)"><input className="input num" inputMode="decimal" value={adding.price} onChange={(e) => setAdding({ ...adding, price: e.target.value })} /></Field>
              <Field label="How many"><input className="input num" inputMode="numeric" value={adding.count} onChange={(e) => setAdding({ ...adding, count: Math.max(1, Math.min(40, Number(e.target.value) || 1)) })} /></Field>
            </div>
            <div className="row">
              <button type="button" className="btn primary" disabled={adding.name.trim().length < 2 || parseINR(adding.price) == null
                || [...CATALOGUE.map((c) => c.name), ...custom.map((c) => c.name)].some((n) => n.toLowerCase() === adding.name.trim().toLowerCase())}
                onClick={() => { setCustom([...custom, adding]); setAdding(null); }}>Add</button>
              <button type="button" className="btn ghost" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          </div>
        ) : <button type="button" className="btn" style={{ justifySelf: 'start' }} onClick={() => setAdding({ name: '', kind: 'table', price: '', count: 1 })}><Plus size={16} /> Add your own</button>}
      </div>
      {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
      <div className="card"><Nav onBack={onBack} onNext={() => save.mutate()} busy={save.isPending} disabled={!total}
        nextLabel={total ? `Save ${total} item${total === 1 ? '' : 's'}` : 'Pick what you have'} /></div>
    </section>
  );
}

/* 3 ── Floor, drawn for them */
function FloorStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { centre } = useCentre();
  const { data, isPending } = useFloorState();
  if (isPending || !data) return <Loading rows={6} />;
  const floor: Floor | undefined = data.floors[0];
  const resources = data.resources.filter((r) => r.floor_id === floor?.id) as Resource[];
  return (
    <section className="card stack lg">
      <div><h1>Your floor</h1>
        <p className="muted" style={{ margin: 0 }}>We drew your hall with everything you picked ({resources.length} item{resources.length === 1 ? '' : 's'}).
          Staff tap these to start games. To match your real hall, drag things into place in the Floor designer now or any time later.</p></div>
      {floor && resources.length
        ? <div className="setup-floor"><FloorMap floor={floor} resources={resources} activities={data.activities} mode="live" showMoney={false} /></div>
        : <Notice tone="warn">Nothing on the floor yet. Go back and pick what you have.</Notice>}
      <Link className="btn" style={{ justifySelf: 'start' }} to={`/s/${centre.slug}/designer`}>Arrange in Floor designer</Link>
      <Nav onBack={onBack} onNext={onNext} disabled={!resources.length} />
    </section>
  );
}

/* 4 ── Payments: their own UPI QR */
function PayStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const [f, setF] = useState<UpiForm>({ upi_id: centre.upi_id ?? '', upi_payee: centre.upi_payee ?? '', upi_mode: centre.upi_mode ?? 'amount' });
  const save = useMutation({
    mutationFn: async () => {
      const id = f.upi_id.trim();
      if (id && !/^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/.test(id)) throw new Error('UPI ID looks invalid (example: arena@okicici)');
      if (f.upi_mode === 'amount' && !id && centre.upi_qr_path) throw new Error('Add your UPI ID for exact-amount QRs, or choose "My uploaded QR"');
      const { error } = await supabase.from('centres').update({ upi_id: id || null, upi_payee: f.upi_payee.trim() || null,
        upi_mode: f.upi_mode === 'own' && centre.upi_qr_path ? 'own' : 'amount', updated_at: new Date().toISOString() }).eq('id', centre.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ['centre'] });
    },
    onSuccess: onNext,
  });
  return (
    <section className="card stack lg">
      <div><h1>Get paid by UPI</h1>
        <p className="muted" style={{ margin: 0 }}>Upload the UPI QR you already use (GPay, PhonePe, Paytm or your bank). Customers pay straight into your account; XS Arena never touches the money.</p></div>
      <UpiSetup f={f} onChange={(p) => setF((c) => ({ ...c, ...p }))} />
      <div className="grid-2">
        <Field label="UPI ID" hint="Filled in from your QR"><input className="input" value={f.upi_id} data-testid="upi-id" autoCapitalize="none"
          onChange={(e) => setF({ ...f, upi_id: e.target.value })} placeholder="yourcentre@okaxis" /></Field>
        <Field label="Name customers see when paying"><input className="input" value={f.upi_payee} onChange={(e) => setF({ ...f, upi_payee: e.target.value })} placeholder={centre.name} /></Field>
      </div>
      {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
      <Nav onBack={onBack} onNext={() => save.mutate()} busy={save.isPending} nextLabel={f.upi_id || centre.upi_qr_path ? 'Next' : 'Skip for now'} />
    </section>
  );
}

/* 5 ── Team */
function TeamStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  return (
    <section className="card stack lg">
      <div><h1>Add your staff</h1>
        <p className="muted" style={{ margin: 0 }}>Each staff member gets their own username and password. Send it to them on WhatsApp. Front desk staff can run games and bills but can't change prices or settings.</p></div>
      <TeamPage embedded />
      <Nav onBack={onBack} onNext={onNext} nextLabel="Next" />
    </section>
  );
}

/* 6 ── Done */
function DoneStep({ onBack }: { onBack: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const done = useQuery({
    queryKey: ['setup-done', centre.id],
    queryFn: async () => { await rpc('complete_onboarding', { p_centre: centre.id }); await qc.invalidateQueries({ queryKey: ['centre'] }); return true; },
    staleTime: Infinity,
  });
  const link = `${window.location.origin}/b/${centre.slug}`;
  // The owner chooses here: the guide doesn't pop up by itself over their first game ("How to use" is always in the menu).
  const finish = async (to: string, guide = false) => {
    await rpc('mark_guide_seen', { p_centre: centre.id }).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['centre'] });
    nav(to);
    if (guide) window.setTimeout(() => window.dispatchEvent(new CustomEvent('xs-guide')), 500);
  };
  return (
    <section className="card stack lg" data-testid="setup-done">
      <div className="row" style={{ gap: 12 }}><Sparkles size={28} /><h1>You're ready!</h1></div>
      {done.error && <Notice tone="bad">{errorMessage(done.error)}</Notice>}
      <div className="stack">
        <b>Your online booking page</b>
        <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>Share this on WhatsApp and Instagram. Customers pick a game and time; you see it in Bookings.</span>
        <div className="row wrap">
          <code className="setup-link" data-testid="setup-link">{link.replace(/^https?:\/\//, '')}</code>
          <button type="button" className="btn small" onClick={() => void navigator.clipboard.writeText(link).then(() => toast('Link copied'), () => undefined)}><Copy size={16} /> Copy</button>
          <a className="btn small" href={link} target="_blank" rel="noreferrer">Open</a>
        </div>
      </div>
      <div className="setup-final">
        <button type="button" className="btn primary xl" disabled={done.isPending} onClick={() => void finish(`/s/${centre.slug}/floor`)}>Start your first game</button>
        <button type="button" className="btn xl" disabled={done.isPending} onClick={() => void finish(`/s/${centre.slug}`, true)}>Show me how XS Arena works</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 'var(--t-sm)' }}>Later: GST and bill settings, booking rules, loyalty points and TV display are in Settings. Prices per time of day are in Prices.</p>
      <div><button type="button" className="btn ghost" onClick={onBack}><ChevronLeft size={18} /> Back</button></div>
    </section>
  );
}
