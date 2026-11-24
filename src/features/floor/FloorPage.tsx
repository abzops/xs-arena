// Live floor: every table, console and track with live timers. Tap one to start, pause, extend, move, bill.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CalendarCheck, CirclePause, CirclePlay, Clock, MoveRight, Plus, QrCode, Receipt, Smartphone, Sparkles, Square, Users, WifiOff, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useCentre } from '../../app/centre';
import { ReasonSheet, WhatsAppPairButton } from '../../components/centre';
import { Empty, Field, Loading, Notice, Segmented, Sheet, useToast } from '../../components/ui';
import { command, usePendingCommands } from '../../lib/commands';
import { formatTime } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import {
  clock, minutesLabel, playedSeconds, priceSummary, timerText, toneOf, TONE_LABEL, useNow, uid,
  type Activity, type FloorState, type Resource, type Tone, type WaitEntry,
} from '../../lib/floor';
import { msgReady, msgStarted, msgTimeUp } from '../../lib/messages';
import { formatINR } from '../../lib/money';
import { currentPush, disablePush, enablePush, pushSupported } from '../../lib/push';
import { rpc } from '../../lib/supabase';
import { BillSheet, useKnownCustomer } from '../billing/BillSheet';
import { AiSheet } from '../ai/AiSheet';
import { CheckInSheet, SeatSheet } from '../booking/BookingsPage';
import { durationLabel, type Booking } from '../booking/types';
import { FloorMap, TONE_FILL } from './FloorMap';
import { useFloorState } from './useFloor';
import './floor.css';

type View = 'map' | 'list';
const VIEW_KEY = 'xs-arena-floor-view';
const SOUND_KEY = 'xs-arena-alert-sound';

