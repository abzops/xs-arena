// Staff: today's bookings, check-in (code or QR scan), seat at a table, phone bookings, no-shows.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Camera, Check, CirclePlay, Copy, ExternalLink, QrCode, UserX, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useCentre } from '../../app/centre';
import { ImageSendButton } from '../../components/ImageSend';
import { ticketCard } from '../../lib/cards';
import { ticketCaption } from '../../lib/messages';
import { Empty, Field, Loading, Notice, Sheet, useToast } from '../../components/ui';
import { command } from '../../lib/commands';
import { addDays, formatDay, todayInCentre, zoned } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { uid } from '../../lib/floor';
import { formatINR } from '../../lib/money';
import { cameraAvailable, startQrScan } from '../../lib/qrScan';
import { rpc, supabase } from '../../lib/supabase';
import './booking.css';
import { bookingLabel, durationLabel, ticketUrl, type Booking } from './types';

type CheckIn = { booking: Booking; free_tables: { id: string; name: string; capacity: number; games?: string[]; has_game?: boolean }[]; balance_paise: number };

export function useBookingsRealtime(onChange: () => void) {
  const { centre } = useCentre();
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const ch = supabase.channel(`bookings-${centre.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings', filter: `centre_id=eq.${centre.id}` }, () => cb.current())
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [centre.id]);
}

export function BookingsPage() {
  const { centre, hasFeature } = useCentre();
  const qc = useQueryClient();
  const tz = centre.timezone;
  const today = todayInCentre(tz);
  const [day, setDay] = useState(today);
  const [checkIn, setCheckIn] = useState(false);
  const [creating, setCreating] = useState(false);
  const [seat, setSeat] = useState<CheckIn | null>(null);
  const key = ['bookings', centre.id, day];
  const q = useQuery({ queryKey: key, queryFn: () => rpc<Booking[]>('bookings_for_day', { p_centre: centre.id, p_date: day }), refetchInterval: 30_000 });
  useBookingsRealtime(() => void qc.invalidateQueries({ queryKey: ['bookings', centre.id] }));
  const link = `${window.location.origin}/b/${centre.slug}`;

  const list = q.data ?? [];
  const active = list.filter((b) => !['cancelled', 'no_show'].includes(b.status));
  const closed = list.filter((b) => ['cancelled', 'no_show'].includes(b.status));

  return (
    <div className="stack lg">
      <div className="page-head bookings-head">
        <h1>Bookings</h1>
        <div className="row">
          <button className="btn" onClick={() => setCreating(true)}><CalendarPlus size={18} /> New</button>
          <button className="btn primary" onClick={() => setCheckIn(true)}><QrCode size={18} /> Check in</button>
        </div>
      </div>
      {!hasFeature('online_booking') ? <Notice tone="warn">Online booking isn't in your plan.</Notice>
        : !centre.booking_enabled ? (
          <Notice tone="info">Online booking is off. Phone bookings still work. <Link to={`/s/${centre.slug}/settings#booking`}>Turn on online booking</Link></Notice>
        ) : (
          <div className="card row booking-link">
            <span className="grow"><b>Booking link</b><br /><span className="muted">{link.replace(/^https?:\/\//, '')}</span></span>
            <button className="btn small" onClick={() => navigator.clipboard?.writeText(link)}><Copy size={16} /> Copy</button>
            <a className="btn small" href={link} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open</a>
          </div>
        )}

      <div className="chips scroll">
        {Array.from({ length: 8 }, (_, i) => addDays(today, i)).map((d, i) => (
          <button key={d} className="chip" aria-pressed={d === day} onClick={() => setDay(d)}>{i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : formatDay(d)}</button>
        ))}
      </div>

      {q.isPending ? <Loading rows={4} /> : q.error ? <Notice tone="bad">{errorMessage(q.error)}</Notice> : active.length === 0 && closed.length === 0 ? (
        <div className="card"><Empty title={day === today ? 'No bookings today' : 'No bookings on this day'}>
          <p className="muted">Bookings from your link and phone bookings show here.</p></Empty></div>
      ) : (
        <>
          <ul className="list card flush booking-list">
            {active.map((b) => <BookingRow key={b.id} b={b} onSeat={setSeat} />)}
            {active.length === 0 && <li className="item muted">No active bookings.</li>}
          </ul>
          {closed.length > 0 && (
            <details className="card">
              <summary className="muted">{closed.length} cancelled / no-show</summary>
              <ul className="list flush booking-list">{closed.map((b) => <BookingRow key={b.id} b={b} onSeat={setSeat} />)}</ul>
            </details>
          )}
        </>
      )}

      {checkIn && <CheckInSheet onClose={() => setCheckIn(false)} onFound={(c) => { setCheckIn(false); setSeat(c); }} />}
      {seat && <SeatSheet data={seat} onClose={() => setSeat(null)} />}
      {creating && <NewBookingSheet defaultDay={day} onClose={() => setCreating(false)} />}
    </div>
  );
}

