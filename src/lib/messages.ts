// Customer WhatsApp texts for XS Arena (English + Malayalam). Times in the centre's timezone.
import type { WaPair } from '../components/centre';
import { formatTime } from './dates';
import { minutesLabel } from './floor';
import { formatINR } from './money';

const first = (n: string) => n.split(' ')[0] || n;

export function msgStarted(o: { name: string; centre: string; resource: string; startedAt: string; tz: string; planned: number | null; price: string }): WaPair {
  const t = formatTime(o.startedAt, o.tz);
  const until = o.planned ? formatTime(new Date(Date.parse(o.startedAt) + o.planned * 60000).toISOString(), o.tz) : null;
  return {
    en: `Hi ${first(o.name)}! Welcome to ${o.centre} 🎮\n${o.resource} started at ${t}${until ? ` (until ${until})` : ''}.\nRate: ${o.price}.\nHave fun!`,
    ml: `ഹായ് ${first(o.name)}! ${o.centre}-ലേക്ക് സ്വാഗതം 🎮\n${o.resource} ${t}-ന് തുടങ്ങി${until ? ` (${until} വരെ)` : ''}.\nനിരക്ക്: ${o.price}.\nആസ്വദിക്കൂ!`,
  };
}

export function msgTimeUp(o: { name: string; centre: string; resource: string; endsAt: string; tz: string }): WaPair {
  const t = formatTime(o.endsAt, o.tz);
  return {
    en: `Hi ${first(o.name)}, your time on ${o.resource} at ${o.centre} ends at ${t}. Want to play longer? Tell the counter and we'll extend if it's free.`,
    ml: `ഹായ് ${first(o.name)}, ${o.centre}-ൽ ${o.resource}-ലെ നിങ്ങളുടെ സമയം ${t}-ന് തീരും. കൂടുതൽ കളിക്കണോ? കൗണ്ടറിൽ പറഞ്ഞാൽ ഫ്രീ ആണെങ്കിൽ നീട്ടിത്തരാം.`,
  };
}

export function msgReady(o: { name: string; centre: string; activity: string }): WaPair {
  return {
    en: `Hi ${first(o.name)}, your ${o.activity} is ready at ${o.centre}! Please come to the counter in the next 10 minutes.`,
    ml: `ഹായ് ${first(o.name)}, ${o.centre}-ൽ നിങ്ങളുടെ ${o.activity} റെഡിയാണ്! 10 മിനിറ്റിനുള്ളിൽ കൗണ്ടറിൽ എത്തൂ.`,
  };
}

export type ReceiptGame = { resource: string; activity: string; started_at: string; ended_at: string | null; minutes: number; amount_paise: number; lines: { label: string; amount_paise: number }[] };
export type ReceiptItem = { name: string; qty: number; total_paise: number };

