// XS AI — the centre's assistant. Speak or type, English or Malayalam. Rule-based (no AI cost):
// questions are answered from the centre's own numbers; every action shows an approval card first.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, Mic, RotateCcw, Square, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useCentre } from '../../app/centre';
import { useToast } from '../../components/ui';
import { command } from '../../lib/commands';
import { errorMessage } from '../../lib/errors';
import { playedSeconds, uid, type FloorState } from '../../lib/floor';
import { formatINR } from '../../lib/money';
import { rpc, supabase } from '../../lib/supabase';
import { useFloorState } from '../floor/useFloor';
import { parse, type Intent } from './parse';
import { AiOrb } from './Orb';

type Answer = { text: string; big?: string; sub?: string };
type Turn = { q: string; intent: Intent; answer?: Answer; done?: 'ok' | 'cancelled' | 'error' };
type Dash = { revenue_today: number; bills_today: number; revenue_month: number; expenses_month: number; busy_now: number; resources_total: number;
  by_activity_today?: Record<string, number> | { name: string; amount_paise: number }[] };

const GROUPS: { title: string; items: string[]; owner?: boolean }[] = [
  { title: 'At the desk', items: ['Snooker 1 start 1 hour 2 players', 'PS5 #1 extend 30 min', 'add 2 soft drink to Pool 1', "who's waiting?", "what's free now?"] },
  { title: 'Your numbers', items: ["today's collection?", 'net profit this month', 'best game today', 'how many playing now?'], owner: true },
  { title: 'Set up', items: ['4 pool, 2 snooker, 6 PS5'], owner: true },
];

type Rec = { lang: string; interimResults: boolean; continuous: boolean; start: () => void; stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error?: string }) => void) | null };