export function FloorPage() {
  const { centre, can, hasFeature } = useCentre();
  const state = useFloorState();
  const now = useNow();
  const pending = usePendingCommands();
  const [view, setViewState] = useState<View>(() => (localStorage.getItem(VIEW_KEY) as View) || (window.innerWidth < 720 ? 'list' : 'map'));
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const [floorId, setFloorId] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [bill, setBill] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [tabs, setTabs] = useState(false);
  const [checkIn, setCheckIn] = useState(false);
  const [params, setParams] = useSearchParams();
  const [ai, setAiState] = useState(() => params.get('ai') === '1');
  const aiParam = params.get('ai') === '1';
  useEffect(() => { if (aiParam) setAiState(true); }, [aiParam]);
  const setAi = (v: boolean) => { setAiState(v); if (!v && params.has('ai')) { params.delete('ai'); setParams(params, { replace: true }); } };
  const [seat, setSeat] = useState<Parameters<typeof SeatSheet>[0]['data'] | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const data = state.data;
  const alerts = useAlerts(data, state.snapshotAt, now);

  if (state.isPending) return <Loading rows={6} />;
  if (state.error && !data) return <Notice tone="bad">{errorMessage(state.error)}</Notice>;
  if (!data) return null;
  const floors = data.floors;
  const floor = floors.find((f) => f.id === floorId) ?? floors[0];
  const act = (id: string) => data.activities.find((a) => a.id === id);
  const tones = data.resources.map((r) => toneOf(r, r.session ? playedSeconds(r.session, state.snapshotAt, now) : 0));
  const count = (t: Tone[]) => tones.filter((x) => t.includes(x)).length;
  const selected = data.resources.find((r) => r.id === open) ?? null;

  if (!data.resources.length) {
    return (
      <div className="stack lg">
        <div className="page-head"><h1>Floor</h1></div>
        <div className="card"><Empty title="Your floor is empty">
          {can('floor.design') ? <><p className="muted">Draw your hall and add your tables, consoles and tracks.</p>
            <Link className="btn primary" to={`/s/${centre.slug}/designer`}>Open floor designer</Link></>
            : <p className="muted">Ask the owner to set up the floor.</p>}
        </Empty></div>
      </div>
    );
  }

  return (
    <div className="floor-page">
      {(!online || pending > 0) && (
        <div className="offline-bar"><Notice tone="warn"><WifiOff size={16} style={{ verticalAlign: -3 }} /> {online ? `Sending ${pending} saved action${pending === 1 ? '' : 's'}…` : `Offline. Timers keep running${pending ? `; ${pending} action${pending === 1 ? '' : 's'} will sync` : ''}.`}</Notice></div>
      )}
      <div className="floor-top">
        <div className="floor-counts">
          <span className="pill" style={{ background: 'var(--ok-bg)', color: 'var(--ok)' }}>{count(['free'])} free</span>
          <span className="pill" style={{ background: 'var(--info-bg)', color: 'var(--info)' }}>{count(['playing', 'paused', 'soon', 'over'])} playing</span>
          {count(['over']) > 0 && <span className="pill" style={{ background: 'var(--bad-bg)', color: 'var(--bad)' }}>{count(['over'])} time's up</span>}
        </div>
        <div className="row">
          {hasFeature('xs_ai') && <button className="btn small" onClick={() => setAi(true)}><Sparkles size={16} /> XS AI</button>}
          <button className="btn small" onClick={() => setCheckIn(true)}><QrCode size={16} /> Check in</button>
          <button className="btn small" onClick={() => setWaiting(true)}><Users size={16} /> Waiting {data.waitlist.length ? `(${data.waitlist.length})` : ''}</button>
          <button className="btn small" onClick={() => setTabs(true)}><Receipt size={16} /> Open bills {data.open_tabs.length ? `(${data.open_tabs.length})` : ''}</button>
          <Segmented label="View" value={view} onChange={setView} options={[{ value: 'map', label: 'Map' }, { value: 'list', label: 'List' }]} />
        </div>
      </div>
      {floors.length > 1 && view === 'map' && (
        <div className="floor-tabs">{floors.map((f) => <button key={f.id} className="chip" aria-pressed={f.id === floor.id} onClick={() => setFloorId(f.id)}>{f.name}</button>)}</div>
      )}

      <UpcomingBookings bookings={data.bookings ?? []} tz={centre.timezone} now={now} onSeat={setSeat} />

      {view === 'map' ? (
        <>
          <div className="floor-stage">
            <FloorMap floor={floor} resources={data.resources.filter((r) => r.floor_id === floor.id)} activities={data.activities} mode="live"
              snapshotAt={state.snapshotAt} now={now} onSelect={(id) => id && setOpen(id)} />
          </div>
          <Legend />
        </>
      ) : (
        <div className="stack lg">
          {data.activities.filter((a) => data.resources.some((r) => r.activity_id === a.id)).map((a) => (
            <section key={a.id} className="res-group">
              <h2>{a.name} <span className="muted" style={{ fontWeight: 400, fontSize: 'var(--t-sm)' }}>{priceSummary(a.rate_card)}</span></h2>
              <div className="res-list">
                {data.resources.filter((r) => r.activity_id === a.id).map((r) => <ResCard key={r.id} r={r} snapshotAt={state.snapshotAt} now={now} onOpen={() => setOpen(r.id)}
                  freeUntil={a.free_until ? formatTime(a.free_until, centre.timezone) : null} />)}
              </div>
            </section>
          ))}
        </div>
      )}

      {alerts.length > 0 && (
        <div className="alert-stack" role="status">
          {alerts.slice(0, 3).map((a) => (
            <div key={a.key} className={`notice ${a.tone}`} style={{ cursor: 'pointer' }} onClick={() => { setOpen(a.resourceId); a.dismiss(); }}>
              <Clock size={18} /><div><b>{a.title}</b><br /><span className="muted">{a.body}</span>
                {a.extend && <ExtendButtons sessionId={a.sessionId} onDone={a.dismiss} onBlocked={() => setOpen(a.resourceId)} />}</div>
              <button className="btn small ghost icon-btn" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); a.dismiss(); }}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {selected && <ResourceSheet r={selected} a={act(selected.activity_id)} data={data} snapshotAt={state.snapshotAt}
        onClose={() => setOpen(null)} onBill={(tab) => { setOpen(null); setBill(tab); }} />}
      {bill && <BillSheet tabId={bill} onClose={() => setBill(null)} />}
      {waiting && <WaitlistSheet data={data} onClose={() => setWaiting(false)} />}
      {ai && <AiSheet data={data} onClose={() => setAi(false)} />}
      {checkIn && <CheckInSheet onClose={() => setCheckIn(false)} onFound={(c) => { setCheckIn(false); setSeat(c); }} />}
      {seat && <SeatSheet data={seat} onClose={() => setSeat(null)} />}
      {tabs && <OpenTabsSheet data={data} onClose={() => setTabs(false)} onOpen={(t) => { setTabs(false); setBill(t); }} />}
    </div>
  );
}

/** Arrived, late and soon-due bookings, so the desk can seat them in one tap. */
function UpcomingBookings({ bookings, tz, now, onSeat }: { bookings: Booking[]; tz: string; now: number; onSeat: (c: Parameters<typeof SeatSheet>[0]['data']) => void }) {
  const { centre } = useCentre();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const soon = bookings.filter((b) => b.status === 'arrived' || b.status === 'late' || new Date(b.starts_at).getTime() - now < 60 * 60_000);
  if (!soon.length) return null;
  const open = async (b: Booking) => {
    setBusy(b.id);
    try { onSeat(await rpc('check_in_booking', { p_centre: centre.id, p_code_or_token: b.code })); }
    catch (e) { toast(errorMessage(e)); } finally { setBusy(null); }
  };
  return (
    <div className="upcoming" role="region" aria-label="Bookings due">
      <span className="upcoming-label"><CalendarCheck size={16} /> Bookings</span>
      {soon.map((b) => (
        <button key={b.id} className={`upcoming-card st-${b.status}`} disabled={busy === b.id} onClick={() => open(b)}>
          <b>{formatTime(b.starts_at, tz)} · {b.name}</b>
          <span>{b.activity} · {durationLabel(b.minutes)} · {b.party_size} pl</span>
          <span className="upcoming-cta">{b.status === 'arrived' ? 'Arrived — seat' : b.status === 'late' ? 'Late — check in' : 'Check in'}</span>
        </button>
      ))}
    </div>
  );
}

function Legend() {
  const items: [Tone, string][] = [['free', 'Free'], ['playing', 'Playing'], ['paused', 'Paused'], ['soon', '5 min left'], ['over', "Time's up"], ['off', 'Out of service']];
  return <div className="floor-legend">{items.map(([t, l]) => <span key={t}><i style={{ background: TONE_FILL[t] }} />{l}</span>)}</div>;
}

function ResCard({ r, snapshotAt, now, onOpen, freeUntil }: { r: Resource; snapshotAt: number; now: number; onOpen: () => void; freeUntil?: string | null }) {
  const s = r.session;
  const played = s ? playedSeconds(s, snapshotAt, now) : 0;
  const tone = toneOf(r, played);
  return (
    <button className={`res-card tone-${tone}`} style={{ background: TONE_FILL[tone] }} onClick={onOpen} aria-label={`${r.name}, ${TONE_LABEL[tone]}`}>
      <span className="rc-top"><span>{r.name}</span><span>{TONE_LABEL[tone]}</span></span>
      <span className="rc-timer">{tone === 'off' ? '—' : s ? timerText(s, played) : 'Free'}</span>
      <span className="rc-sub">
        <span>{s ? [s.customer?.name?.split(' ')[0], `${s.players} pl`].filter(Boolean).join(' · ') : freeUntil ? `Free until ${freeUntil}` : `Up to ${r.capacity} players`}</span>
        <span className="num">{s?.cost_paise != null ? formatINR(s.cost_paise) : ''}</span>
      </span>
    </button>
  );
}

/** One-tap extension from an alert. Checks bookings first; if time is booked, opens the table to show the options. */
function ExtendButtons({ sessionId, onDone, onBlocked }: { sessionId: string; onDone: () => void; onBlocked: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async (m: number) => {
    setBusy(true);
    try {
      try {
        const c = await rpc<{ ok: boolean; max_minutes: number; booked_at: string | null }>('extension_check', { p_centre: centre.id, p_session: sessionId, p_minutes: m });
        if (!c.ok) {
          toast(c.max_minutes > 0 ? `Booked${c.booked_at ? ` from ${formatTime(c.booked_at, centre.timezone)}` : ''} — up to ${c.max_minutes} min fits` : 'Booked next — no more time on this table');
          onBlocked(); return;
        }
      } catch { /* offline: the server re-checks when the command syncs */ }
      await command('extend_session', { p_centre: centre.id, p_session: sessionId, p_minutes: m });
      await qc.invalidateQueries({ queryKey: ['floor', centre.id] });
      toast(`Added ${m >= 60 ? `${m / 60}h` : `${m}m`}`); onDone();
    } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <span className="extend-row" onClick={(e) => e.stopPropagation()}>
      {[15, 30, 60].map((m) => <button key={m} className="chip" disabled={busy} onClick={() => go(m)}>+{m >= 60 ? '1h' : `${m}m`}</button>)}
    </span>
  );
}

/** 15-minute "extend?" prompt, 5-minute and time's-up alerts for fixed-time games, with an optional beep and phone notification. */
function useAlerts(data: FloorState | undefined, snapshotAt: number, now: number) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const fired = useRef<Set<string>>(new Set());
  const list = useMemo(() => {
    if (!data) return [];
    const out: { key: string; resourceId: string; sessionId: string; tone: 'warn' | 'bad' | 'info'; title: string; body: string; extend?: boolean }[] = [];
    for (const r of data.resources) {
      const s = r.session;
      if (!s?.planned_minutes || s.status !== 'running') continue;
      const left = s.planned_minutes * 60 - playedSeconds(s, snapshotAt, now);
      if (left <= 0) out.push({ key: `${s.id}:over:${s.planned_minutes}`, resourceId: r.id, sessionId: s.id, tone: 'bad', title: `${r.name}: time's up`, body: `${clock(-left)} over${s.customer ? ` · ${s.customer.name}` : ''}` });
      else if (left <= 300) out.push({ key: `${s.id}:soon:${s.planned_minutes}`, resourceId: r.id, sessionId: s.id, tone: 'warn', title: `${r.name}: ${Math.ceil(left / 60)} min left`, body: s.customer?.name ?? 'Walk-in', extend: true });
      // 15 minutes before the end: ask the players if they want more time (quiet: no beep)
      else if (left <= 900 && s.planned_minutes > 20) out.push({ key: `${s.id}:extend:${s.planned_minutes}`, resourceId: r.id, sessionId: s.id, tone: 'info', title: `${r.name}: ${Math.ceil(left / 60)} min left — extend?`, body: s.customer?.name ?? 'Walk-in', extend: true });
    }
    return out;
  }, [data, snapshotAt, now]);
  useEffect(() => {
    for (const a of list) {
      if (fired.current.has(a.key)) continue;
      fired.current.add(a.key);
      if (a.tone === 'info') continue;
      if (localStorage.getItem(SOUND_KEY) === '1') beep(a.tone === 'bad' ? 2 : 1);
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        try { new Notification(a.title, { body: a.body, tag: a.key }); } catch { /* not allowed here */ }
      }
    }
  }, [list]);
  return list.filter((a) => !dismissed.has(a.key)).map((a) => ({ ...a, dismiss: () => setDismissed((d) => new Set(d).add(a.key)) }));
}

function beep(times: number) {
  try {
    const ctx = new AudioContext();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.35;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.start(t); o.stop(t + 0.3);
    }
  } catch { /* audio blocked */ }
}

export function AlertSettings() {
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) === '1');
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  return (
    <div className="stack">
      <label className="check-row" style={{ padding: 0 }}><input type="checkbox" checked={sound}
        onChange={(e) => { setSound(e.target.checked); try { localStorage.setItem(SOUND_KEY, e.target.checked ? '1' : '0'); } catch { /* ignore */ } if (e.target.checked) beep(1); }} />
        <span className="grow">{sound ? <Bell size={16} /> : <BellOff size={16} />} Beep on this device when time is almost up</span></label>
      {pushSupported() ? <PhoneAlerts onPerm={setPerm} /> : 'Notification' in window && perm !== 'granted' && (
        <button className="btn small" style={{ justifySelf: 'start' }} disabled={perm === 'denied'}
          onClick={() => Notification.requestPermission().then(setPerm)}>{perm === 'denied' ? 'Notifications blocked in browser settings' : 'Allow phone notifications'}</button>
      )}
    </div>
  );
}

