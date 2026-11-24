// XS AI — rule-based command parser (no AI tokens). English, Malayalam and Manglish.
// Turns "snooker 1 start 1 hour 2 players", "PS5 #2 extend 30 min", "add 2 coke to table 3",
// "ഇന്നത്തെ കളക്ഷൻ എത്ര?" or "4 pool 2 snooker 6 ps5" into a structured intent.
// Anything it can't understand returns { type: 'unknown' } — the app never guesses an action.

export type Named = { id: string; name: string };
export type Ctx = { resources: Named[]; products: Named[]; activities: Named[] };
export type Metric = 'revenue_today' | 'customers_today' | 'bills_today' | 'best_game_today' | 'revenue_month' | 'expenses_month' | 'net_month' | 'busy_now';
export type Intent =
  | { type: 'start'; resource: Named; minutes: number | null; players: number | null }
  | { type: 'extend'; resource: Named; minutes: number }
  | { type: 'pause' | 'resume' | 'end'; resource: Named }
  | { type: 'add_item'; resource: Named; product: Named; qty: number }
  | { type: 'waiting' } | { type: 'free' }
  | { type: 'ask'; metric: Metric }
  | { type: 'layout'; counts: { activity: Named; count: number }[] }
  | { type: 'unknown'; reason?: string };

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, sixty: 60,
  'ഒന്ന്': 1, 'ഒരു': 1, 'രണ്ട്': 2, 'രണ്ടു': 2, 'മൂന്ന്': 3, 'നാല്': 4, 'അഞ്ച്': 5, 'ആറ്': 6, 'ഏഴ്': 7, 'എട്ട്': 8, 'ഒമ്പത്': 9, 'പത്ത്': 10,
  'പതിനഞ്ച്': 15, 'ഇരുപത്': 20, 'മുപ്പത്': 30,
};

/** Lower-case, spoken number words → digits, "#"/punctuation removed, "ps 5" → "ps5". */
export function normalize(text: string): string {
  let t = ` ${text.toLowerCase().replace(/[#,.!?।]/g, ' ').replace(/\s+/g, ' ')} `;
  for (const [w, n] of Object.entries(NUM_WORDS)) t = t.replaceAll(` ${w} `, ` ${n} `).replaceAll(` ${w} `, ` ${n} `);
  t = t.replace(/\bps\s*(\d)\b/g, 'ps$1').replace(/\bplay ?station ?(\d)/g, 'ps$1').replace(/(\d)\s*(hrs?|hours?|mins?|minutes?)\b/g, '$1 $2');
  return t.replace(/\s+/g, ' ').trim();
}
const key = (name: string) => normalize(name).replace(/\s+/g, ' ');

/** Best matching item: the longest item name found in the text; "table 3" matches the only item numbered 3 whose name is a table game. */
function findIn<T extends Named>(text: string, items: T[], tableWord = false): T | null {
  const hits = items.map((i) => ({ i, k: key(i.name) })).filter((x) => x.k && ` ${text} `.includes(` ${x.k} `)).sort((a, b) => b.k.length - a.k.length);
  if (hits.length) return hits[0].i;
  // "ps5 2" → "PS5 #2" (normalised "ps5 2"); "snooker one" handled by normalize
  if (tableWord) {
    const m = text.match(/\b(?:table|ടേബിൾ)\s*(\d+)\b/);
    if (m) {
      const same = items.filter((i) => new RegExp(`\\b${m[1]}$`).test(key(i.name)) && /snooker|pool|table|billiard|carrom/i.test(i.name));
      if (same.length === 1) return same[0];
    }
  }
  return null;
}

/** Minutes from "30 min", "1 hour", "1.5 hours", "half an hour", "അര മണിക്കൂർ", "ഒരു മണിക്കൂർ". */
export function minutesIn(text: string): number | null {
  if (/half (an )?h(ou)?r|അര മണിക്കൂ/.test(text)) return 30;
  text = text.replace(/\b(\d+(?:\.\d+)?) (?:more|extra) /g, '$1 ');   // "1 more hour", "30 extra minutes"
  let m = text.match(/(\d+(?:\.\d+)?)\s*(?:hrs?|hours?|h|മണിക്കൂ\S*)\b/) ?? text.match(/(\d+(?:\.\d+)?)\s*മണിക്കൂ/);
  if (m) return Math.round(parseFloat(m[1]) * 60);
  m = text.match(/(\d+)\s*(?:mins?|minutes?|m|മിനിറ്റ്\S*|മിനുട്ട്\S*)(?:\s|$)/);
  if (m) return parseInt(m[1], 10);
  if (/\b(?:an|one) hour\b|മണിക്കൂർ/.test(text)) return 60;
  return null;
}
function playersIn(text: string): number | null {
  const m = text.match(/(\d+)\s*(?:players?|people|persons?|പേർ|ആൾ\S*)/) ?? text.match(/\bfor (\d+)(?!\s*(?:mins?|minutes?|hrs?|hours?))\b/);
  return m ? parseInt(m[1], 10) : null;
}

