import { mediaUrl } from '../../lib/media';
// Public booking page at /b/:slug. No sign-in: pick a game, day, length and time; name + phone only after "Book".
// Customers book a game type, not a table — the centre seats them at any free table of that game.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AtSign, Gamepad2, MapPin } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { Logo, Notice, Sheet } from '../../components/ui';
import { addDays, formatDay, time12, todayInCentre } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import type { Activity, Resource } from '../../lib/floor';
import { formatINR } from '../../lib/money';
import { rpc } from '../../lib/supabase';
import { FloorMap } from '../floor/FloorMap';
import '../floor/floor.css';
import './booking.css';
import { durationLabel, priceLabel, type BookingPageData, type Slot } from './types';

const lastKey = (slug: string) => `xs-arena-booking-${slug}`;

export function BookPage() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<BookingPageData | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [players, setPlayers] = useState(2);
  const [game, setGame] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [estimate, setEstimate] = useState(0);
  const [slotErr, setSlotErr] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [booking, setBooking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [showMap, setShowMap] = useState(() => typeof window === 'undefined' || window.innerWidth >= 700);
  const step2 = useRef<HTMLElement>(null);
  const pick = (id: string) => { setActivityId(id); window.setTimeout(() => step2.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); };
  const last = useMemo(() => { try { return localStorage.getItem(lastKey(slug)); } catch { return null; } }, [slug]);

  // page data; refresh the live floor every 30 s
  useEffect(() => {
    let stop = false;
    const load = () => rpc<BookingPageData>('booking_page', { p_slug: slug })
      .then((d) => { if (!stop) { setData(d); setLoadErr(null); } })
      .catch((e) => { if (!stop) setLoadErr(errorMessage(e)); });
    void load();
    const t = window.setInterval(load, 30_000);
    return () => { stop = true; window.clearInterval(t); };
  }, [slug]);

  useEffect(() => { if (data) document.title = `Book · ${data.centre.name}`; }, [data]);

  const c = data?.centre;
  const tz = c?.timezone ?? 'Asia/Kolkata';
  const days = useMemo(() => {
    if (!c) return [];
    const today = todayInCentre(tz);
    return Array.from({ length: c.days_ahead + 1 }, (_, i) => addDays(today, i));
  }, [c, tz]);
  const act = data?.activities.find((a) => a.id === activityId) ?? null;

  // sensible defaults once data arrives
  useEffect(() => {
    if (!data) return;
    if (!activityId && data.activities.length === 1) setActivityId(data.activities[0].id);
    if (!day && days.length) setDay(days[0]);
    if (!minutes && data.centre.durations.length) setMinutes(data.centre.durations.includes(60) ? 60 : data.centre.durations[0]);
  }, [data, days, activityId, day, minutes]);
  useEffect(() => { if (act) setPlayers((p) => Math.min(Math.max(1, p), act.max_players || 1)); }, [act]);
  // a game picked for one console type doesn't carry over to another
  useEffect(() => { setGame((g) => (g && act?.games?.some((x) => x.name === g) ? g : null)); }, [act]);

  // available times for the chosen game / day / length
  useEffect(() => {
    setSlot(null);
    if (!activityId || !day || !minutes) { setSlots(null); return; }
    let stop = false;
    setSlots(null); setSlotErr(null);
    rpc<{ slots: Slot[]; estimate_paise: number }>('booking_slots', { p_slug: slug, p_activity: activityId, p_date: day, p_minutes: minutes, p_party: players, p_game: game })
      .then((r) => { if (!stop) { setSlots(r.slots); setEstimate(r.estimate_paise); } })
      .catch((e) => { if (!stop) setSlotErr(errorMessage(e)); });
    return () => { stop = true; };
  }, [slug, activityId, day, minutes, players, game, refresh]);

  if (loadErr && !data) {
    return (
      <main className="book-page">
        <div className="book-wrap">
          <Notice tone="bad">{loadErr}</Notice>
          <p className="muted">Check the link you were sent, or ask the centre for their booking link.</p>
        </div>
      </main>
    );
  }
  if (!data || !c) return <main className="book-page" aria-busy="true"><div className="center-screen"><span className="spinner" /></div></main>;

  const floor = data.floors.find((f) => data.resources.some((r) => r.floor_id === f.id)) ?? data.floors[0];
  const mapRes: Resource[] = data.resources.map((r) => ({
    ...r,
    session: r.busy ? { id: r.id, status: 'running', started_at: data.server_time, players: 1, planned_minutes: null, frames: 0,
      billable_seconds: 0, running_since: null } : null,
  }));
  const freeSlots = slots?.filter((s) => s.free) ?? [];

  return (
    <main className="book-page">
      <div className="book-wrap">
        {c.cover_path && <div className="book-cover" style={{ backgroundImage: `url(${mediaUrl(c.cover_path)})` }} data-testid="book-cover" />}
        <header className={`book-head ${c.cover_path ? 'has-cover' : ''}`}>
          {c.logo_path && <img className="book-logo" src={mediaUrl(c.logo_path) ?? ''} alt={`${c.name} logo`} data-testid="book-logo" />}
          <p className="book-eyebrow">Book a game</p>
          <h1>{c.name}</h1>
          <p className="muted">
            {[c.address, c.city].filter(Boolean).join(', ')}
            {(c.address || c.city) && ' · '}Open {time12(c.open_time.slice(0, 5))} – {time12(c.close_time.slice(0, 5))}
          </p>
          {c.about && <p className="book-about" data-testid="book-about">{c.about}</p>}
          {(c.maps_url || c.instagram) && (
            <div className="row wrap">
              {c.maps_url && <a className="btn small" href={c.maps_url} target="_blank" rel="noreferrer"><MapPin size={16} /> Directions</a>}
              {c.instagram && <a className="btn small" href={`https://instagram.com/${c.instagram}`} target="_blank" rel="noreferrer" data-testid="book-instagram"><AtSign size={16} /> {c.instagram}</a>}
            </div>
          )}
          {c.note && <p className="book-note">{c.note}</p>}
          {last && <Link className="btn small" to={`/t/${last}`}>See my booking</Link>}
        </header>

        {floor && data.resources.length > 0 && (
          <section className="book-live card" aria-label="Live floor">
            <div className="book-live-head">
              <h2>The floor right now</h2>
              <button type="button" className="btn small ghost" onClick={() => setShowMap(!showMap)} aria-expanded={showMap}>{showMap ? 'Hide' : 'Show'}</button>
            </div>
            {showMap && (
              <>
                <span className="legend"><i className="dot free" /> Free <i className="dot busy" /> Busy</span>
                <FloorMap floor={floor} resources={mapRes.filter((r) => r.floor_id === floor.id)} activities={data.activities as unknown as Activity[]} mode="tv"
                  showMoney={false} showNames={false} busyText="Busy" highlight={activityId} className="book-map" />
              </>
            )}
          </section>
        )}

        <section className="book-step">
          <h2><span className="step-n">1</span> Choose a game</h2>
          {data.activities.length === 0 && <Notice tone="warn">Nothing can be booked online right now. Please call {c.phone ?? 'the centre'}.</Notice>}
          <div className="game-grid">
            {data.activities.map((a) => (
              <button key={a.id} type="button" className="game-card" aria-pressed={a.id === activityId} onClick={() => pick(a.id)}>
                <span className="game-dot" style={{ background: a.color }} />
                <b>{a.name}</b>
                <span className="muted">{priceLabel(a.price)}</span>
                <span className="game-free">{a.free_now > 0 ? `${a.free_now} free now` : 'All busy now'}</span>
              </button>
            ))}
          </div>
        </section>

        {act && !!act.games?.length && (
          <section className="book-step" data-testid="game-step">
            <h2><span className="step-n"><Gamepad2 size={14} /></span> Which game do you want to play?</h2>
            <div className="chips">
              <button type="button" className="chip" aria-pressed={game === null} onClick={() => setGame(null)}>Any game</button>
              {act.games.map((g) => (
                <button key={g.name} type="button" className="chip" aria-pressed={game === g.name} onClick={() => setGame(g.name)}>
                  {g.name} <span className="muted">· {g.consoles} {act.kind === 'console' ? 'console' : 'table'}{g.consoles > 1 ? 's' : ''}</span>
                </button>
              ))}
            </div>
            {game && <p className="muted" style={{ margin: 0, fontSize: 'var(--t-sm)' }}>Times below are for a {act.name} with {game}.</p>}
          </section>
        )}

        {act && (
          <>
            <section className="book-step" ref={step2}>
              <h2><span className="step-n">2</span> Day</h2>
              <div className="chips scroll fade-end">
                {days.map((d, i) => (
                  <button key={d} type="button" className="chip" aria-pressed={d === day} onClick={() => setDay(d)}>
                    {i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : formatDay(d)}
                  </button>
                ))}
              </div>
            </section>

            <section className="book-step">
              <h2><span className="step-n">3</span> How long, how many</h2>
              <div className="chips">
                {c.durations.map((m) => (
                  <button key={m} type="button" className="chip" aria-pressed={m === minutes} onClick={() => setMinutes(m)}>{durationLabel(m)}</button>
                ))}
              </div>
              {act.max_players > 1 && (
                <div className="row" style={{ gap: 12 }}>
                  <div className="stepper" role="group" aria-label="Players">
                    <button type="button" className="btn small icon-btn" aria-label="Fewer players" disabled={players <= 1} onClick={() => setPlayers(players - 1)}>−</button>
                    <span><b className="num">{players}</b> player{players > 1 ? 's' : ''}</span>
                    <button type="button" className="btn small icon-btn" aria-label="More players" disabled={players >= act.max_players} onClick={() => setPlayers(players + 1)}>+</button>
                  </div>
                  {players >= act.max_players && <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>Max {act.max_players} per {act.kind === 'console' ? 'console' : act.kind === 'track' ? 'track' : 'table'}. Bigger group? Book two.</span>}
                </div>
              )}
            </section>

            <section className="book-step">
              <h2><span className="step-n">4</span> Time</h2>
              {slotErr && <Notice tone="bad">{slotErr}</Notice>}
              {!slots && !slotErr && <div className="slot-grid">{Array.from({ length: 8 }, (_, i) => <span key={i} className="slot skeleton" />)}</div>}
              {slots && slots.length === 0 && <p className="muted">No more times on this day. Try another day.</p>}
              {slots && slots.length > 0 && freeSlots.length === 0 && <p className="muted">Fully booked on this day. Try another day or a shorter time.</p>}
              {slots && slots.length > 0 && (
                <div className="slot-grid">
                  {slots.map((s) => (
                    <button key={s.at} type="button" className="slot" disabled={!s.free} aria-pressed={slot?.at === s.at}
                      aria-label={`${time12(s.local)}${s.free ? '' : ', full'}`} onClick={() => setSlot(s)}>
                      {time12(s.local)}{!s.free && <small>Full</small>}
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
        <p className="book-foot muted">Powered by <Logo width={84} className="inline-logo" /></p>
      </div>

      {act && slot && minutes && day && (
        <div className="book-bar" role="region" aria-label="Your choice">
          <div>
            <b>{time12(slot.local)} · {day === days[0] ? 'Today' : day === days[1] ? 'Tomorrow' : formatDay(day)}</b>
            <span className="muted">{act.name}{game ? ` · ${game}` : ''} · {durationLabel(minutes)} · {players} player{players > 1 ? 's' : ''}{estimate > 0 && ` · ${formatINR(estimate)}`}</span>
          </div>
          <button type="button" className="btn primary" onClick={() => setBooking(true)}>Book</button>
        </div>
      )}

      {booking && act && slot && minutes && day && (
        <ConfirmSheet slug={slug} activityId={act.id} activityName={act.name} game={game} slot={slot} day={day} minutes={minutes} players={players}
          estimate={estimate} holdMinutes={c.hold_minutes} isToday={day === days[0]}
          advance={c.advance_on && c.advance_bp > 0 ? Math.ceil((estimate * c.advance_bp) / 10000 / 100) * 100 : 0}
          onClose={() => setBooking(false)} onTaken={() => { setBooking(false); setRefresh((n) => n + 1); }} />
      )}
    </main>
  );
}

function ConfirmSheet({ slug, activityId, activityName, game, slot, day, minutes, players, estimate, holdMinutes, isToday, advance, onClose, onTaken }: {
  slug: string; activityId: string; activityName: string; game: string | null; slot: Slot; day: string; minutes: number; players: number; estimate: number; advance: number;
  holdMinutes: number; isToday: boolean; onClose: () => void; onTaken: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(() => { try { return localStorage.getItem('xs-arena-book-name') ?? ''; } catch { return ''; } });
  const [phone, setPhone] = useState(() => { try { return localStorage.getItem('xs-arena-book-phone') ?? ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const digits = phone.replace(/\D/g, '');
  const phoneOk = digits.length === 10 || (digits.length === 12 && digits.startsWith('91'));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!phoneOk) { setPhoneErr('Enter a 10-digit mobile number, e.g. 98470 12345'); return; }
    setErr(null); setBusy(true);
    try {
      const r = await rpc<{ token: string }>('create_booking', {
        p_slug: slug, p_activity: activityId, p_starts_at: slot.at, p_minutes: minutes, p_party: players, p_name: name, p_phone: phone, p_game: game,
      });
      try {
        localStorage.setItem(lastKey(slug), r.token);
        localStorage.setItem('xs-arena-book-name', name.trim());
        localStorage.setItem('xs-arena-book-phone', phone.trim());
      } catch { /* storage blocked */ }
      navigate(`/t/${r.token}?new=1`);
    } catch (ex) {
      const m = errorMessage(ex);
      setErr(m);
      if (/just taken/i.test(m)) window.setTimeout(onTaken, 1800);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Confirm your booking" onClose={onClose}>
      <form className="stack lg" onSubmit={submit}>
        <div className="book-summary">
          <b>{activityName}{game ? ` · ${game}` : ''}</b>
          <span>{isToday ? 'Today' : formatDay(day)}, {time12(slot.local)} · {durationLabel(minutes)} · {players} player{players > 1 ? 's' : ''}</span>
          {estimate > 0 && <span className="muted">{formatINR(estimate)} for {durationLabel(minutes)}{players > 1 ? ` (${players} players)` : ''}, paid at the centre. If you play longer, the extra time is added.</span>}
          {advance > 0 && <span data-testid="confirm-advance"><b>Advance {formatINR(advance)}</b> by UPI after booking. Your ticket shows the QR; it comes off your bill.</span>}
        </div>
        <label className="field"><span>Your name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} /></label>
        <label className="field"><span>Phone number</span>
          <input className="input" value={phone} onChange={(e) => { setPhone(e.target.value.replace(/[^\d+\s-]/g, '')); setPhoneErr(null); }} inputMode="tel" autoComplete="tel" required
            maxLength={16} placeholder="98470 12345" aria-invalid={!!phoneErr} aria-describedby="phone-help" />
          <small id="phone-help" className={phoneErr ? 'field-error' : 'muted'}>{phoneErr ?? 'We only use it to confirm your booking.'}</small></label>
        <Notice tone="info">
          No payment now — pay at the centre after you play. We keep your booking for {holdMinutes} minutes after your time.
        </Notice>
        {err && <Notice tone="bad">{err}</Notice>}
        <button className="btn primary block xl" disabled={busy}>{busy ? 'Booking…' : 'Confirm booking'}</button>
      </form>
    </Sheet>
  );
}