/** Web push: alerts reach this phone even when the app is closed. */
function PhoneAlerts({ onPerm }: { onPerm: (p: NotificationPermission) => void }) {
  const { centre, can } = useCentre();
  const toast = useToast();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { currentPush().then((s) => setOn(!!s)).catch(() => setOn(false)); }, []);
  if (!can('floor.operate')) return null;
  const blocked = Notification.permission === 'denied';
  const toggle = async (want: boolean) => {
    setBusy(true);
    try {
      if (want) {
        const ok = await enablePush(centre.id);
        onPerm(Notification.permission);
        setOn(ok);
        toast(ok ? 'Phone alerts on for this device' : 'Notifications were not allowed');
      } else { await disablePush(); setOn(false); toast('Phone alerts off for this device'); }
    } catch { toast('Could not change phone alerts. Try again.'); }
    finally { setBusy(false); }
  };
  return (
    <label className="check-row" style={{ padding: 0 }}>
      <input type="checkbox" checked={!!on} disabled={busy || on === null || (blocked && !on)} onChange={(e) => toggle(e.target.checked)} />
      <span className="grow"><Smartphone size={16} /> {blocked && !on ? 'Phone alerts blocked in browser settings' : 'Phone alerts — 5 min left and time\'s up, even when the app is closed'}</span>
    </label>
  );
}

