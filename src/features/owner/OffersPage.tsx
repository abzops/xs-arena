// Happy-hour offer to past customers: pick who, write the message once, tap-to-send on WhatsApp one by one.
// (Automatic bulk sending needs Meta's WhatsApp Business API — Phase 3. Tap-to-send is free and allowed today.)
import { useQuery } from '@tanstack/react-query';
import { Check, Send, Share2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCentre } from '../../app/centre';
import { canShareImages, ImageSendSheet } from '../../components/ImageSend';
import { Empty, Field, Loading, Notice, Segmented } from '../../components/ui';
import { offerCard } from '../../lib/cards';
import { todayInCentre } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { supabase } from '../../lib/supabase';
import type { Customer } from '../../lib/types';
import { offerText, pickRecipients, type Lang } from './text';

const AWAY = [{ v: 0, l: 'Everyone' }, { v: 7, l: 'Not in 7 days' }, { v: 14, l: 'Not in 14 days' }, { v: 30, l: 'Not in 30 days' }];



export function OffersPage() {
  const { centre } = useCentre();
  const today = todayInCentre(centre.timezone);
  const sentKey = `xs-arena-offer-sent-${centre.id}-${today}`;
  const [away, setAway] = useState(7);
  const [lang, setLang] = useState<Lang>('en');
  const [offer, setOffer] = useState('2 to 5 pm, 1 hour free with every 2 hours played');
  const [withLink, setWithLink] = useState(centre.booking_enabled);
  const [sent, setSent] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(sentKey) ?? '[]')); } catch { return new Set(); } });
  useEffect(() => { try { localStorage.setItem(sentKey, JSON.stringify([...sent])); } catch { /* storage blocked */ } }, [sent, sentKey]);

  const q = useQuery({
    queryKey: ['customers', centre.id, 'offer'],
    queryFn: async () => {
      const { data, error } = await supabase.from('customers').select('*').eq('centre_id', centre.id).limit(2000);
      if (error) throw error;
      return data as Customer[];
    },
  });
  const people = useMemo(() => pickRecipients(q.data ?? [], away, new Date()), [q.data, away]);
  const link = withLink ? `${window.location.origin}/b/${centre.slug}` : undefined;
  const [to, setTo] = useState<Customer | null>(null);
  // the offer goes out as a poster image (QR to book instead of a link)
  const poster = useCallback((l: Lang) => offerCard({ centre, lang: l, offer, bookingUrl: link }), [centre, offer, link]);
  async function shareToMany() {
    try {
      const b = await poster(lang);
      await navigator.share({ files: [new File([b], 'offer.png', { type: 'image/png' })], text: offerText(lang, centre.name, '', offer).replace(/^Hi ! |^ഹായ് ! /, '') });
    } catch { /* cancelled */ }
  }
  const done = people.filter((p) => sent.has(p.id)).length;

  return (
    <div className="stack lg">
      <div className="page-head"><h1>Send an offer</h1></div>
      <p className="muted" style={{ marginTop: -8 }}>Write the offer once, then tap each customer to open WhatsApp with the message ready. Only customers who agreed to offers are listed.</p>
      <Field label="Offer"><textarea className="input" rows={2} value={offer} onChange={(e) => setOffer(e.target.value)} maxLength={200} /></Field>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <Segmented label="Language" value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'ml', label: 'മലയാളം' }]} />
        {centre.booking_enabled && <label className="check-row" style={{ padding: 0 }}><input type="checkbox" checked={withLink} onChange={(e) => setWithLink(e.target.checked)} /> <span>QR to book on the poster</span></label>}
      </div>
      <div className="chips">{AWAY.map((a) => <button key={a.v} className="chip" aria-pressed={away === a.v} onClick={() => setAway(a.v)}>{a.l}</button>)}</div>
      <div className="offer-preview"><span className="muted">Message with the poster</span><p>{offerText(lang, centre.name, people[0]?.full_name ?? 'Rahul', offer || '…')}</p></div>
      <OfferPosterPreview build={poster} />
      {canShareImages() && <button className="btn block" onClick={shareToMany}><Share2 size={16} /> Share the poster to many chats at once</button>}
      {q.isPending ? <Loading rows={4} /> : q.error ? <Notice tone="bad">{errorMessage(q.error)}</Notice> : people.length === 0 ? (
        <div className="card"><Empty title="No one to send to">No customers match. Try "Everyone".</Empty></div>
      ) : (
        <>
          <p className="muted"><b>{done}</b> of {people.length} sent today</p>
          <ul className="list card flush">
            {people.map((p) => {
              const isSent = sent.has(p.id);
              return (
                <li key={p.id}>
                  <a className="item" href="#" role="button" style={isSent ? { opacity: 0.55 } : undefined}
                    onClick={(e) => { e.preventDefault(); setTo(p); }}>
                    <span className="main-col"><span className="title">{p.full_name}</span>
                      <span className="meta"><span>{p.phone}</span><span>{p.visit_count} visits</span>
                        {p.last_visit_at && <span>Last {new Date(p.last_visit_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>}</span></span>
                    <span className="end-col">{isSent ? <span className="badge ok"><Check size={12} /> Sent</span> : <span className="btn small"><Send size={14} /> Send</span>}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {to && (
        <ImageSendSheet title={`Send offer to ${to.full_name}`} name={to.full_name} phone={to.phone} filename="offer.png"
          caption={{ en: offerText('en', centre.name, to.full_name, offer), ml: offerText('ml', centre.name, to.full_name, offer) }}
          build={poster} onSent={() => setSent((x) => new Set(x).add(to.id))} onClose={() => setTo(null)} />
      )}
    </div>
  );
}

function OfferPosterPreview({ build }: { build: (l: Lang) => Promise<Blob> }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => { build('en').then((b) => { if (alive) setUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b); }); }).catch(() => undefined); }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [build]);
  return url ? <div className="img-send-preview small"><img src={url} alt="Offer poster" /></div> : null;
}
