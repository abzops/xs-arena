// XS AI — type or speak a command. Rule-based (no AI cost). Every action shows an approval card first;
// questions are answered from the centre's own numbers.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Mic, MicOff, Send, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useCentre } from '../../app/centre';
import { Notice, Segmented, Sheet, useToast } from '../../components/ui';
import { command } from '../../lib/commands';
import { errorMessage } from '../../lib/errors';
import { uid, type FloorState } from '../../lib/floor';
import { formatINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';
import { parse, type Intent } from './parse';

type Turn = { q: string; intent: Intent; answer?: string; done?: 'ok' | 'cancelled' | 'error' };
type Dash = { revenue_today: number; bills_today: number; revenue_month: number; expenses_month: number; busy_now: number; resources_total: number;
  by_activity_today?: Record<string, number> | { name: string; amount_paise: number }[] };

const EXAMPLES = ['Snooker 1 start 1 hour 2 players', 'PS5 #1 extend 30 min', 'add 2 soft drink to Pool 1', "today's collection?", 'net profit this month', "who's waiting?"];

type Rec = { lang: string; interimResults: boolean; continuous: boolean; start: () => void; stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };

export function AiSheet({ data, onClose }: { data: FloorState; onClose: () => void }) {
  const { centre, can } = useCentre();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [lang, setLang] = useState<'en-IN' | 'ml-IN'>('en-IN');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const rec = useRef<Rec | null>(null);
  const RecCtor = typeof window !== 'undefined'
    ? ((window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition) : undefined;

  const products = useQuery({
    queryKey: ['products-lite', centre.id],
    queryFn: async () => {
      const { data: p, error } = await supabase.from('products').select('id,name,price_paise').eq('centre_id', centre.id).eq('status', 'active');
      if (error) throw error;
      return p as { id: string; name: string; price_paise: number }[];
    },
  });
  useEffect(() => () => rec.current?.stop(), []);

  const ctx = {
    resources: data.resources.filter((r) => r.status === 'active').map((r) => ({ id: r.id, name: r.name })),
    products: products.data ?? [],
    activities: data.activities.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name })),
  };
  const res = (id: string) => data.resources.find((r) => r.id === id)!;
  const update = (i: number, t: Partial<Turn>) => setTurns((all) => all.map((x, j) => (j === i ? { ...x, ...t } : x)));

  async function answer(intent: Intent): Promise<string | undefined> {
    if (intent.type === 'waiting') {
      return data.waitlist.length ? `${data.waitlist.length} waiting: ${data.waitlist.map((w) => `${w.name ?? w.phone} (${data.activities.find((a) => a.id === w.activity_id)?.name ?? 'any'}, ${w.party_size})`).join(', ')}` : 'Nobody is waiting.';
    }
    if (intent.type === 'free') {
      const free = data.resources.filter((r) => r.status === 'active' && !r.session);
      return free.length ? `Free now: ${free.map((r) => r.name).join(', ')}.` : 'Everything is busy right now.';
    }
    if (intent.type === 'ask') {
      const d = await rpc<Dash>('dashboard_summary', { p_centre: centre.id });
      switch (intent.metric) {
        case 'revenue_today': return `Today so far: ${formatINR(d.revenue_today)} from ${d.bills_today} bill${d.bills_today === 1 ? '' : 's'}.`;
        case 'bills_today': return `${d.bills_today} bill${d.bills_today === 1 ? '' : 's'} today.`;
        case 'customers_today': return `${d.bills_today} bills (groups) today, ${data.resources.filter((r) => r.session).length} playing now.`;
        case 'revenue_month': return `This month: ${formatINR(d.revenue_month)}.`;
        case 'expenses_month': return `Expenses this month: ${formatINR(d.expenses_month)}.`;
        case 'net_month': return `This month: sales ${formatINR(d.revenue_month)} − expenses ${formatINR(d.expenses_month)} = net ${formatINR(d.revenue_month - d.expenses_month)}.`;
        case 'busy_now': return `${d.busy_now} of ${d.resources_total} playing now.`;
        case 'best_game_today': {
          const by = d.by_activity_today;
          const rows = Array.isArray(by) ? by.map((x) => [x.name, x.amount_paise] as const) : Object.entries(by ?? {});
          const top = [...rows].sort((a, b) => Number(b[1]) - Number(a[1]))[0];
          return top ? `${top[0]} is top today with ${formatINR(Number(top[1]))}.` : 'No games billed yet today.';
        }
      }
    }
    return undefined;
  }

  async function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setText('');
    const intent = parse(trimmed, ctx);
    const i = turns.length;
    setTurns((t) => [...t, { q: trimmed, intent }]);
    if (['ask', 'waiting', 'free'].includes(intent.type)) {
      try { update(i, { answer: await answer(intent), done: 'ok' }); } catch (e) { update(i, { answer: errorMessage(e), done: 'error' }); }
    }
  }

  async function approve(i: number, intent: Intent) {
    setBusy(true);
    try {
      let msg = 'Done';
      if (intent.type === 'start') {
        if (res(intent.resource.id).session) throw new Error(`${intent.resource.name} is already playing`);
        await command('start_session', { p_centre: centre.id, p_session: uid(), p_resource: intent.resource.id, p_players: intent.players ?? 1,
          p_planned_minutes: intent.minutes, p_phone: null, p_name: null, p_tab: null, p_source: 'walk_in', p_waitlist: null });
        msg = `${intent.resource.name} started`;
      } else if (intent.type === 'extend') {
        const s = res(intent.resource.id).session;
        if (!s) throw new Error(`${intent.resource.name} is free — nothing to extend`);
        const c = await rpc<{ ok: boolean; max_minutes: number }>('extension_check', { p_centre: centre.id, p_session: s.id, p_minutes: intent.minutes });
        if (!c.ok) throw new Error(c.max_minutes > 0 ? `Booked next — only ${c.max_minutes} min fits` : 'Booked next — no more time on this table');
        await command('extend_session', { p_centre: centre.id, p_session: s.id, p_minutes: intent.minutes });
        msg = `Added ${intent.minutes} min to ${intent.resource.name}`;
      } else if (intent.type === 'pause' || intent.type === 'resume' || intent.type === 'end') {
        const s = res(intent.resource.id).session;
        if (!s) throw new Error(`${intent.resource.name} is free`);
        await command(`${intent.type}_session`, { p_centre: centre.id, p_session: s.id });
        msg = intent.type === 'end' ? `${intent.resource.name} stopped — bill is ready` : `${intent.resource.name} ${intent.type}d`;
      } else if (intent.type === 'add_item') {
        const s = res(intent.resource.id).session;
        if (!s?.tab_id) throw new Error(`No game on ${intent.resource.name} to add to`);
        await rpc('tab_add_item', { p_centre: centre.id, p_tab: s.tab_id, p_product: intent.product.id, p_qty: intent.qty, p_name: null, p_price_paise: null });
        msg = `${intent.qty} × ${intent.product.name} added to ${intent.resource.name}`;
      } else if (intent.type === 'layout') {
        const q = encodeURIComponent(JSON.stringify(Object.fromEntries(intent.counts.map((c) => [c.activity.id, c.count]))));
        onClose(); navigate(`/s/${centre.slug}/designer?quick=${q}`); return;
      }
      await qc.invalidateQueries({ queryKey: ['floor', centre.id] });
      update(i, { done: 'ok', answer: msg }); toast(msg);
    } catch (e) {
      update(i, { done: 'error', answer: errorMessage(e) });
    } finally { setBusy(false); }
  }

  function listen() {
    if (!RecCtor) return;
    if (listening) { rec.current?.stop(); return; }
    const r = new RecCtor();
    r.lang = lang; r.interimResults = false; r.continuous = false;
    r.onresult = (e) => { const said = e.results[0]?.[0]?.transcript ?? ''; setText(said); void submit(said); };
    r.onend = () => setListening(false);
    r.onerror = () => { setListening(false); toast('Could not hear that. Try again or type it.'); };
    rec.current = r; setListening(true); r.start();
  }

  return (
    <Sheet title="XS AI" onClose={onClose}>
      <div className="stack lg ai">
        {turns.length === 0 && (
          <div className="stack">
            <p className="muted">Type or speak. Actions need your OK before anything happens.</p>
            <div className="chips">{EXAMPLES.map((e) => <button key={e} type="button" className="chip" onClick={() => submit(e)}>{e}</button>)}</div>
          </div>
        )}
        <div className="ai-turns">
          {turns.map((t, i) => (
            <div key={i} className="ai-turn">
              <p className="ai-q">{t.q}</p>
              <AiReply turn={t} canDesign={can('floor.design')} busy={busy}
                onApprove={() => approve(i, t.intent)} onCancel={() => update(i, { done: 'cancelled', answer: 'Cancelled' })} />
            </div>
          ))}
        </div>
        <form className="ai-input" onSubmit={(e: FormEvent) => { e.preventDefault(); void submit(text); }}>
          {RecCtor && <button type="button" className={`btn icon-btn ${listening ? 'primary' : ''}`} aria-label={listening ? 'Stop listening' : 'Speak'} onClick={listen}>
            {listening ? <MicOff size={18} /> : <Mic size={18} />}</button>}
          <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? 'Listening…' : 'e.g. Snooker 1 start 1 hour'} aria-label="Command" autoFocus />
          <button className="btn primary icon-btn" aria-label="Send" disabled={!text.trim()}><Send size={18} /></button>
        </form>
        {RecCtor && <Segmented label="Voice language" value={lang} onChange={setLang} options={[{ value: 'en-IN', label: 'English' }, { value: 'ml-IN', label: 'മലയാളം' }]} />}
      </div>
    </Sheet>
  );
}