/* ────────────────────────── One table / console / track ────────────────────────── */
type ExtCheck = { ok: boolean; max_minutes: number; booked_at: string | null; alternatives: { activity_id: string; name: string; free: number }[] };
function ResourceSheet({ r, a, data, snapshotAt, onClose, onBill }: {
  r: Resource; a: Activity | undefined; data: FloorState; snapshotAt: number; onClose: () => void; onBill: (tab: string) => void;
}) {
  const { centre, can } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const [voiding, setVoiding] = useState(false);
  const [moving, setMoving] = useState(false);
  const [blocked, setBlocked] = useState<ExtCheck | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['floor', centre.id] });
  const run = useMutation({
    mutationFn: async (x: { fn: string; args: Record<string, unknown>; ok?: string }) => { const r = await command(x.fn, { p_centre: centre.id, ...x.args }); return { r, ok: x.ok }; },
    onSuccess: async ({ r, ok }) => { await refresh(); if (ok) toast(r === null ? `${ok} (will sync)` : ok); },
  });
  const s = r.session;
  const rc = a?.rate_card ?? null;
  const title = `${r.name}${a ? ` · ${a.name}` : ''}`;

  if (r.status === 'out_of_service') {
    return (
      <Sheet title={title} onClose={onClose}>
        <div className="stack lg">
          <Notice tone="warn">This {a?.kind ?? 'table'} is out of service.</Notice>
          {can('pricing.manage') && <button className="btn primary block xl" onClick={() => rpc('set_resource_status', { p_centre: centre.id, p_resource: r.id, p_status: 'active' }).then(refresh).then(onClose)}>Bring back into service</button>}
        </div>
      </Sheet>
    );
  }
  if (!s) return <StartSheet r={r} a={a} data={data} onClose={onClose} />;

  const played = playedSeconds(s, snapshotAt, now);
  const tone = toneOf(r, played);
  const left = s.planned_minutes ? s.planned_minutes * 60 - played : null;
  const endsAt = s.planned_minutes ? new Date(now + (left ?? 0) * 1000).toISOString() : null;
  const freeSame = data.resources.filter((x) => x.activity_id === r.activity_id && x.id !== r.id && !x.session && x.status === 'active');
  const go = (fn: string, args: Record<string, unknown>, ok?: string) => run.mutate({ fn, args: { p_session: s.id, ...args }, ok });
  // Smart extension: check bookings first; offline (check fails) the server re-checks when the command syncs.
  const extend = async (m: number) => {
    setBlocked(null);
    try {
      const c = await rpc<ExtCheck>('extension_check', { p_centre: centre.id, p_session: s.id, p_minutes: m });
      if (!c.ok) { setBlocked(c); return; }
    } catch { /* offline: let the queued command decide */ }
    go('extend_session', { p_minutes: m }, `Added ${minutesLabel(m)}`);
  };

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack lg">
        <div className="res-card" style={{ background: TONE_FILL[tone], cursor: 'default' }}>
          <span className="rc-top"><span>{TONE_LABEL[tone]}</span><span>Started {formatTime(s.started_at, centre.timezone)}</span></span>
          <span className="rc-timer">{timerText(s, played)}</span>
          <span className="rc-sub"><span>{s.planned_minutes ? `${minutesLabel(s.planned_minutes)} booked · played ${clock(played)}` : 'Open timer'}</span>
            <span className="num">{s.cost_paise != null ? formatINR(s.cost_paise) : ''}</span></span>
        </div>
        {s.customer && (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span><b>{s.customer.name}</b> <span className="muted">{s.customer.phone}</span></span>
            {s.customer.phone && (
              <WhatsAppPairButton phone={s.customer.phone} name={s.customer.name} label={left !== null && left <= 300 ? 'Time-up msg' : 'Start msg'}
                texts={left !== null && left <= 300 && endsAt
                  ? msgTimeUp({ name: s.customer.name, centre: centre.name, resource: r.name, endsAt, tz: centre.timezone })
                  : msgStarted({ name: s.customer.name, centre: centre.name, resource: r.name, startedAt: s.started_at, tz: centre.timezone, planned: s.planned_minutes, price: priceSummary(rc) })} />
            )}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>Players</span>
          <span className="row">
            <button className="btn small icon-btn" aria-label="Fewer players" disabled={s.players <= 1 || run.isPending} onClick={() => go('set_session_players', { p_players: s.players - 1 })}>−</button>
            <b className="num" style={{ minWidth: 24, textAlign: 'center' }}>{s.players}</b>
            <button className="btn small icon-btn" aria-label="More players" disabled={s.players >= r.capacity || run.isPending} onClick={() => go('set_session_players', { p_players: s.players + 1 })}>+</button>
          </span>
        </div>
        {rc?.billing_mode === 'per_frame' && (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>Frames</span>
            <span className="row">
              <button className="btn small icon-btn" disabled={s.frames <= 0} onClick={() => rpc('set_session_frames', { p_centre: centre.id, p_session: s.id, p_frames: s.frames - 1 }).then(refresh)}>−</button>
              <b className="num" style={{ minWidth: 24, textAlign: 'center' }}>{s.frames}</b>
              <button className="btn small icon-btn" onClick={() => rpc('set_session_frames', { p_centre: centre.id, p_session: s.id, p_frames: s.frames + 1 }).then(refresh)}>+</button>
            </span>
          </div>
        )}

        <div className="field"><span>Add time</span>
          <div className="chips">
            {(rc?.billing_mode === 'per_slot' ? [rc.slot_minutes, rc.slot_minutes * 2] : [15, 30, 60]).map((m) => (
              <button key={m} className="chip" disabled={run.isPending} onClick={() => extend(m)}>+{minutesLabel(m)}</button>
            ))}
          </div>
        </div>
        {blocked && (
          <Notice tone="warn">
            <b>{a?.name ?? 'This game'} is booked{blocked.booked_at ? ` from ${formatTime(blocked.booked_at, centre.timezone)}` : ''}.</b>{' '}
            {blocked.max_minutes > 0 ? `You can add up to ${minutesLabel(blocked.max_minutes)}.` : 'No more time can be added on this game.'}
            {blocked.alternatives.length > 0 && ` Free now: ${blocked.alternatives.map((x) => `${x.name} (${x.free})`).join(', ')}.`}
            {blocked.max_minutes > 0 && (
              <div style={{ marginTop: 8 }}><button className="btn small" onClick={() => { go('extend_session', { p_minutes: blocked.max_minutes }, `Added ${minutesLabel(blocked.max_minutes)}`); setBlocked(null); }}>
                Add {minutesLabel(blocked.max_minutes)}</button></div>
            )}
          </Notice>
        )}

        <div className="grid-2">
          {s.status === 'running'
            ? <button className="btn block" disabled={run.isPending} onClick={() => go('pause_session', {}, 'Paused')}><CirclePause size={18} /> Pause</button>
            : <button className="btn block" disabled={run.isPending} onClick={() => go('resume_session', {}, 'Resumed')}><CirclePlay size={18} /> Resume</button>}
          <button className="btn block" disabled={!freeSame.length} onClick={() => setMoving(true)}><MoveRight size={18} /> Move</button>
        </div>
        {run.error && <Notice tone="bad">{errorMessage(run.error)}</Notice>}

        <div className="grid-2">
          <button className="btn block" disabled={!s.tab_id} onClick={() => s.tab_id && onBill(s.tab_id)}><Receipt size={18} /> Bill / snacks</button>
          <button className="btn primary block" disabled={run.isPending} onClick={async () => {
            const res = await command<{ tab_id: string }>('end_session', { p_centre: centre.id, p_session: s.id }).catch((e) => { toast(errorMessage(e)); return undefined; });
            await refresh();
            if (res === undefined) return;
            if (res && s.tab_id) onBill(s.tab_id); else { toast('Game ended (will sync)'); onClose(); }
          }}><Square size={16} /> End & bill</button>
        </div>
        {can('billing.void') && <button className="btn ghost danger" style={{ justifySelf: 'start' }} onClick={() => setVoiding(true)}>Cancel game (started by mistake)</button>}
      </div>
      {moving && (
        <Sheet title={`Move ${r.name} to…`} onClose={() => setMoving(false)}>
          <div className="chips">{freeSame.map((x) => (
            <button key={x.id} className="chip" onClick={() => { go('transfer_session', { p_to_resource: x.id }, `Moved to ${x.name}`); setMoving(false); onClose(); }}>{x.name}</button>
          ))}</div>
        </Sheet>
      )}
      {voiding && <ReasonSheet title="Cancel game" confirmLabel="Cancel game" onClose={() => setVoiding(false)}
        warning={`The game on ${r.name} will be removed from the bill and nothing is charged for it. The owner can see who cancelled it and why.`}
        onConfirm={async (reason) => { await rpc('void_session', { p_centre: centre.id, p_session: s.id, p_reason: reason }); await refresh(); toast('Game cancelled'); onClose(); }} />}
    </Sheet>
  );
}