const has = (t: string, ...words: string[]) => words.some((w) => (/^[a-z ]+$/.test(w) ? new RegExp(`\\b${w}\\b`).test(t) : t.includes(w)));

export function parse(raw: string, ctx: Ctx): Intent {
  const t = normalize(raw);
  if (!t) return { type: 'unknown' };

  // ── questions (no action, no approval)
  const month = has(t, 'month', 'this month', 'മാസ');
  if (has(t, 'profit', 'net', 'ലാഭം')) return { type: 'ask', metric: 'net_month' };
  if (has(t, 'expense', 'expenses', 'spent', 'ചെലവ്', 'ചിലവ്')) return { type: 'ask', metric: 'expenses_month' };
  if (has(t, 'best', 'top', 'most', 'popular', 'കൂടുതൽ')) if (has(t, 'game', 'games', 'activity', 'കളി', 'ഗെയിം')) return { type: 'ask', metric: 'best_game_today' };
  if (has(t, 'revenue', 'sales', 'collection', 'income', 'earned', 'കളക്ഷൻ', 'വരുമാനം', 'കിട്ടി')) return { type: 'ask', metric: month ? 'revenue_month' : 'revenue_today' };
  if (has(t, 'customers', 'customer', 'people came', 'ആളുകൾ', 'കസ്റ്റമേഴ്സ്', 'കസ്റ്റമർ')) return { type: 'ask', metric: 'customers_today' };
  if (has(t, 'bills', 'how many bills', 'ബില്ല്')) return { type: 'ask', metric: 'bills_today' };
  if (has(t, 'waiting', 'waitlist', 'queue', 'കാത്തിരിക്കു', 'വെയിറ്റിംഗ്')) return { type: 'waiting' };
  if (has(t, 'free', 'available', 'empty', 'ഫ്രീ', 'ഒഴിവ്')) return { type: 'free' };
  if (has(t, 'busy', 'playing now', 'how many playing', 'കളിക്കുന്ന')) return { type: 'ask', metric: 'busy_now' };

  // ── layout: "4 pool 2 snooker 6 ps5"
  const counts: { activity: Named; count: number }[] = [];
  for (const a of ctx.activities) {
    const k = key(a.name).replace(/^ps5$/, 'ps5');
    const m = t.match(new RegExp(`(\\d+)\\s*(?:x\\s*)?${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) ?? t.match(new RegExp(`${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[x×:]\\s*(\\d+)`));
    if (m) counts.push({ activity: a, count: Math.min(parseInt(m[1], 10), 40) });
  }
  if (counts.length >= 2 || (counts.length === 1 && has(t, 'layout', 'floor', 'ലേഔട്ട്'))) return { type: 'layout', counts };

  // ── actions on a table / console / track
  const product = findIn(t, ctx.products);
  const resource = findIn(product ? t.replace(key(product.name), ' ') : t, ctx.resources, true);
  if (product && (has(t, 'add', 'give', 'ചേർക്ക്', 'കൊടുക്ക്') || /^\d+ /.test(t))) {
    if (!resource) return { type: 'unknown', reason: `Which table gets the ${product.name}?` };
    const q = t.match(new RegExp(`(\\d+)\\s*(?:x\\s*)?${key(product.name).split(' ')[0]}`));
    return { type: 'add_item', resource, product, qty: q ? Math.min(parseInt(q[1], 10), 50) : 1 };
  }
  if (!resource) return { type: 'unknown', reason: 'Say the table, console or track name, e.g. "Snooker 1 start 1 hour".' };
  if (has(t, 'extend', 'add', 'more', 'extra', 'കൂട്ട്', 'എക്സ്റ്റൻഡ്', 'കൂടി')) {
    const minutes = minutesIn(t.replace(key(resource.name), ' '));
    return minutes ? { type: 'extend', resource, minutes } : { type: 'unknown', reason: 'How many minutes? e.g. "extend 30 min".' };
  }
  if (has(t, 'pause', 'hold', 'പോസ്')) return { type: 'pause', resource };
  if (has(t, 'resume', 'continue', 'unpause', 'തുടര്', 'റിസ്യൂം')) return { type: 'resume', resource };
  if (has(t, 'stop', 'end', 'finish', 'close', 'bill', 'done', 'നിർത്ത്', 'നിർത്തൂ', 'തീർന്നു', 'ബിൽ')) return { type: 'end', resource };
  if (has(t, 'start', 'begin', 'open', 'play', 'തുടങ്ങ്', 'തുടങ്ങൂ', 'സ്റ്റാർട്ട്')) {
    const rest = t.replace(key(resource.name), ' ');
    return { type: 'start', resource, minutes: minutesIn(rest), players: playersIn(rest) };
  }
  return { type: 'unknown', reason: `What should I do with ${resource.name}? Start, extend, pause, resume or stop.` };
}
