// Branded images for WhatsApp (receipt, ticket, offer, game started, day summary).
// Drawn on a canvas in the browser, 1080 px wide, with the CENTRE's name as the brand.
// QR codes replace links, so nothing goes out as a bare link.
import QRCode from 'qrcode';
import { mediaUrl } from './media';
import { formatINR } from './money';

export type Lang = 'en' | 'ml';
export type CardCentre = { name: string; address?: string | null; city?: string | null; phone?: string | null; logo_path?: string | null };

/** Load a stored picture for drawing; null if it can't load within 5 s (the image is still made, just without it). */
export function loadImage(url: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((res) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    const t = window.setTimeout(() => res(null), 5000);
    img.onload = () => { window.clearTimeout(t); res(img); };
    img.onerror = () => { window.clearTimeout(t); res(null); };
    img.src = url;
  });
}

const W = 1080;
const PAD = 72;
const INK = '#141416';
const SUB = '#6B6B73';
const HAIR = '#E6E6E1';
const PAPER = '#FFFFFF';
const BAND = '#121214';
const ACCENT = '#22C55E';

function font(): string {
  if (typeof document === 'undefined') return 'system-ui, sans-serif';
  const f = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  return `${f}, "Noto Sans Malayalam", "Manjari", sans-serif`;
}