function describe(intent: Intent): string {
  switch (intent.type) {
    case 'start': return `Start ${intent.resource.name}${intent.minutes ? ` for ${intent.minutes >= 60 && intent.minutes % 60 === 0 ? `${intent.minutes / 60}h` : `${intent.minutes} min`}` : ' (open timer)'}${intent.players ? ` · ${intent.players} players` : ''}`;
    case 'extend': return `Add ${intent.minutes} min to ${intent.resource.name}`;
    case 'pause': return `Pause ${intent.resource.name}`;
    case 'resume': return `Resume ${intent.resource.name}`;
    case 'end': return `Stop ${intent.resource.name} and make the bill`;
    case 'add_item': return `Add ${intent.qty} × ${intent.product.name} to ${intent.resource.name}`;
    case 'layout': return `Open a starter floor: ${intent.counts.map((c) => `${c.count} ${c.activity.name}`).join(', ')}`;
    default: return '';
  }
}

function AiReply({ turn, canDesign, busy, onApprove, onCancel }: { turn: Turn; canDesign: boolean; busy: boolean; onApprove: () => void; onCancel: () => void }) {
  const it = turn.intent;
  if (it.type === 'unknown') return <Notice tone="info">{it.reason ?? "I didn't get that. Try one of the examples."}</Notice>;
  if (['ask', 'waiting', 'free'].includes(it.type)) return turn.answer ? <p className="ai-a"><Sparkles size={14} /> {turn.answer}</p> : <p className="muted">…</p>;
  if (it.type === 'layout' && !canDesign) return <Notice tone="info">Only the owner can change the floor layout.</Notice>;
  if (turn.done) return <p className={`ai-a ${turn.done === 'error' ? 'bad' : ''}`}>{turn.done === 'ok' ? <Check size={14} /> : <X size={14} />} {turn.answer}</p>;
  return (
    <div className="ai-card">
      <b>{describe(it)}</b>
      <div className="row">
        <button className="btn small" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn small primary" onClick={onApprove} disabled={busy}><Check size={16} /> OK, do it</button>
      </div>
    </div>
  );
}