export function msgReceipt(o: {
  name: string; centre: string; billNo: string; tz: string; games: ReceiptGame[]; items: ReceiptItem[]; discount: number; tax: number; total: number;
  paid: number; methods: string; points?: { used: number; usedPaise: number; earned: number; balance: number } | null; link?: string; upiLink?: string | null;
}): WaPair {
  const gamesEn = o.games.map((g) => `• ${g.resource}: ${formatTime(g.started_at, o.tz)} → ${g.ended_at ? formatTime(g.ended_at, o.tz) : '—'} (${minutesLabel(g.minutes)}) ${formatINR(g.amount_paise)}`).join('\n');
  const gamesMl = o.games.map((g) => `• ${g.resource}: ${formatTime(g.started_at, o.tz)} → ${g.ended_at ? formatTime(g.ended_at, o.tz) : '—'} (${minutesLabel(g.minutes)}) ${formatINR(g.amount_paise)}`).join('\n');
  const items = o.items.map((i) => `• ${i.name} × ${i.qty} ${formatINR(i.total_paise)}`).join('\n');
  const due = o.total - o.paid;
  const en = [`Hi ${first(o.name)}, thanks for playing at ${o.centre}! 🎮`, `Bill ${o.billNo}`, gamesEn, items,
    o.discount ? `Discount −${formatINR(o.discount)}` : '', o.points?.used ? `Points used (${o.points.used}) −${formatINR(o.points.usedPaise)}` : '',
    o.tax ? `GST ${formatINR(o.tax)}` : '',
    `Total ${formatINR(o.total)}`, o.paid ? `Paid ${formatINR(o.paid)} (${o.methods})` : '', due > 0 ? `Balance due ${formatINR(due)}${o.upiLink ? `\nPay by UPI: ${o.upiLink}` : ''}` : '',
    o.points && (o.points.earned || o.points.used) ? `⭐ +${o.points.earned} points · balance ${o.points.balance} points` : '',
    o.link ? `Receipt: ${o.link}` : '', 'See you again!'].filter(Boolean).join('\n');
  const ml = [`ഹായ് ${first(o.name)}, ${o.centre}-ൽ കളിക്കാൻ വന്നതിന് നന്ദി! 🎮`, `ബിൽ ${o.billNo}`, gamesMl, items,
    o.discount ? `ഡിസ്കൗണ്ട് −${formatINR(o.discount)}` : '', o.points?.used ? `പോയിന്റ് (${o.points.used}) −${formatINR(o.points.usedPaise)}` : '',
    o.tax ? `GST ${formatINR(o.tax)}` : '',
    `ആകെ ${formatINR(o.total)}`, o.paid ? `അടച്ചത് ${formatINR(o.paid)} (${o.methods})` : '', due > 0 ? `ബാക്കി ${formatINR(due)}${o.upiLink ? `\nUPI വഴി അടയ്ക്കാം: ${o.upiLink}` : ''}` : '',
    o.points && (o.points.earned || o.points.used) ? `⭐ +${o.points.earned} പോയിന്റ് · ആകെ ${o.points.balance} പോയിന്റ്` : '',
    o.link ? `രസീത്: ${o.link}` : '', 'വീണ്ടും കാണാം!'].filter(Boolean).join('\n');
  return { en, ml };
}

/** upi://pay link with the exact amount (works with GPay, PhonePe, Paytm, BHIM). */
export function upiLink(upiId: string, payee: string, amountPaise: number, note: string) {
  const p = new URLSearchParams({ pa: upiId, pn: payee.slice(0, 40), am: (amountPaise / 100).toFixed(2), cu: 'INR', tn: note.slice(0, 40) });
  return `upi://pay?${p.toString()}`;
}

/** Short caption sent WITH a receipt image (the image has all the details; no links). */
export function receiptCaption(centre: string, name: string, duePaise: number): WaPair {
  const f = first(name);
  return {
    en: duePaise > 0 ? `Hi ${f}, here's your bill from ${centre}. ${formatINR(duePaise)} is pending — scan the UPI QR in the image to pay. Thank you!` : `Hi ${f}, thanks for playing at ${centre}! Here's your receipt 🎮`,
    ml: duePaise > 0 ? `ഹായ് ${f}, ${centre}-ലെ നിങ്ങളുടെ ബിൽ. ${formatINR(duePaise)} ബാക്കിയുണ്ട് — ചിത്രത്തിലെ UPI QR സ്കാൻ ചെയ്ത് അടയ്ക്കാം. നന്ദി!` : `ഹായ് ${f}, ${centre}-ൽ കളിക്കാൻ വന്നതിന് നന്ദി! നിങ്ങളുടെ രസീത് 🎮`,
  };
}

export function ticketCaption(centre: string, name: string, when: string): WaPair {
  const f = first(name);
  return {
    en: `Hi ${f}, your booking at ${centre} is confirmed for ${when}. Show the QR in this image at the counter.`,
    ml: `ഹായ് ${f}, ${centre}-ൽ ${when}-ന് നിങ്ങളുടെ ബുക്കിംഗ് ഉറപ്പായി. ഈ ചിത്രത്തിലെ QR കൗണ്ടറിൽ കാണിക്കൂ.`,
  };
}

export function startedCaption(centre: string, name: string): WaPair {
  const f = first(name);
  return { en: `Hi ${f}! Welcome to ${centre} 🎮 Your game details are in the image. Have fun!`, ml: `ഹായ് ${f}! ${centre}-ലേക്ക് സ്വാഗതം 🎮 കളിയുടെ വിവരങ്ങൾ ചിത്രത്തിലുണ്ട്. ആസ്വദിക്കൂ!` };
}
