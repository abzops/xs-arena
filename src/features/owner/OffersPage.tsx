// Happy-hour offer to past customers: pick who, write the message once, tap-to-send on WhatsApp one by one.
// (Automatic bulk sending needs Meta's WhatsApp Business API — Phase 3. Tap-to-send is free and allowed today.)
import { useQuery } from '@tanstack/react-query';
import { Check, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useCentre } from '../../app/centre';
import { Empty, Field, Loading, Notice, Segmented } from '../../components/ui';
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
  const done = people.filter((p) => sent.has(p.id)).length;

  return (
    <div className="stack lg">
      <div className="page-head"><h1>Send an offer</h1></div>
      <p className="muted" style={{ marginTop: -8 }}>Write the offer once, then tap each customer to open WhatsApp with the message ready. Only customers who agreed to offers are listed.</p>
      <Field label="Offer"><textarea className="input" rows={2} value={offer} onChange={(e) => setOffer(e.target.value)} maxLength={200} /></Field>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <Segmented label="Language" value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'ml', label: 'മലയാളം' }]} />
        {centre.booking_enabled && <label className="check-row" style={{ padding: 0 }}><input type="checkbox" checked={withLink} onChange={(e) => setWithLink(e.target.checked)} /> <span>Add booking link</span></label>}
      </div>
      <div className="chips">{AWAY.map((a) => <button key={a.v} className="chip" aria-pressed={away === a.v} onClick={() => setAway(a.v)}>{a.l}</button>)}</div>
      <div className="offer-preview"><span className="muted">Preview</span><p>{offerText(lang, centre.name, 'Rahul', offer || '…', link)}</p></div>
      {q.isPending ? <Loading rows={4} /> : q.error ? <Notice tone="bad">{errorMessage(q.error)}</Notice> : people.length === 0 ? (
        <div className="card"><Empty title="No one to send to">No customers match. Try "Everyone".</Empty></div>
      ) : (
        <>
          <p className="muted"><b>{done}</b> of {people.length} sent today</p>
          <ul className="list card flush">
            {people.map((p) => {
              const phone = p.phone.replace(/\D/g, '');
              const url = `https://wa.me/${phone}?text=${encodeURIComponent(offerText(lang, centre.name, p.full_name, offer, link))}`;
              const isSent = sent.has(p.id);
              return (
                <li key={p.id}>
                  <a className="item" href={url} target="_blank" rel="noreferrer" style={isSent ? { opacity: 0.55 } : undefined}
                    onClick={() => setSent((s) => new Set(s).add(p.id))}>
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
    </div>
  );
}