const STORE = 'xs-ai-chat';
function loadTurns(centre: string): Turn[] {
  try { const v = JSON.parse(sessionStorage.getItem(`${STORE}:${centre}`) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function AiPage() {
  const floor = useFloorState();
  return <AiChat data={floor.data} />;
}

function AiChat({ data }: { data: FloorState | undefined }) {
  const { centre, can, hasFeature } = useCentre();
  const snacksOn = hasFeature('snacks');
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(centre.id));
  const [lang, setLang] = useState<'en-IN' | 'ml-IN'>(() => (localStorage.getItem('xs-ai-lang') === 'ml-IN' ? 'ml-IN' : 'en-IN'));
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const rec = useRef<Rec | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const RecCtor = typeof window !== 'undefined'
    ? ((window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition) : undefined;
  const owner = can('reports.view');

  const products = useQuery({
    queryKey: ['products-lite', centre.id],
    enabled: snacksOn,
    queryFn: async () => {
      const { data: p, error } = await supabase.from('products').select('id,name,price_paise').eq('centre_id', centre.id).eq('status', 'active');
      if (error) throw error;
      return p as { id: string; name: string; price_paise: number }[];
    },
  });
  useEffect(() => () => rec.current?.stop(), []);
  useEffect(() => { try { sessionStorage.setItem(`${STORE}:${centre.id}`, JSON.stringify(turns.slice(-30))); } catch { /* ignore */ } }, [turns, centre.id]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns.length, thinking]);
  useEffect(() => { try { localStorage.setItem('xs-ai-lang', lang); } catch { /* ignore */ } }, [lang]);

  const ctx = {
    resources: (data?.resources ?? []).filter((r) => r.status === 'active').map((r) => ({ id: r.id, name: r.name })),
    products: products.data ?? [],
    activities: (data?.activities ?? []).filter((a) => a.active).map((a) => ({ id: a.id, name: a.name })),
  };
  const res = (id: string) => data!.resources.find((r) => r.id === id)!;
  const update = (i: number, t: Partial<Turn>) => setTurns((all) => all.map((x, j) => (j === i ? { ...x, ...t } : x)));

  async function answer(intent: Intent): Promise<Answer | undefined> {
    if (!data) return { text: 'Still loading the floor — try again in a second.' };
    if (intent.type === 'waiting') {
      if (!data.waitlist.length) return { text: 'Nobody is waiting.', big: '0', sub: 'waiting' };
      const names = data.waitlist.map((w) => `${w.name ?? w.phone} (${data.activities.find((a) => a.id === w.activity_id)?.name ?? 'any'}, ${w.party_size})`).join(', ');
      return { text: `${data.waitlist.length} waiting: ${names}`, big: String(data.waitlist.length), sub: names };
    }
    if (intent.type === 'status') {
      const r = data.resources.find((x) => x.id === intent.resource.id);
      const ses = r?.session;
      if (!r) return { text: 'I can’t find that table.' };
      if (r.status !== 'active') return { text: `${r.name} is out of service.` };
      if (!ses) return { text: `${r.name} is free.`, big: 'Free', sub: r.name };
      const played = Math.round(playedSeconds(ses, Date.parse(data.server_time), Date.now()) / 60);   // pauses excluded
      let bill = ses.cost_paise ?? null;
      if (ses.tab_id) {
        try { bill = (await rpc<{ subtotal_paise: number }>('tab_preview', { p_centre: centre.id, p_tab: ses.tab_id })).subtotal_paise; } catch { /* keep game cost */ }
      }
      const who = ses.customer?.name ? ` · ${ses.customer.name}` : '';
      const left = ses.planned_minutes ? ses.planned_minutes - played : null;
      const timeTxt = left === null ? `playing ${played} min` : left >= 0 ? `${left} min left` : `${-left} min over time`;
      return bill != null
        ? { text: `${r.name}: ${timeTxt}, ${formatINR(bill)} so far.`, big: formatINR(bill), sub: `${r.name} so far · ${timeTxt}${who}` }
        : { text: `${r.name}: ${timeTxt}.`, big: r.name, sub: `${timeTxt}${who}` };
    }
    if (intent.type === 'free') {
      const free = data.resources.filter((r) => r.status === 'active' && !r.session);
      return free.length ? { text: `Free now: ${free.map((r) => r.name).join(', ')}.`, big: `${free.length} free`, sub: free.map((r) => r.name).join(' · ') } : { text: 'Everything is busy right now.' };
    }
    if (intent.type === 'ask') {
      const d = await rpc<Dash>('dashboard_summary', { p_centre: centre.id });
      const bills = (n: number) => `${n} bill${n === 1 ? '' : 's'}`;
      switch (intent.metric) {
        case 'revenue_today': return { text: `Today so far: ${formatINR(d.revenue_today)} from ${bills(d.bills_today)}.`, big: formatINR(d.revenue_today), sub: `Today so far · ${bills(d.bills_today)}` };
        case 'bills_today': return { text: `${bills(d.bills_today)} today.`, big: String(d.bills_today), sub: 'bills today' };
        case 'customers_today': {
          const now = data.resources.filter((r) => r.session).length;
          return { text: `${bills(d.bills_today)} (groups) today, ${now} playing now.`, big: String(d.bills_today), sub: `groups billed today · ${now} playing now` };
        }
        case 'revenue_month': return { text: `This month: ${formatINR(d.revenue_month)}.`, big: formatINR(d.revenue_month), sub: 'Sales this month' };
        case 'expenses_month': return { text: `Expenses this month: ${formatINR(d.expenses_month)}.`, big: formatINR(d.expenses_month), sub: 'Expenses this month' };
        case 'net_month': {
          const net = d.revenue_month - d.expenses_month;
          return { text: `This month: sales ${formatINR(d.revenue_month)} − expenses ${formatINR(d.expenses_month)} = net ${formatINR(net)}.`,
            big: formatINR(net), sub: `Net this month · sales ${formatINR(d.revenue_month)} − expenses ${formatINR(d.expenses_month)}` };
        }
        case 'dues': {
          const dues = (d as Dash & { dues_paise?: number }).dues_paise ?? 0;
          return dues > 0 ? { text: `${formatINR(dues)} still to collect.`, big: formatINR(dues), sub: 'Still to collect (part-paid and unpaid bills) · see Bills' } : { text: 'No dues. Every bill is paid.', big: '₹0', sub: 'No dues — every bill is paid' };
        }
        case 'games_today': {
          try {
            const day = await rpc<{ games: number }>('day_summary', { p_centre: centre.id, p_date: null });
            const now = data.resources.filter((r) => r.session).length;
            return { text: `${day.games} games finished today, ${now} playing now.`, big: String(day.games), sub: `games finished today · ${now} playing now` };
          } catch { return { text: `${bills(d.bills_today)} today.`, big: String(d.bills_today), sub: 'bills today' }; }
        }
        case 'busy_now': return { text: `${d.busy_now} of ${d.resources_total} playing now.`, big: `${d.busy_now} / ${d.resources_total}`, sub: 'playing now' };
        case 'best_game_today': {
          const by = d.by_activity_today;
          const rows = Array.isArray(by) ? by.map((x) => [x.name, x.amount_paise] as const) : Object.entries(by ?? {});
          const top = [...rows].sort((a, b) => Number(b[1]) - Number(a[1]))[0];
          return top ? { text: `${top[0]} is top today with ${formatINR(Number(top[1]))}.`, big: String(top[0]), sub: `Top game today · ${formatINR(Number(top[1]))}` } : { text: 'No games billed yet today.' };
        }
      }
    }
    return undefined;
  }

  // A command typed or spoken before the floor has loaded waits for it (otherwise "Pool 1" isn't known yet).
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (data && pending.current) { const q = pending.current; pending.current = null; setThinking(false); void submit(q); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setText('');
    if (!data) { pending.current = trimmed; setThinking(true); return; }
    let intent = parse(trimmed, ctx);
    if (data && (intent.type === 'start' || intent.type === 'extend' || intent.type === 'pause' || intent.type === 'resume' || intent.type === 'end')) {
      const rid = intent.resource.id;
      const r = data.resources.find((x) => x.id === rid);
      const free = data.resources.filter((x) => x.status === 'active' && !x.session && x.activity_id === r?.activity_id && x.id !== r?.id).map((x) => x.name);
      if (r && intent.type === 'start' && r.session) {
        intent = { type: 'unknown', reason: `${r.name} is already playing.${free.length ? ` Free now: ${free.join(', ')}.` : ''}` };
      } else if (r && ['extend', 'pause', 'resume', 'end'].includes(intent.type) && !r.session) {
        intent = { type: 'unknown', reason: `${r.name} is free — there's no game to ${intent.type === 'end' ? 'stop' : intent.type}.` };
      }
    }
    const i = turns.length;
    setTurns((t) => [...t, { q: trimmed, intent }]);
    if (['ask', 'waiting', 'free', 'status'].includes(intent.type)) {
      setThinking(true);
      try { update(i, { answer: await answer(intent), done: 'ok' }); } catch (e) { update(i, { answer: { text: errorMessage(e) }, done: 'error' }); }
      finally { setThinking(false); }
    }
  }

  async function approve(i: number, intent: Intent) {
    if (!data) return;
    setBusy(true);
    try {
      let msg = 'Done';
      if (intent.type === 'start') {
        if (res(intent.resource.id).session) throw new Error(`${intent.resource.name} is already playing`);
        if (centre.require_customer) {
          // name + mobile are needed for every new customer: open the start screen with the time filled in
          update(i, { done: 'ok', answer: { text: `Opening ${intent.resource.name} — enter the customer's name and mobile to start.` } });
          navigate(`/s/${centre.slug}/floor?start=${intent.resource.id}${intent.minutes ? `&minutes=${intent.minutes}` : ''}`);
          return;
        }
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
        msg = intent.type === 'end' ? `${intent.resource.name} stopped — bill is ready on the Floor` : `${intent.resource.name} ${intent.type}d`;
      } else if (intent.type === 'add_item') {
        const s = res(intent.resource.id).session;
        if (!s?.tab_id) throw new Error(`No game on ${intent.resource.name} to add to`);
        await rpc('tab_add_item', { p_centre: centre.id, p_tab: s.tab_id, p_product: intent.product.id, p_qty: intent.qty, p_name: null, p_price_paise: null });
        msg = `${intent.qty} × ${intent.product.name} added to ${intent.resource.name}`;
      } else if (intent.type === 'layout') {
        const q = encodeURIComponent(JSON.stringify(Object.fromEntries(intent.counts.map((c) => [c.activity.id, c.count]))));
        navigate(`/s/${centre.slug}/designer?quick=${q}`); return;
      }
      await qc.invalidateQueries({ queryKey: ['floor', centre.id] });
      update(i, { done: 'ok', answer: { text: msg } }); toast(msg);
    } catch (e) {
      update(i, { done: 'error', answer: { text: errorMessage(e) } });
    } finally { setBusy(false); }
  }

  function listen() {
    if (!RecCtor) { toast('Voice works in Chrome (Android, laptop) and Safari (iPhone). Type it here instead.'); input.current?.focus(); return; }
    if (listening) { rec.current?.stop(); return; }
    const r = new RecCtor();
    r.lang = lang; r.interimResults = false; r.continuous = false;
    r.onresult = (e) => { const said = e.results[0]?.[0]?.transcript ?? ''; setText(said); void submit(said); };
    r.onend = () => setListening(false);
    r.onerror = (e) => {
      setListening(false);
      const why: Record<string, string> = {
        'not-allowed': 'Microphone is blocked. Tap the lock icon next to the address, allow Microphone, then try again.',
        'service-not-allowed': 'Microphone is blocked. Tap the lock icon next to the address, allow Microphone, then try again.',
        'audio-capture': 'No microphone found on this device.',
        'network': 'Voice needs internet. Check the connection or type it.',
        'no-speech': 'Didn’t hear anything. Tap the mic and speak.',
        'language-not-supported': 'This browser can’t do Malayalam voice. Switch to EN or type it.',
      };
      toast(why[e?.error ?? ''] ?? 'Could not hear that. Try again or type it.');
    };
    rec.current = r; setListening(true);
    try { r.start(); } catch { setListening(false); }
  }

  const empty = turns.length === 0;
  const orbState = listening ? 'listening' : thinking || busy ? 'thinking' : 'idle';
  return (
    <div className={`xsai ${empty ? 'is-empty' : ''}`}>
      <div className="xsai-aurora" aria-hidden />
      <header className="xsai-head">
        <AiOrb size={empty ? 88 : 40} state={orbState} />
        <div className="xsai-title">
          <h1><span className="xsai-word">XS AI</span></h1>
          <p>{empty ? 'Your centre’s assistant. Speak or type in English or മലയാളം — nothing happens until you tap OK.' : listening ? 'Listening…' : 'Ask anything about your centre'}</p>
        </div>
        {!empty && <button className="btn small ghost" onClick={() => setTurns([])}><RotateCcw size={16} /> New chat</button>}
      </header>

      {empty && (
        <div className="xsai-suggest">
          {GROUPS.filter((g) => !g.owner || owner).map((g) => (
            <section key={g.title}>
              <h2>{g.title}</h2>
              <div className="xsai-chips">
                {g.items.map((e) => <button key={e} type="button" className="xsai-chip" onClick={() => submit(e)} disabled={!data}>{e}</button>)}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="xsai-chat ai-turns" aria-live="polite">
        {turns.map((t, i) => (
          <div key={i} className="ai-turn">
            <p className="ai-q">{t.q}</p>
            <div className="xsai-reply">
              <AiOrb size={28} />
              <AiReply turn={t} canDesign={can('floor.design')} busy={busy}
                onApprove={() => approve(i, t.intent)} onCancel={() => update(i, { done: 'cancelled', answer: { text: 'Cancelled — nothing changed.' } })} />
            </div>
          </div>
        ))}
        {thinking && <div className="xsai-reply"><AiOrb size={28} state="thinking" /><span className="xsai-dots" aria-label="Thinking"><i /><i /><i /></span></div>}
        <div ref={end} />
      </div>

      <form className="xsai-bar ai-input" onSubmit={(e: FormEvent) => { e.preventDefault(); void submit(text); }}>
        <button type="button" className={`xsai-mic ${listening ? 'on' : ''}`} aria-label={listening ? 'Stop listening' : 'Speak'} onClick={listen} title={RecCtor ? 'Speak' : 'Voice needs Chrome'}>
          {listening ? <Square size={18} fill="currentColor" /> : <Mic size={22} />}
        </button>
        <input ref={input} className="xsai-input" value={text} onChange={(e) => setText(e.target.value)}
          placeholder={listening ? 'Listening…' : lang === 'ml-IN' ? 'ഉദാ: സ്നൂക്കർ 1 ഒരു മണിക്കൂർ' : 'Ask or tell XS AI…'} aria-label="Command" enterKeyHint="send" />
        <button type="button" className="xsai-lang" onClick={() => setLang(lang === 'en-IN' ? 'ml-IN' : 'en-IN')} aria-label="Voice language" title="Voice language">
          {lang === 'en-IN' ? 'EN' : 'മ'}
        </button>
        <button className="xsai-send" aria-label="Send" disabled={!text.trim()}><ArrowUp size={20} /></button>
      </form>
    </div>
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
  const a = turn.answer;
  if (it.type === 'unknown') return <div className="ai-a xsai-bubble">{it.reason ?? "I didn't get that. Try something like “Pool 1 start 1 hour” or “today's collection?”."}</div>;
  if (['ask', 'waiting', 'free', 'status'].includes(it.type)) {
    if (!a) return <span className="xsai-dots" aria-label="Thinking"><i /><i /><i /></span>;
    return (
      <div className={`ai-a xsai-bubble ${turn.done === 'error' ? 'bad' : ''}`}>
        {a.big ? <><span className="xsai-big">{a.big}</span>{a.sub && <span className="xsai-sub">{a.sub}</span>}<span className="sr-only">{a.text}</span></> : a.text}
      </div>
    );
  }
  if (it.type === 'layout' && !canDesign) return <div className="ai-a xsai-bubble">Only the owner can change the floor layout.</div>;
  if (turn.done) {
    return <div className={`ai-a xsai-bubble ${turn.done === 'error' ? 'bad' : turn.done === 'ok' ? 'ok' : ''}`}>{turn.done === 'ok' ? <Check size={16} /> : <X size={16} />} {a?.text}</div>;
  }
  return (
    <div className="ai-card xsai-card">
      <span className="xsai-card-label">Needs your OK</span>
      <b>{describe(it)}</b>
      <div className="row">
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn xsai-ok" onClick={onApprove} disabled={busy}><Check size={18} /> OK, do it</button>
      </div>
    </div>
  );
}
