// Shared XS Arena pieces built on the Xelorsoft UI kit (ui.tsx): customer picker,
// a reason sheet, and WhatsApp messages in English or Malayalam.
import { useMutation } from '@tanstack/react-query';
import { MessageCircle, Plus, Search } from 'lucide-react';
import { useDeferredValue, useEffect, useState } from 'react';
import { useCentre } from '../app/centre';
import { errorMessage } from '../lib/errors';
import { formatINR } from '../lib/money';
import { rpc, supabase } from '../lib/supabase';
import type { Customer } from '../lib/types';
import { Field, Notice, Segmented, Sheet, initials } from './ui';

export type CustomerLite = Pick<Customer, 'id' | 'full_name' | 'phone' | 'visit_count'> & Partial<Pick<Customer, 'tags' | 'notes'>>;

/** Find a customer by name or phone, or add a new one inline. */
export function CustomerPicker({ value, onChange }: { value: CustomerLite | null; onChange: (c: CustomerLite | null) => void }) {
  const { centre, can } = useCentre();
  const [term, setTerm] = useState('');
  const q = useDeferredValue(term.trim());
  const [results, setResults] = useState<CustomerLite[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const add = useMutation({
    mutationFn: async () => {
      const id = await rpc<string>('save_customer', { p_centre: centre.id, p_customer: null, p_full_name: name.trim(), p_phone: phone });
      const { data, error } = await supabase.from('customers').select('id, full_name, phone, visit_count, tags, notes').eq('id', id).single();
      if (error) throw error;
      return data as CustomerLite;
    },
    onSuccess: (c) => { onChange(c); setAdding(false); setName(''); setPhone(''); setTerm(''); },
  });

  useEffect(() => {
    if (!q) { setResults([]); return; }
    let live = true;
    const s = q.replace(/[%,()]/g, '');
    const digits = s.replace(/\D/g, '');
    let query = supabase.from('customers').select('id, full_name, phone, visit_count, tags, notes').eq('centre_id', centre.id).neq('status', 'archived').limit(8);
    query = digits.length >= 3 ? query.ilike('phone', `%${digits}%`) : query.ilike('full_name', `%${s}%`);
    query.then(({ data }) => { if (live) setResults((data ?? []) as CustomerLite[]); });
    return () => { live = false; };
  }, [q, centre.id]);

  if (value) {
    return (
      <div className="picked">
        <span className="avatar" aria-hidden>{initials(value.full_name)}</span>
        <span style={{ flex: 1, minWidth: 0, display: 'grid' }}>
          <b>{value.full_name}</b>
          <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>{value.phone} · {value.visit_count ? `${value.visit_count} visits` : 'New customer'}</span>
        </span>
        <button type="button" className="btn small ghost" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }
  if (adding) {
    return (
      <div className="stack">
        <div className="grid-2">
          <input className="input" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <input className="input" placeholder="Phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        {add.error && <Notice tone="bad">{errorMessage(add.error)}</Notice>}
        <div className="row">
          <button type="button" className="btn primary small" disabled={add.isPending || !name.trim() || phone.replace(/\D/g, '').length < 10} onClick={() => add.mutate()}>Add customer</button>
          <button type="button" className="btn ghost small" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="picker">
      <div className="search">
        <Search size={18} />
        <input className="input" type="search" placeholder="Search name or phone" value={term} aria-label="Search customers"
          onChange={(e) => { setTerm(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 160)} />
      </div>
      {open && (q || results.length > 0) && (
        <div className="dropdown" role="listbox">
          {results.map((c) => (
            <button type="button" key={c.id} className="item" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(c); setTerm(''); setOpen(false); }}>
              <span className="avatar" aria-hidden>{initials(c.full_name)}</span>
              <span className="main-col"><span className="title">{c.full_name}</span><span className="meta"><span>{c.phone}</span><span>{c.visit_count} visits</span></span></span>
            </button>
          ))}
          {can('customers.manage') && (
            <button type="button" className="item" onMouseDown={(e) => e.preventDefault()} onClick={() => {
              setAdding(true); setOpen(false);
              if (term.replace(/\D/g, '').length >= 6) setPhone(term); else setName(term);
            }}>
              <span className="avatar" aria-hidden><Plus size={18} /></span>
              <span className="main-col"><span className="title">Add new customer{term.trim() ? ` “${term.trim()}”` : ''}</span></span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Confirm a destructive step with an optional or required reason. */
export function ReasonSheet({ title, warning, confirmLabel, required = true, onClose, onConfirm }: {
  title: string; warning: string; confirmLabel: string; required?: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const run = useMutation({ mutationFn: () => onConfirm(reason.trim()), onSuccess: onClose });
  return (
    <Sheet title={title} onClose={onClose}>
      <form className="stack lg" onSubmit={(e) => { e.preventDefault(); if (!required || reason.trim()) run.mutate(); }}>
        <Notice tone="warn">{warning}</Notice>
        <Field label={required ? 'Reason (required)' : 'Reason (optional)'}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {run.error && <Notice tone="bad">{errorMessage(run.error)}</Notice>}
        <button className="btn danger block" disabled={(required && !reason.trim()) || run.isPending}>{confirmLabel}</button>
      </form>
    </Sheet>
  );
}

/* ---------- WhatsApp ----------
   A ready message in English or Malayalam that staff can edit, then opens
   WhatsApp with it filled in. Nothing is sent automatically. */
export type WaKind = 'thanks' | 'birthday' | 'dues' | 'comeback' | 'hello';
type Lang = 'en' | 'ml';
export type WaFacts = { name: string; amountPaise?: number };
const LANG_KEY = 'xs-wa-lang';
const readLang = (): Lang => { try { return localStorage.getItem(LANG_KEY) === 'ml' ? 'ml' : 'en'; } catch { return 'en'; } };

export function waText(kind: WaKind, lang: Lang, f: WaFacts, centre: string) {
  const first = f.name.split(' ')[0];
  const amount = formatINR(f.amountPaise ?? 0);
  if (lang === 'ml') {
    switch (kind) {
      case 'thanks': return `ഹായ് ${first}, ഇന്ന് ${centre}-ൽ കളിക്കാൻ വന്നതിന് നന്ദി! വീണ്ടും കാണാം 🎮`;
      case 'birthday': return `ജന്മദിനാശംസകൾ ${first}! 🎉 ഈ ആഴ്ച ${centre}-ൽ നിങ്ങൾക്കായി ഒരു പ്രത്യേക ഓഫർ ഉണ്ട്.`;
      case 'dues': return `ഹായ് ${first}, ${centre}-ൽ ${amount} ബാക്കി അടയ്ക്കാനുണ്ട്. UPI വഴിയോ അടുത്ത തവണ വരുമ്പോഴോ അടയ്ക്കാം. നന്ദി!`;
      case 'comeback': return `ഹായ് ${first}, കുറച്ചായല്ലോ കണ്ടിട്ട്! ${centre}-ൽ ടേബിളുകളും PS5-ഉം റെഡിയാണ്. എപ്പോൾ വരും?`;
      case 'hello': return `ഹായ് ${first}, `;
    }
  }
  switch (kind) {
    case 'thanks': return `Hi ${first}, thanks for playing at ${centre} today! See you again soon 🎮`;
    case 'birthday': return `Happy birthday ${first}! 🎉 ${centre} has a special treat for you this week — drop in and play.`;
    case 'dues': return `Hi ${first}, a balance of ${amount} is pending at ${centre}. You can pay by UPI or on your next visit. Thank you!`;
    case 'comeback': return `Hi ${first}, it's been a while! Tables and consoles are ready at ${centre} — when are you coming in?`;
    case 'hello': return `Hi ${first}, `;
  }
}

/** wa.me needs the country code: a bare 10-digit Indian mobile gets 91 in front. */
export const waNumber = (phone: string) => { const d = phone.replace(/\D/g, '').replace(/^0(?=\d{10}$)/, ''); return d.length === 10 ? `91${d}` : d; };
export const waLink = (phone: string, text: string) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;

export function WhatsAppButton({ phone, kind, facts, label = 'WhatsApp', small = true }: {
  phone: string; kind: WaKind; facts: WaFacts; label?: string; small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn${small ? ' small' : ''} wa`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        aria-label={`${label}: message ${facts.name}`}>
        <MessageCircle size={16} aria-hidden /> <span className="btn-text">{label}</span>
      </button>
      {open && <WhatsAppSheet phone={phone} kind={kind} facts={facts} onClose={() => setOpen(false)} />}
    </>
  );
}

function WhatsAppSheet({ phone, kind, facts, onClose }: { phone: string; kind: WaKind; facts: WaFacts; onClose: () => void }) {
  const { centre } = useCentre();
  const [lang, setLangState] = useState<Lang>(readLang);
  const [text, setText] = useState(() => waText(kind, lang, facts, centre.name));
  const setLang = (l: Lang) => {
    setLangState(l);
    setText(waText(kind, l, facts, centre.name));
    try { localStorage.setItem(LANG_KEY, l); } catch { /* private mode */ }
  };
  return (
    <Sheet title={`Message ${facts.name}`} onClose={onClose}>
      <div className="stack lg">
        <Segmented label="Language" value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'ml', label: 'മലയാളം' }]} />
        <label className="field"><span>Message</span>
          <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="muted" style={{ margin: 0 }}>Opens WhatsApp with this message to {phone}. You press send there.</p>
        <a className="btn primary block xl wa" href={waLink(phone, text)} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(onClose, 300)}>
          <MessageCircle size={18} aria-hidden /> Open WhatsApp
        </a>
      </div>
    </Sheet>
  );
}

/* ---------- WhatsApp with ready-made English / Malayalam text ----------
   For floor and bill messages (game started, time up, receipt, table ready). Nothing is sent
   automatically: it opens WhatsApp with the text filled in and staff press send. */
export type WaPair = { en: string; ml: string };

export function WhatsAppPairButton({ phone, name, texts, label = 'WhatsApp', small = true, block = false }: {
  phone: string; name: string; texts: WaPair; label?: string; small?: boolean; block?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn${small ? ' small' : ''}${block ? ' block' : ''} wa`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        aria-label={`${label}: message ${name}`}>
        <MessageCircle size={16} aria-hidden /> <span className="btn-text">{label}</span>
      </button>
      {open && <WhatsAppPairSheet phone={phone} name={name} texts={texts} onClose={() => setOpen(false)} />}
    </>
  );
}

export function WhatsAppPairSheet({ phone, name, texts, onClose }: { phone: string; name: string; texts: WaPair; onClose: () => void }) {
  const [lang, setLangState] = useState<Lang>(readLang);
  const [text, setText] = useState(() => texts[lang]);
  const setLang = (l: Lang) => { setLangState(l); setText(texts[l]); try { localStorage.setItem(LANG_KEY, l); } catch { /* private mode */ } };
  return (
    <Sheet title={`Message ${name}`} onClose={onClose}>
      <div className="stack lg">
        <Segmented label="Language" value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'ml', label: 'മലയാളം' }]} />
        <label className="field"><span>Message</span>
          <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="muted" style={{ margin: 0 }}>Opens WhatsApp with this message to {phone}. You press send there.</p>
        <a className="btn primary block xl wa" href={waLink(phone, text)} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(onClose, 300)}>
          <MessageCircle size={18} aria-hidden /> Open WhatsApp
        </a>
      </div>
    </Sheet>
  );
}