function BookingRow({ b, onSeat }: { b: Booking; onSeat: (c: CheckIn) => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const time = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: centre.timezone }).format(new Date(iso));
  const refresh = () => qc.invalidateQueries({ queryKey: ['bookings', centre.id] });
  const act = useMutation({
    mutationFn: async (x: { kind: 'checkin' | 'status'; status?: string }) => {
      if (x.kind === 'checkin') return rpc<CheckIn>('check_in_booking', { p_centre: centre.id, p_code_or_token: b.code });
      await rpc('set_booking_status', { p_centre: centre.id, p_booking: b.id, p_status: x.status });
      return null;
    },
    onSuccess: async (r, x) => { await refresh(); await qc.invalidateQueries({ queryKey: ['floor', centre.id] }); if (r) onSeat(r); else toast(x.status === 'no_show' ? 'Marked no-show' : x.status === 'cancelled' ? 'Booking cancelled' : 'Updated'); },
    onError: (e) => toast(errorMessage(e)),
  });
  const live = b.status === 'confirmed' || b.status === 'late' || b.status === 'arrived';
  return (
    <li className={`item booking-row st-${b.status}`}>
      <div className="bk-time"><b className="num">{time(b.starts_at)}</b><span className="muted">{durationLabel(b.minutes)}</span></div>
      <div className="main-col">
        <span className="title">{b.name} <span className={`ticket-status st-${bookingLabel(b).tone}`}>{bookingLabel(b).label}</span></span>
        <span className="meta">
          <i className="game-dot" style={{ background: b.color }} /> {b.activity}{b.game ? ` · ${b.game}` : ''} · {b.party_size} pl · {b.phone}
          {b.resource && ` · ${b.resource}`} · <span className="code">{b.code}</span>{b.source === 'staff' && ' · phone'}
        </span>
        {b.note && <span className="meta">“{b.note}”</span>}
      </div>
      {live && (
        <div className="row bk-actions">
          {b.status !== 'arrived'
            ? <button className="btn small primary" disabled={act.isPending} onClick={() => act.mutate({ kind: 'checkin' })}><Check size={16} /> Check in</button>
            : <button className="btn small primary" disabled={act.isPending} onClick={() => act.mutate({ kind: 'checkin' })}><CirclePlay size={16} /> Seat</button>}
          {b.status !== 'arrived' && <button className="btn small ghost icon-btn" aria-label="Mark no-show" title="No-show" disabled={act.isPending}
            onClick={() => act.mutate({ kind: 'status', status: 'no_show' })}><UserX size={16} /></button>}
          <button className="btn small ghost icon-btn" aria-label="Cancel booking" title="Cancel" disabled={act.isPending}
            onClick={() => { if (window.confirm(`Cancel ${b.name}'s booking?`)) act.mutate({ kind: 'status', status: 'cancelled' }); }}><X size={16} /></button>
        </div>
      )}
    </li>
  );
}