function StartSheet({ r, a, data, onClose, fromWait }: { r: Resource; a: Activity | undefined; data: FloorState; onClose: () => void; fromWait?: WaitEntry }) {
  const { centre, can } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const rc = a?.rate_card ?? null;
  const slot = rc?.billing_mode === 'per_slot';
  const [phone, setPhone] = useState(fromWait?.phone ?? '');
  const [name, setName] = useState(fromWait?.name ?? '');
  const [players, setPlayers] = useState(Math.min(r.capacity, fromWait?.party_size ?? (slot ? 1 : 2)));
  const [time, setTime] = useState<number | null>(slot ? rc!.slot_minutes : null);
  const [tab, setTab] = useState('');
  const [waitId, setWaitId] = useState<string | null>(fromWait?.id ?? null);
  const known = useKnownCustomer(phone);
  const waiters = data.waitlist.filter((w) => w.activity_id === r.activity_id);
  const start = useMutation({
    mutationFn: () => command<{ session_id: string }>('start_session', {
      p_centre: centre.id, p_session: uid(), p_resource: r.id, p_players: players, p_planned_minutes: time,
      p_phone: phone.replace(/\D/g, '').length >= 10 ? phone : null, p_name: name || known?.full_name || null, p_tab: tab || null,
      p_source: waitId ? 'waitlist' : 'walk_in', p_waitlist: waitId,
    }),
    onSuccess: async (res) => { await qc.invalidateQueries({ queryKey: ['floor', centre.id] }); toast(res === null ? `${r.name} will start when back online` : `${r.name} started`); onClose(); },
  });
  const times = slot ? [1, 2, 3, 4].map((n) => n * rc!.slot_minutes) : [30, 60, 90, 120];
  return (
    <Sheet title={`Start ${r.name}`} onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
        <p className="muted" style={{ margin: 0 }}>{a?.name} · {priceSummary(rc)}</p>
        {a?.free_until && (
          <Notice tone="warn">{a.name} is booked from {formatTime(a.free_until, centre.timezone)} — tell walk-ins they can play until then.</Notice>
        )}
        {waiters.length > 0 && !fromWait && (
          <div className="field"><span>From the waiting list</span>
            <div className="chips">{waiters.map((w) => (
              <button type="button" key={w.id} className="chip" aria-pressed={waitId === w.id}
                onClick={() => { setWaitId(waitId === w.id ? null : w.id); setPhone(w.phone ?? ''); setName(w.name); setPlayers(Math.min(r.capacity, w.party_size)); }}>
                {w.name} · {w.party_size}</button>))}</div></div>
        )}
        <div className="grid-2">
          <Field label="Mobile (for receipt & points)" hint={known ? `${known.full_name} · ${known.visit_count} visit${known.visit_count === 1 ? '' : 's'}` : 'Optional'}>
            <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98470 12345" autoFocus /></Field>
          {!known && <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" /></Field>}
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>{slot && a?.kind === 'track' ? 'Cars' : 'Players'}</span>
          <span className="row">
            <button type="button" className="btn small icon-btn" aria-label="Fewer" onClick={() => setPlayers(Math.max(1, players - 1))}>−</button>
            <b className="num" style={{ minWidth: 24, textAlign: 'center' }}>{players}</b>
            <button type="button" className="btn small icon-btn" aria-label="More" onClick={() => setPlayers(Math.min(r.capacity, players + 1))}>+</button>
          </span>
        </div>
        <div className="field"><span>Time</span>
          <div className="chips">
            {!slot && <button type="button" className="chip" aria-pressed={time === null} onClick={() => setTime(null)}>Open timer</button>}
            {times.map((m) => <button type="button" key={m} className="chip" aria-pressed={time === m} onClick={() => setTime(m)}>{minutesLabel(m)}</button>)}
          </div></div>
        {data.open_tabs.length > 0 && (
          <Field label="Add to an open bill (group)"><select className="input" value={tab} onChange={(e) => setTab(e.target.value)}>
            <option value="">New bill</option>
            {data.open_tabs.map((t) => <option key={t.id} value={t.id}>{t.label}{t.customer ? ` · ${t.customer}` : ''}</option>)}</select></Field>
        )}
        {start.error && <Notice tone="bad">{errorMessage(start.error)}</Notice>}
        <button className="btn primary block xl" disabled={start.isPending || !can('floor.operate')}>
          {start.isPending ? <span className="spinner" /> : <><CirclePlay size={18} /> Start {time ? minutesLabel(time) : 'timer'}</>}</button>
      </form>
    </Sheet>
  );
}

/* ────────────────────────── Waiting list ────────────────────────── */
function WaitlistSheet({ data, onClose }: { data: FloorState; onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(data.waitlist.length === 0);
  const [seat, setSeat] = useState<WaitEntry | null>(null);
  const [f, setF] = useState({ name: '', phone: '', activity: data.activities[0]?.id ?? '', party: 2, note: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['floor', centre.id] });
  const add = useMutation({
    mutationFn: () => rpc('add_to_waitlist', { p_centre: centre.id, p_activity: f.activity, p_name: f.name, p_phone: f.phone || null, p_party_size: f.party, p_note: f.note || null }),
    onSuccess: async () => { await refresh(); toast('Added to waiting list'); setAdding(false); setF({ ...f, name: '', phone: '', note: '' }); },
  });
  const status = useMutation({ mutationFn: (x: { id: string; s: string }) => rpc('set_waitlist_status', { p_centre: centre.id, p_entry: x.id, p_status: x.s }), onSuccess: refresh });
  const act = (id: string) => data.activities.find((a) => a.id === id);
  const freeFor = (id: string) => data.resources.filter((r) => r.activity_id === id && !r.session && r.status === 'active');
  const seatRes = seat ? freeFor(seat.activity_id) : [];
  const [seatOn, setSeatOn] = useState<Resource | null>(null);

  return (
    <Sheet title="Waiting list" onClose={onClose}>
      <div className="stack lg">
        {data.waitlist.length > 0 && (
          <ul className="list card flush wait-list">
            {data.waitlist.map((w, i) => {
              const a = act(w.activity_id);
              const free = freeFor(w.activity_id).length;
              return (
                <li key={w.id} className="item" style={{ flexWrap: 'wrap' }}>
                  <span className="avatar" aria-hidden>{i + 1}</span>
                  <span className="main-col"><span className="title">{w.name} · {w.party_size}</span>
                    <span className="meta"><span>{a?.name}</span><span>{formatTime(w.created_at, centre.timezone)}</span>{w.status === 'notified' && <span>Messaged</span>}{w.note && <span>{w.note}</span>}</span></span>
                  <span className="row">
                    {w.phone && <span onClick={() => status.mutate({ id: w.id, s: 'notified' })}><WhatsAppPairButton phone={w.phone} name={w.name} label="Ready"
                      texts={msgReady({ name: w.name, centre: centre.name, activity: a?.name ?? 'table' })} /></span>}
                    <button className="btn small primary" disabled={!free} onClick={() => setSeat(w)}>{free ? 'Seat' : 'None free'}</button>
                    <button className="btn small ghost icon-btn" aria-label="Remove" onClick={() => status.mutate({ id: w.id, s: 'cancelled' })}><X size={15} /></button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {adding ? (
          <form className="stack lg" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <div className="grid-2">
              <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
              <Field label="Mobile (to message when ready)"><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            </div>
            <div className="grid-2">
              <Field label="Wants"><select className="input" value={f.activity} onChange={(e) => setF({ ...f, activity: e.target.value })}>
                {data.activities.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
              <Field label="People"><input className="input num" inputMode="numeric" value={f.party} onChange={(e) => setF({ ...f, party: Math.max(1, Number(e.target.value) || 1) })} /></Field>
            </div>
            <Field label="Note (optional)"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
            {add.error && <Notice tone="bad">{errorMessage(add.error)}</Notice>}
            <button className="btn primary block xl" disabled={!f.name.trim() || add.isPending}>Add to waiting list</button>
          </form>
        ) : <button className="btn block" onClick={() => setAdding(true)}><Plus size={18} /> Add someone</button>}
      </div>
      {seat && !seatOn && (
        <Sheet title={`Seat ${seat.name}`} onClose={() => setSeat(null)}>
          <div className="chips">{seatRes.map((r) => <button key={r.id} className="chip" onClick={() => setSeatOn(r)}>{r.name}</button>)}</div>
        </Sheet>
      )}
      {seat && seatOn && <StartSheet r={seatOn} a={act(seatOn.activity_id)} data={data} fromWait={seat} onClose={() => { setSeat(null); setSeatOn(null); }} />}
    </Sheet>
  );
}

function OpenTabsSheet({ data, onClose, onOpen }: { data: FloorState; onClose: () => void; onOpen: (tab: string) => void }) {
  const { centre } = useCentre();
  return (
    <Sheet title="Open bills" onClose={onClose}>
      {!data.open_tabs.length ? <Empty title="No open bills" /> : (
        <ul className="list card flush">
          {data.open_tabs.map((t) => (
            <li key={t.id}><button className="item" onClick={() => onOpen(t.id)}>
              <span className="main-col"><span className="title">{t.label ?? 'Bill'}{t.customer ? ` · ${t.customer}` : ''}</span>
                <span className="meta"><span>Opened {formatTime(t.opened_at, centre.timezone)}</span><span>{t.live ? 'Game running' : 'Ready to bill'}</span></span></span>
              <span className="end-col"><span className={`badge ${t.live ? 'info' : 'warn'}`}>{t.live ? 'Playing' : 'To pay'}</span></span>
            </button></li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

