// Booking ticket at /t/:token — the customer's proof of booking. Staff scan the QR (this page's own link) to check in.
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { ImageSendButton } from '../../components/ImageSend';
import { ticketCard } from '../../lib/cards';
import { Link, useParams, useSearchParams } from 'react-router';
import { Logo, Notice } from '../../components/ui';
import { formatDay } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatINR } from '../../lib/money';
import { rpc } from '../../lib/supabase';
import './booking.css';
import { bookingLabel, ticketUrl, type Booking } from './types';

type Ticket = {
  booking: Booking; can_cancel: boolean;
  centre: { name: string; slug: string; address: string | null; city: string | null; phone: string | null; timezone: string; hold_minutes: number };
};

export function TicketPage() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const [t, setT] = useState<Ticket | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [qr, setQr] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = () => rpc<Ticket>('booking_ticket', { p_token: token })
      .then((d) => { if (!stop) { setT(d); setErr(null); } })
      .catch((e) => { if (!stop) setErr(errorMessage(e)); });
    void load();
    const i = window.setInterval(load, 20_000);   // flips to "Arrived" / "Playing" when staff check them in
    return () => { stop = true; window.clearInterval(i); };
  }, [token]);

  useEffect(() => {
    QRCode.toString(ticketUrl(token), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setQr).catch(() => undefined);
  }, [token]);
  useEffect(() => { window.scrollTo(0, 0); }, [token]);
  useEffect(() => { if (t) document.title = `Booking ${t.booking.code} · ${t.centre.name}`; }, [t]);

  if (err && !t) {
    return (
      <main className="book-page"><div className="book-wrap">
        <Notice tone="bad">{err}</Notice>
        <p className="muted">This ticket link doesn't work. Open the link you got when you booked, or contact the centre.</p>
      </div></main>
    );
  }
  if (!t) return <main className="book-page" aria-busy="true"><div className="center-screen"><span className="spinner" /></div></main>;

  const b = t.booking, c = t.centre, tz = c.timezone;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(b.starts_at));
  const time = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const holdUntil = time(new Date(new Date(b.starts_at).getTime() + c.hold_minutes * 60_000).toISOString());
  const live = b.status === 'confirmed' || b.status === 'arrived' || b.status === 'late';
  const where = [c.address, c.city].filter(Boolean).join(', ');
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const calendar = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`${b.activity} at ${c.name}`)}&dates=${stamp(b.starts_at)}/${stamp(b.ends_at)}&details=${encodeURIComponent(`Booking code ${b.code}. Ticket: ${ticketUrl(token)}`)}&location=${encodeURIComponent([c.name, where].filter(Boolean).join(', '))}`;

  async function cancel() {
    setCancelling(true);
    try {
      await rpc('cancel_booking_by_token', { p_token: token });
      setT(await rpc<Ticket>('booking_ticket', { p_token: token }));
      setConfirmCancel(false);
    } catch (e) { setErr(errorMessage(e)); } finally { setCancelling(false); }
  }

  return (
    <main className="book-page">
      <div className="book-wrap">
        {params.get('new') && live && <Notice tone="ok">You're booked! Show this screen at the counter.</Notice>}
        <article className={`ticket card ${live ? '' : 'ticket-off'}`}>
          <header>
            <p className="book-eyebrow">{c.name}</p>
            <h1>{b.activity}</h1>
            <span className={`ticket-status st-${bookingLabel(b).tone}`}>{bookingLabel(b).label}</span>
          </header>
          <dl className="ticket-facts">
            <div><dt>Day</dt><dd>{date === today ? 'Today' : formatDay(date, { weekday: 'long', day: 'numeric', month: 'short' })}</dd></div>
            <div><dt>Time</dt><dd>{time(b.starts_at)} – {time(b.ends_at)}</dd></div>
            <div><dt>Players</dt><dd>{b.party_size}</dd></div>
            <div><dt>Name</dt><dd>{b.name}</dd></div>
            {b.resource && <div><dt>Table</dt><dd>{b.resource}</dd></div>}
            {b.estimate_paise > 0 && <div><dt>Est. price</dt><dd>{formatINR(b.estimate_paise)} <small className="muted">at the centre</small></dd></div>}
            {where && <div className="span-2"><dt>Where</dt><dd>{c.name}, {where}</dd></div>}
          </dl>
          {live && (
            <div className="ticket-qr">
              <div role="img" aria-label="Check-in QR code" dangerouslySetInnerHTML={{ __html: qr }} />
              <p>Code <b className="ticket-code">{b.code}</b></p>
              <p className="muted">Show this at the counter. We keep your booking until {holdUntil}.</p>
              <p className="muted">This page is your ticket — bookmark it, or tap “Share on WhatsApp” to save the ticket image.</p>
            </div>
          )}
          {b.status === 'seated' && (b.session_status === 'running' || b.session_status === 'paused') && <Notice tone="ok">Enjoy your game{b.resource ? ` on ${b.resource}` : ''}!</Notice>}
        </article>

        <div className="stack">
          {live && (
            <>
              <ImageSendButton small={false} block label="Share on WhatsApp" title="Share your ticket" filename={`ticket-${b.code}.png`}
                caption={{ en: `My ${b.activity} booking at ${c.name}: ${date === today ? 'today' : formatDay(date)}, ${time(b.starts_at)}. Code ${b.code}.`,
                  ml: `${c.name}-ൽ എന്റെ ${b.activity} ബുക്കിംഗ്: ${date === today ? 'ഇന്ന്' : formatDay(date)}, ${time(b.starts_at)}. കോഡ് ${b.code}.` }}
                build={(lang) => ticketCard({ centre: c, tz, lang, activity: b.activity, startsAt: b.starts_at, minutes: b.minutes, party: b.party_size, name: b.name,
                  code: b.code, qrText: ticketUrl(token), holdMinutes: c.hold_minutes })} />
              <a className="btn block" href={calendar} target="_blank" rel="noreferrer">Add to calendar</a>
            </>
          )}
          {b.status === 'cancelled' && <Notice tone="info">This booking is cancelled. The time is free for others now.</Notice>}
          {where && <a className="btn block" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.name}, ${where}`)}`} target="_blank" rel="noreferrer">Directions</a>}
          {c.phone && <a className="btn block" href={`tel:${c.phone}`}>Call {c.name}</a>}
          {t.can_cancel && !confirmCancel && <button type="button" className="btn block ghost" onClick={() => setConfirmCancel(true)}>Cancel booking</button>}
          {confirmCancel && (
            <div className="card stack">
              <p>Cancel your {b.activity} booking on {date === today ? 'today' : formatDay(date)} at {time(b.starts_at)}?</p>
              <div className="row">
                <button type="button" className="btn" onClick={() => setConfirmCancel(false)}>Keep it</button>
                <button type="button" className="btn danger" disabled={cancelling} onClick={cancel}>{cancelling ? 'Cancelling…' : 'Yes, cancel'}</button>
              </div>
            </div>
          )}
          {err && <Notice tone="bad">{err}</Notice>}
          <Link className={`btn block ${live ? 'ghost' : 'primary'}`} to={`/b/${c.slug}`}>{live ? 'Book another game' : 'Book again'}</Link>
        </div>
        <p className="book-foot muted">Powered by <Logo width={84} className="inline-logo" /></p>
      </div>
    </main>
  );
}