/** Type the 6-letter code or scan the ticket QR with the camera (where the browser supports it). */
export function CheckInSheet({ onClose, onFound }: { onClose: () => void; onFound: (c: CheckIn) => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const canScan = cameraAvailable();
  const find = async (value: string) => {
    setErr(null); setBusy(true);
    try {
      const r = await rpc<CheckIn>('check_in_booking', { p_centre: centre.id, p_code_or_token: value });
      await qc.invalidateQueries({ queryKey: ['bookings', centre.id] });
      await qc.invalidateQueries({ queryKey: ['floor', centre.id] });
      onFound(r);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  // Scan the ticket QR: works on iPad/iPhone Safari too (jsQR), not just where the browser has a QR reader.
  useEffect(() => {
    if (!scanning || !video.current) return;
    return startQrScan(video.current, (text) => {
      if (!/\/t\/[A-Za-z0-9]+/.test(text)) return false;
      setScanning(false); void find(text); return true;
    }, (msg) => { setErr(msg); setScanning(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  return (
    <Sheet title="Check in a booking" onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); void find(code); }}>
        {scanning ? (
          <div className="scan-box" data-testid="scan-box"><video ref={video} playsInline muted autoPlay aria-label="Camera" /><span>Point at the QR on the customer's phone</span>
            <button type="button" className="btn small" onClick={() => setScanning(false)}>Stop camera</button></div>
        ) : canScan && (
          <button type="button" className="btn primary block xl" onClick={() => { setErr(null); setScanning(true); }} data-testid="scan-qr"><Camera size={20} /> Scan QR on their phone</button>
        )}
        <Field label={canScan ? "Or type the 6-letter code" : "Booking code (6 letters on the ticket)"}>
          <input className="input code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
            placeholder="e.g. AB12CD" autoCapitalize="characters" autoComplete="off" autoFocus={!canScan} inputMode="text" aria-label="Booking code" />
        </Field>
        {err && <Notice tone="bad">{err}</Notice>}
        <button className="btn primary block xl" disabled={busy || code.length < 6}>{busy ? 'Finding…' : 'Check in'}</button>
      </form>
    </Sheet>
  );
}

/** After check-in: pick a free table of the booked game and start the booked time. */
export function SeatSheet({ data, onClose }: { data: CheckIn; onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const b = data.booking;
  const [table, setTable] = useState(data.free_tables[0]?.id ?? null);
  const seat = useMutation({
    mutationFn: () => command('seat_booking', { p_centre: centre.id, p_booking: b.id, p_resource: table, p_session: uid() }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['bookings', centre.id] });
      await qc.invalidateQueries({ queryKey: ['floor', centre.id] });
      const name = data.free_tables.find((t) => t.id === table)?.name;
      toast(r === null ? `${name} will start when back online` : `${b.name} is playing on ${name}`);
      onClose();
    },
  });
  const time = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: centre.timezone }).format(new Date(iso));
  return (
    <Sheet title={`${b.name} has arrived`} onClose={onClose}>
      <div className="stack lg">
        {b.game && !data.free_tables.some((t) => t.has_game) && data.free_tables.length > 0 && (
          <Notice tone="warn">No free console has {b.game} right now. Pick another or wait for one to free up.</Notice>
        )}
        <div className="book-summary">
          <b>{b.activity}{b.game ? ` · ${b.game}` : ''} · {durationLabel(b.minutes)} · {b.party_size} player{b.party_size > 1 ? 's' : ''}</b>
          <span>Booked {time(b.starts_at)} – {time(b.ends_at)} · code {b.code}</span>
          {data.balance_paise > 0 && <span className="muted">About {formatINR(data.balance_paise)} to pay after the game</span>}
          {b.note && <span className="muted">“{b.note}”</span>}
        </div>
        {data.free_tables.length === 0 ? (
          <Notice tone="warn">No {b.activity} is free right now. They're checked in — seat them from here or the floor when one frees up.</Notice>
        ) : (
          <div className="field"><span>Table</span>
            <div className="chips">{data.free_tables.map((t, i) => (
              <button key={t.id} type="button" className="chip" aria-pressed={table === t.id} onClick={() => setTable(t.id)} data-has-game={t.has_game ? '1' : undefined}>
                {t.name}{b.game && t.has_game ? ` · has ${b.game}` : ''}{i === 0 ? ' · suggested' : ''}</button>
            ))}</div>
          </div>
        )}
        {seat.error && <Notice tone="bad">{errorMessage(seat.error)}</Notice>}
        <button className="btn primary block xl" disabled={!table || seat.isPending} onClick={() => seat.mutate()}>
          <CirclePlay size={18} /> Start {durationLabel(b.minutes)}</button>
      </div>
    </Sheet>
  );
}

/** Phone booking taken at the counter. Can use walk-in tables; no advance. */
function NewBookingSheet({ defaultDay, onClose }: { defaultDay: string; onClose: () => void }) {
  const { centre } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const acts = useQuery({
    queryKey: ['activities-lite', centre.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('activities').select('id,name,active').eq('centre_id', centre.id).eq('active', true).order('sort');
      if (error) throw error;
      return data as { id: string; name: string }[];
    },
  });
  const gamesQ = useQuery({
    queryKey: ['places', centre.id, 'games'],
    queryFn: async () => {
      const { data, error } = await supabase.from('resources').select('activity_id,games').eq('centre_id', centre.id).eq('status', 'active');
      if (error) throw error;
      return data as { activity_id: string; games: string[] }[];
    },
  });
  const durations = centre.booking_durations?.length ? centre.booking_durations : [30, 60, 90, 120];
  const [f, setF] = useState({ activity: '', date: defaultDay, time: '18:00', minutes: 60, party: 2, phone: '', name: '', note: '', game: '' });
  const gameList = [...new Set((gamesQ.data ?? []).filter((r) => r.activity_id === f.activity).flatMap((r) => r.games))].sort((a, b) => a.localeCompare(b));
  const [made, setMade] = useState<{ token: string; booking: Booking } | null>(null);
  useEffect(() => { if (!f.activity && acts.data?.length) setF((x) => ({ ...x, activity: acts.data![0].id })); }, [acts.data, f.activity]);
  const save = useMutation({
    mutationFn: () => rpc<{ token: string; booking: Booking }>('staff_create_booking', {
      p_centre: centre.id, p_activity: f.activity, p_starts_at: zoned(f.date, f.time, centre.timezone).toISOString(), p_minutes: f.minutes,
      p_party: f.party, p_name: f.name, p_phone: f.phone, p_note: f.note || null, p_game: f.game || null,
    }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['bookings', centre.id] }); await qc.invalidateQueries({ queryKey: ['floor', centre.id] }); setMade(r); toast('Booked'); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  if (made) {
    const b = made.booking;
    const time = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: centre.timezone }).format(new Date(b.starts_at));
    return (
      <Sheet title="Booking confirmed" onClose={onClose}>
        <div className="stack lg">
          <div className="book-summary"><b>{b.name} · {b.activity}{b.game ? ` · ${b.game}` : ''}</b><span>{formatDay(f.date)}, {time} · {durationLabel(b.minutes)} · code <b>{b.code}</b></span></div>
          <ImageSendButton small={false} block className="primary xl" label="Send ticket on WhatsApp" title="Send ticket" name={b.name} phone={b.phone}
            filename={`ticket-${b.code}.png`} caption={ticketCaption(centre.name, b.name, `${formatDay(f.date)}, ${time}`)}
            build={(lang) => ticketCard({ centre, tz: centre.timezone, lang, activity: b.game ? `${b.activity} · ${b.game}` : b.activity, startsAt: b.starts_at, minutes: b.minutes, party: b.party_size ?? 1,
              name: b.name, code: b.code, qrText: ticketUrl(made.token), holdMinutes: centre.booking_hold_minutes ?? undefined })} />
          <button className="btn block" onClick={onClose}>Done</button>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet title="New booking" onClose={onClose}>
      <form className="stack lg" onSubmit={submit}>
        <Field label="Game"><select className="input" value={f.activity} onChange={(e) => setF({ ...f, activity: e.target.value, game: '' })}>
          {acts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        {gameList.length > 0 && (
          <Field label="Which game on the console?"><select className="input" value={f.game} onChange={(e) => setF({ ...f, game: e.target.value })} data-testid="staff-book-game">
            <option value="">Any game</option>{gameList.map((g) => <option key={g} value={g}>{g}</option>)}</select></Field>
        )}
        <div className="grid-2">
          <Field label="Day"><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></Field>
          <Field label="Time"><input className="input" type="time" step={300} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} required /></Field>
        </div>
        <div className="field"><span>How long</span>
          <div className="chips">{durations.map((m) => <button type="button" key={m} className="chip" aria-pressed={f.minutes === m} onClick={() => setF({ ...f, minutes: m })}>{durationLabel(m)}</button>)}</div></div>
        <div className="grid-2">
          <Field label="Mobile"><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required placeholder="98470 12345" /></Field>
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>Players</span>
          <span className="row">
            <button type="button" className="btn small icon-btn" aria-label="Fewer" onClick={() => setF({ ...f, party: Math.max(1, f.party - 1) })}>−</button>
            <b className="num" style={{ minWidth: 24, textAlign: 'center' }}>{f.party}</b>
            <button type="button" className="btn small icon-btn" aria-label="More" onClick={() => setF({ ...f, party: Math.min(50, f.party + 1) })}>+</button>
          </span>
        </div>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Optional, e.g. birthday" /></Field>
        {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <button className="btn primary block xl" disabled={save.isPending || !f.activity}>{save.isPending ? 'Booking…' : 'Book'}</button>
      </form>
    </Sheet>
  );
}