/** A tall scratch canvas we draw into top-to-bottom, then crop to the content. */
class Card {
  c: HTMLCanvasElement;
  x: CanvasRenderingContext2D;
  y = 0;
  f = font();
  constructor(max = 5200) {
    this.c = document.createElement('canvas');
    this.c.width = W; this.c.height = max;
    this.x = this.c.getContext('2d')!;
    this.x.fillStyle = PAPER; this.x.fillRect(0, 0, W, max);
    this.x.textBaseline = 'alphabetic';
  }
  set(size: number, weight = 400, color = INK) { this.x.font = `${weight} ${size}px ${this.f}`; this.x.fillStyle = color; }
  /** Wrapped text block; returns lines drawn. */
  text(t: string, o: { size?: number; weight?: number; color?: string; align?: CanvasTextAlign; x?: number; w?: number; gap?: number } = {}) {
    const size = o.size ?? 36; const lh = Math.round(size * 1.3);
    this.set(size, o.weight ?? 400, o.color ?? INK);
    this.x.textAlign = o.align ?? 'left';
    const maxW = o.w ?? W - PAD * 2;
    const x0 = o.x ?? (o.align === 'center' ? W / 2 : o.align === 'right' ? W - PAD : PAD);
    const lines: string[] = [];
    for (const para of t.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const tryLine = line ? `${line} ${word}` : word;
        if (this.x.measureText(tryLine).width > maxW && line) { lines.push(line); line = word; } else line = tryLine;
      }
      lines.push(line);
    }
    for (const l of lines) { this.y += lh; this.x.fillText(l, x0, this.y - Math.round(size * 0.28)); }
    this.y += o.gap ?? 0;
    return lines.length;
  }
  /** Label on the left, value on the right, one line. */
  row(label: string, value: string, o: { size?: number; weight?: number; color?: string; vcolor?: string } = {}) {
    const size = o.size ?? 34; const lh = Math.round(size * 1.45);
    this.y += lh;
    const base = this.y - Math.round(size * 0.4);
    this.set(size, o.weight ?? 400, o.color ?? INK);
    this.x.textAlign = 'right'; const vw = this.x.measureText(value).width;
    this.x.fillStyle = o.vcolor ?? o.color ?? INK; this.x.fillText(value, W - PAD, base);
    this.x.fillStyle = o.color ?? INK; this.x.textAlign = 'left';
    let l = label; const room = W - PAD * 2 - vw - 24;
    while (this.x.measureText(l).width > room && l.length > 3) l = `${l.slice(0, -2)}…`;
    this.x.fillText(l, PAD, base);
  }
  space(h: number) { this.y += h; }
  rule(dashed = false) {
    this.y += 18; this.x.strokeStyle = HAIR; this.x.lineWidth = 3; this.x.setLineDash(dashed ? [14, 12] : []);
    this.x.beginPath(); this.x.moveTo(PAD, this.y); this.x.lineTo(W - PAD, this.y); this.x.stroke(); this.x.setLineDash([]); this.y += 18;
  }
  /** Dark header band with the centre's name — the centre's brand, not ours. */
  async header(centre: CardCentre, eyebrow: string) {
    const logo = await loadImage(mediaUrl(centre.logo_path));
    const top = this.y;
    const where = [centre.address, centre.city].filter(Boolean).join(', ');
    const LOGO = 132;
    this.y += 64;
    // measure first, then paint the band behind
    const nameLines = this.wrapCount(centre.name, 64, 700);
    const h = 64 + (logo ? LOGO + 28 : 0) + 44 + nameLines * 84 + (where ? 48 : 0) + (centre.phone ? 44 : 0) + 56;
    this.x.fillStyle = BAND; this.x.fillRect(0, top, W, h);
    // soft accent glow
    const g = this.x.createRadialGradient(W - 120, top + 40, 10, W - 120, top + 40, 420);
    g.addColorStop(0, 'rgba(34,197,94,.28)'); g.addColorStop(1, 'rgba(34,197,94,0)');
    this.x.fillStyle = g; this.x.fillRect(0, top, W, h);
    if (logo) {
      // the centre's logo on a white rounded tile, so dark and transparent logos both show
      const lx = PAD, ly = this.y, r = 28;
      this.x.save();
      this.x.beginPath(); this.x.roundRect(lx, ly, LOGO, LOGO, r); this.x.fillStyle = '#FFFFFF'; this.x.fill(); this.x.clip();
      const sc = Math.min((LOGO - 16) / logo.width, (LOGO - 16) / logo.height);
      const dw = logo.width * sc, dh = logo.height * sc;
      this.x.drawImage(logo, lx + (LOGO - dw) / 2, ly + (LOGO - dh) / 2, dw, dh);
      this.x.restore();
      this.y += LOGO + 28;
    }
    this.text(eyebrow.toUpperCase(), { size: 28, weight: 700, color: ACCENT });
    this.space(8);
    this.text(centre.name, { size: 64, weight: 800, color: '#FFFFFF' });
    if (where) this.text(where, { size: 30, color: '#C9C9CF' });
    if (centre.phone) this.text(`☎ ${centre.phone}`, { size: 30, color: '#C9C9CF' });
    this.y = top + h + 36;
  }
  wrapCount(t: string, size: number, weight: number) {
    this.set(size, weight); let n = 0; let line = '';
    for (const word of t.split(' ')) { const tl = line ? `${line} ${word}` : word; if (this.x.measureText(tl).width > W - PAD * 2 && line) { n++; line = word; } else line = tl; }
    return n + 1;
  }
  async qr(text: string, size: number, caption?: string) {
    const q = document.createElement('canvas');
    await QRCode.toCanvas(q, text, { margin: 1, width: size, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#FFFFFF' } });
    this.y += 12;
    this.x.drawImage(q, (W - size) / 2, this.y);
    this.y += size + 8;
    if (caption) this.text(caption, { size: 30, color: SUB, align: 'center' });
  }
  /** The centre's own uploaded QR picture, centred. */
  picture(img: HTMLImageElement, size: number, caption?: string) {
    const sc = Math.min(size / img.width, size / img.height);
    const dw = img.width * sc, dh = img.height * sc;
    this.y += 12;
    this.x.drawImage(img, (W - dw) / 2, this.y, dw, dh);
    this.y += dh + 8;
    if (caption) this.text(caption, { size: 30, color: SUB, align: 'center' });
  }
  footer(line: string) {
    this.space(28);
    this.text(line, { size: 34, weight: 600, align: 'center' });
    this.space(10);
    this.space(PAD - 30);
    // small XS Arena strip at the bottom — like "Paid via Google Pay" on a shared GPay receipt
    const top = this.y, h = 92;
    this.x.fillStyle = '#F4F4F1'; this.x.fillRect(0, top, W, h);
    this.y = top + 4;
    this.text('Powered by XS Arena · xelorsoft.com', { size: 26, weight: 600, color: '#8A8A93', align: 'center' });
    this.text('Software for gaming centres', { size: 22, color: '#A5A5AD', align: 'center' });
    this.y = top + h;
  }
  async blob(): Promise<Blob> {
    const out = document.createElement('canvas');
    out.width = W; out.height = Math.ceil(this.y);
    const o = out.getContext('2d')!;
    o.drawImage(this.c, 0, 0);
    return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Could not make the image'))), 'image/png'));
  }
}

const L = {
  en: { receipt: 'Receipt', bill: 'Bill', total: 'Total', paid: 'Paid', due: 'Balance due', sub: 'Subtotal', disc: 'Discount', pts: 'Points used',
    payUpi: 'Scan to pay by UPI', payOwn: (a: string) => `Scan with any UPI app and pay ${a}`, thanks: 'Thanks for playing! See you again 🎮', bookNext: 'Scan to book your next game', in: 'In', out: 'Out',
    ticket: 'Booking confirmed', code: 'Booking code', show: 'Show this QR at the counter', hold: (m: number) => `We keep your booking for ${m} min after your time.`,
    players: (n: number) => `${n} player${n > 1 ? 's' : ''}`, offer: 'Special offer', offerShow: 'Show this message at the counter',
    started: 'Game started', startedAt: 'Started at', until: 'Booked till', rate: 'Rate', enjoy: 'Have fun! 🎮', earned: (e: number, b: number) => `⭐ +${e} points · balance ${b}` },
  ml: { receipt: 'രസീത്', bill: 'ബിൽ', total: 'ആകെ', paid: 'അടച്ചത്', due: 'ബാക്കി', sub: 'തുക', disc: 'ഡിസ്കൗണ്ട്', pts: 'പോയിന്റ്',
    payUpi: 'UPI വഴി അടയ്ക്കാൻ സ്കാൻ ചെയ്യൂ', payOwn: (a: string) => `ഏത് UPI ആപ്പിലും സ്കാൻ ചെയ്ത് ${a} അടയ്ക്കൂ`, thanks: 'കളിക്കാൻ വന്നതിന് നന്ദി! വീണ്ടും വരൂ 🎮', bookNext: 'അടുത്ത കളി ബുക്ക് ചെയ്യാൻ സ്കാൻ ചെയ്യൂ', in: 'തുടക്കം', out: 'അവസാനം',
    ticket: 'ബുക്കിംഗ് ഉറപ്പായി', code: 'ബുക്കിംഗ് കോഡ്', show: 'ഈ QR കൗണ്ടറിൽ കാണിക്കൂ', hold: (m: number) => `നിങ്ങളുടെ സമയത്തിന് ശേഷം ${m} മിനിറ്റ് വരെ ബുക്കിംഗ് നിലനിർത്തും.`,
    players: (n: number) => `${n} പേർ`, offer: 'സ്പെഷ്യൽ ഓഫർ', offerShow: 'ഈ മെസ്സേജ് കൗണ്ടറിൽ കാണിക്കൂ',
    started: 'കളി തുടങ്ങി', startedAt: 'തുടങ്ങിയത്', until: 'വരെ', rate: 'നിരക്ക്', enjoy: 'ആസ്വദിക്കൂ! 🎮', earned: (e: number, b: number) => `⭐ +${e} പോയിന്റ് · ആകെ ${b}` },
};

const time = (iso: string, tz: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
const day = (iso: string, tz: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(new Date(iso));
const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);

/* ───────────────────────── Receipt ───────────────────────── */
export type ReceiptCardData = {
  centre: CardCentre; tz: string; lang: Lang; billNo: string; createdAt: string; customer?: string | null;
  games: { resource: string; started_at: string; ended_at: string | null; minutes: number; amount_paise: number; lines: { label: string; amount_paise: number }[] }[];
  items: { name: string; qty: number; total_paise: number }[];
  subtotal: number; discount: number; pointsUsed?: number; pointsPaise?: number; tax: number; gstRate?: number; total: number; paid: number; methods?: string;
  earned?: { earned: number; balance: number } | null; upi?: string | null; bookingUrl?: string | null; voided?: boolean;
  /** Name shown in the UPI app (defaults to the centre name). */
  upiPayee?: string | null;
  /** The centre's own uploaded QR (Settings → "My uploaded QR"): drawn instead of an exact-amount QR. */
  upiQrPath?: string | null;
};

export async function receiptCard(d: ReceiptCardData): Promise<Blob> {
  const t = L[d.lang]; const k = new Card();
  await k.header(d.centre, t.receipt);
  k.row(`${t.bill} ${d.billNo}`, `${day(d.createdAt, d.tz)}, ${time(d.createdAt, d.tz)}`, { size: 30, color: SUB });
  if (d.customer) k.text(d.customer, { size: 38, weight: 700 });
  k.rule();
  for (const g of d.games) {
    k.row(g.resource, formatINR(g.amount_paise), { size: 38, weight: 700 });
    k.row(`${t.in} ${time(g.started_at, d.tz)} · ${t.out} ${g.ended_at ? time(g.ended_at, d.tz) : '—'}`, mins(g.minutes), { size: 30, color: SUB });
    for (const l of g.lines) k.row(l.label, formatINR(l.amount_paise), { size: 28, color: SUB });
    k.space(10);
  }
  for (const i of d.items) k.row(`${i.name} × ${Number(i.qty)}`, formatINR(i.total_paise), { size: 34 });
  k.rule(true);
  if (d.discount || d.pointsPaise || d.tax) k.row(t.sub, formatINR(d.subtotal), { size: 32, color: SUB });
  if (d.discount) k.row(t.disc, `−${formatINR(d.discount)}`, { size: 32, color: SUB });
  if (d.pointsPaise) k.row(`${t.pts} (${d.pointsUsed})`, `−${formatINR(d.pointsPaise)}`, { size: 32, color: SUB });
  if (d.tax) k.row(`GST ${(d.gstRate ?? 0) / 100}%`, formatINR(d.tax), { size: 32, color: SUB });
  k.row(t.total, formatINR(d.total), { size: 56, weight: 800 });
  if (d.paid) k.row(`${t.paid}${d.methods ? ` · ${d.methods}` : ''}`, formatINR(d.paid), { size: 32, color: SUB });
  const due = d.voided ? 0 : d.total - d.paid;
  if (due > 0) k.row(t.due, formatINR(due), { size: 40, weight: 800, vcolor: '#C2410C' });
  if (d.earned && d.earned.earned) { k.space(8); k.text(t.earned(d.earned.earned, d.earned.balance), { size: 32, weight: 600, color: '#15803D' }); }
  const ownQr = due > 0 && d.upiQrPath ? await loadImage(mediaUrl(d.upiQrPath)) : null;
  if (ownQr) {
    k.rule(); k.picture(ownQr, 420, t.payOwn(formatINR(due)));
  } else if (due > 0 && d.upi) {
    const p = new URLSearchParams({ pa: d.upi, pn: (d.upiPayee || d.centre.name).slice(0, 40), am: (due / 100).toFixed(2), cu: 'INR', tn: d.billNo });
    k.rule(); await k.qr(`upi://pay?${p.toString()}`, 360, `${t.payUpi} · ${formatINR(due)}`);
  } else if (d.bookingUrl) {
    k.rule(); await k.qr(d.bookingUrl, 260, t.bookNext);
  }
  k.footer(t.thanks);
  return k.blob();
}

/* ───────────────────────── Booking ticket ───────────────────────── */
export async function ticketCard(d: {
  centre: CardCentre; tz: string; lang: Lang; activity: string; startsAt: string; minutes: number; party: number; name: string; code: string; qrText: string; holdMinutes?: number;
}): Promise<Blob> {
  const t = L[d.lang]; const k = new Card();
  await k.header(d.centre, t.ticket);
  k.text(d.activity, { size: 60, weight: 800 });
  k.text(`${day(d.startsAt, d.tz)} · ${time(d.startsAt, d.tz)}`, { size: 46, weight: 700, color: '#15803D' });
  k.text(`${mins(d.minutes)} · ${t.players(d.party)} · ${d.name}`, { size: 34, color: SUB, gap: 8 });
  k.rule();
  await k.qr(d.qrText, 460, t.show);
  k.space(10);
  k.text(t.code, { size: 28, color: SUB, align: 'center' });
  k.text(d.code.split('').join(' '), { size: 72, weight: 800, align: 'center' });
  if (d.holdMinutes) { k.space(12); k.text(t.hold(d.holdMinutes), { size: 28, color: SUB, align: 'center' }); }
  k.footer(t.enjoy);
  return k.blob();
}

/* ───────────────────────── Offer poster ───────────────────────── */
export async function offerCard(d: { centre: CardCentre; lang: Lang; offer: string; bookingUrl?: string | null }): Promise<Blob> {
  const t = L[d.lang]; const k = new Card();
  await k.header(d.centre, t.offer);
  k.space(10);
  k.text(d.offer || '…', { size: 64, weight: 800, align: 'center', gap: 12 });
  k.text(t.offerShow, { size: 30, color: SUB, align: 'center' });
  if (d.bookingUrl) { k.rule(); await k.qr(d.bookingUrl, 320, t.bookNext); }
  k.footer(t.enjoy);
  return k.blob();
}

/* ───────────────────────── Game started ───────────────────────── */
export async function startedCard(d: { centre: CardCentre; tz: string; lang: Lang; resource: string; startedAt: string; planned: number | null; name: string; rate: string }): Promise<Blob> {
  const t = L[d.lang]; const k = new Card();
  await k.header(d.centre, t.started);
  k.text(d.resource, { size: 64, weight: 800 });
  k.text(d.name, { size: 36, color: SUB, gap: 6 });
  k.rule();
  k.row(t.startedAt, time(d.startedAt, d.tz), { size: 44, weight: 800 });
  if (d.planned) k.row(t.until, time(new Date(Date.parse(d.startedAt) + d.planned * 60000).toISOString(), d.tz), { size: 44, weight: 800, vcolor: '#15803D' });
  k.row(t.rate, d.rate, { size: 32, color: SUB });
  k.footer(t.enjoy);
  return k.blob();
}

/* ───────────────────────── Day summary (owner) ───────────────────────── */
export async function summaryCard(d: {
  centre: CardCentre; date: string; revenue: number; expenses: number; net: number; bills: number; games: number; customers: number;
  byGame: { name: string; amount_paise: number }[]; snacks: number; byMethod: Record<string, number>; unpaid: number; alerts: number;
}): Promise<Blob> {
  const k = new Card();
  await k.header(d.centre, `Day summary · ${new Date(`${d.date}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`);
  k.row('Sales', formatINR(d.revenue), { size: 56, weight: 800 });
  k.row('Expenses', `−${formatINR(d.expenses)}`, { size: 36, color: SUB });
  k.row('Net', formatINR(d.net), { size: 44, weight: 800, vcolor: d.net < 0 ? '#C2410C' : '#15803D' });
  k.rule();
  k.row(`${d.bills} bills · ${d.games} games · ${d.customers} customers`, '', { size: 30, color: SUB });
  for (const g of d.byGame) k.row(g.name, formatINR(g.amount_paise), { size: 34 });
  if (d.snacks) k.row('Snacks & drinks', formatINR(d.snacks), { size: 34 });
  const off = d.byGame.reduce((a, g) => a + g.amount_paise, 0) + d.snacks - d.revenue;   // points, rewards and discounts
  if (off > 0) k.row('Points & discounts', `−${formatINR(off)}`, { size: 34, color: SUB });
  const m = Object.entries(d.byMethod);
  if (m.length) { k.rule(true); for (const [meth, amt] of m) k.row(meth.toUpperCase(), formatINR(amt), { size: 32, color: SUB }); }
  if (d.unpaid) k.row('Still to collect', formatINR(d.unpaid), { size: 34, weight: 700, vcolor: '#C2410C' });
  if (d.alerts) { k.space(8); k.text(`⚠ ${d.alerts} thing${d.alerts > 1 ? 's' : ''} to check — open Day summary`, { size: 30, weight: 600, color: '#C2410C' }); }
  k.footer('Good work today!');
  return k.blob();
}
