// Owner settings for online booking: on/off, link + QR poster, rules, walk-in reserve per game.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Copy, Download, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCentre } from '../../app/centre';
import { Field, Notice, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { rpc, supabase } from '../../lib/supabase';
import './booking.css';
import { durationLabel } from './types';

type Act = { id: string; name: string; online_bookable: boolean; walkin_reserve: number; tables: number };
const ALL_DURATIONS = [15, 30, 45, 60, 90, 120, 180];

export function BookingSettings() {
  const { centre, hasFeature } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const link = `${window.location.origin}/b/${centre.slug}`;
  const [qr, setQr] = useState('');
  const acts = useQuery({
    queryKey: ['booking-acts', centre.id],
    queryFn: async () => {
      const [a, r] = await Promise.all([
        supabase.from('activities').select('id,name,online_bookable,walkin_reserve').eq('centre_id', centre.id).eq('active', true).order('sort'),
        supabase.from('resources').select('activity_id').eq('centre_id', centre.id).eq('status', 'active'),
      ]);
      if (a.error) throw a.error;
      if (r.error) throw r.error;
      return (a.data as Omit<Act, 'tables'>[]).map((x) => ({ ...x, tables: r.data.filter((y) => y.activity_id === x.id).length }))
        .filter((x) => x.tables > 0);
    },
  });
  const [f, setF] = useState({
    enabled: centre.booking_enabled, advance: String(centre.booking_advance_bp / 100), hold: centre.booking_hold_minutes,
    days: centre.booking_days_ahead, lead: centre.booking_lead_minutes, durations: centre.booking_durations, note: centre.booking_note ?? '',
  });
  const [rows, setRows] = useState<Act[]>([]);
  useEffect(() => { if (acts.data) setRows(acts.data); }, [acts.data]);
  useEffect(() => { QRCode.toString(link, { type: 'svg', margin: 1 }).then(setQr).catch(() => undefined); }, [link]);

  const save = useMutation({
    mutationFn: () => {
      const adv = Number(f.advance);
      if (!Number.isFinite(adv) || adv < 0 || adv > 100) throw new Error('Advance must be 0 to 100%');
      if (!f.durations.length) throw new Error('Pick at least one booking length');
      return rpc('save_booking_settings', { p_centre: centre.id, p_settings: {
        enabled: f.enabled, advance_bp: Math.round(adv * 100), hold_minutes: f.hold, days_ahead: f.days, lead_minutes: f.lead,
        durations: f.durations, note: f.note, activities: rows.map((r) => ({ id: r.id, online_bookable: r.online_bookable, walkin_reserve: r.walkin_reserve })),
      } });
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['centre'] }); await qc.invalidateQueries({ queryKey: ['booking-acts', centre.id] }); toast('Booking settings saved'); },
  });

  const poster = () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Book ${centre.name}</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:40px}
      h1{font-size:44px;margin:0 0 8px}p{font-size:22px;margin:6px}svg{width:340px;height:340px;margin:24px auto;display:block}</style>
      <h1>${centre.name.replace(/</g, '&lt;')}</h1><p>Book a table, console or track</p>${qr}<p><b>Scan to book</b></p><p>${link.replace(/^https?:\/\//, '')}</p>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); w.print(); }
  };

  if (!hasFeature('online_booking')) {
    return <section className="card stack" id="booking"><h2>Online booking</h2><Notice tone="info">Online booking is available on the Growth and Pro plans.</Notice></section>;
  }
  return (
    <section className="card stack lg" id="booking">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h2>Online booking</h2><p className="muted" style={{ fontSize: 'var(--t-sm)' }}>Customers book a game and time from your link. You seat them at any free table.</p></div>
        <label className="switch-row"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> {f.enabled ? 'On' : 'Off'}</label>
      </div>

      <div className="booking-share">
        <div className="booking-qr" role="img" aria-label="Booking link QR code" dangerouslySetInnerHTML={{ __html: qr }} />
        <div className="stack">
          <b style={{ wordBreak: 'break-all' }}>{link.replace(/^https?:\/\//, '')}</b>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn small" onClick={() => { void navigator.clipboard?.writeText(link); toast('Link copied'); }}><Copy size={16} /> Copy link</button>
            <a className="btn small" href={link} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open</a>
            <button className="btn small" onClick={poster}><Download size={16} /> Print QR poster</button>
          </div>
          <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>Put the link in your Instagram bio and WhatsApp status. Stick the poster at the counter.</p>
        </div>
      </div>

      <div className="field"><span>Booking lengths customers can pick</span>
        <div className="chips">{ALL_DURATIONS.map((m) => (
          <button key={m} type="button" className="chip" aria-pressed={f.durations.includes(m)}
            onClick={() => setF({ ...f, durations: f.durations.includes(m) ? f.durations.filter((x) => x !== m) : [...f.durations, m].sort((a, b) => a - b) })}>{durationLabel(m)}</button>
        ))}</div></div>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Field label="Hold the table after the booked time" hint="Then the booking stops blocking walk-ins">
          <select className="input" value={f.hold} onChange={(e) => setF({ ...f, hold: Number(e.target.value) })}>
            {[5, 10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></Field>
        <Field label="Book how far ahead">
          <select className="input" value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })}>
            {[0, 1, 2, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d === 0 ? 'Today only' : `${d} day${d > 1 ? 's' : ''}`}</option>)}</select></Field>
        <Field label="Minimum notice">
          <select className="input" value={f.lead} onChange={(e) => setF({ ...f, lead: Number(e.target.value) })}>
            {[0, 15, 30, 60, 120, 240].map((m) => <option key={m} value={m}>{m === 0 ? 'None' : m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>)}</select></Field>
        <Field label="Advance (%)" hint="Collected online once payments are switched on. Until then customers pay at the centre.">
          <input className="input" inputMode="decimal" value={f.advance} onChange={(e) => setF({ ...f, advance: e.target.value })} /></Field>
      </div>
      <Field label="Note on the booking page"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })}
        placeholder="e.g. Shoes off on the snooker floor · Free parking behind the building" maxLength={200} /></Field>

      <div className="field"><span>Which games can be booked online</span>
        <span className="hint">Keep some tables for walk-ins: they are never given to online bookings.</span>
        <ul className="list card flush" style={{ background: 'var(--paper-2)' }}>
          {rows.map((r, i) => (
            <li key={r.id} className="item" style={{ gap: 12, flexWrap: 'wrap' }}>
              <label className="check-row grow" style={{ padding: 0 }}>
                <input type="checkbox" checked={r.online_bookable} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, online_bookable: e.target.checked } : x))} />
                <span><b>{r.name}</b> <span className="muted">· {r.tables} total</span></span>
              </label>
              {r.online_bookable && (
                <label className="row" style={{ fontSize: 'var(--t-sm)' }}>Keep for walk-ins
                  <select className="input" style={{ width: 'auto' }} value={r.walkin_reserve} aria-label={`${r.name} tables kept for walk-ins`}
                    onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, walkin_reserve: Number(e.target.value) } : x))}>
                    {Array.from({ length: r.tables + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}</select>
                  <span className="muted">→ {Math.max(0, r.tables - r.walkin_reserve)} online</span>
                </label>
              )}
            </li>
          ))}
          {acts.isPending && <li className="item muted">Loading…</li>}
        </ul>
      </div>
      {save.error && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
      <button className="btn primary" style={{ justifySelf: 'start' }} disabled={save.isPending} onClick={() => save.mutate()}>Save booking settings</button>
    </section>
  );
}
