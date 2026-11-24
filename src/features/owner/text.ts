// Plain-text builders for owner tools (WhatsApp summary, offer message, recipients). Pure — unit-tested.
import { formatDay } from '../../lib/dates';
import { formatINR } from '../../lib/money';
import type { Customer } from '../../lib/types';

export type DaySummary = {
  date: string; centre: string; revenue_paise: number; expenses_paise: number; net_paise: number; discount_paise: number;
  bills: number; customers: number; games: number; snacks_paise: number; unpaid_paise: number; bookings: number;
  by_game: { name: string; amount_paise: number; games: number }[]; by_method: Record<string, number>;
  alerts: { kind: string; level: 'warn' | 'bad'; text: string; at?: string }[];
};

export const METHOD: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', other: 'Other' };

/** Plain-text summary for WhatsApp. */
export function summaryText(s: DaySummary): string {
  const lines = [
    `*${s.centre} — ${formatDay(s.date, { weekday: 'short', day: 'numeric', month: 'short' })}*`,
    `Sales ${formatINR(s.revenue_paise)} · ${s.bills} bills · ${s.customers} customers`,
    ...s.by_game.map((g) => `• ${g.name}: ${formatINR(g.amount_paise)} (${g.games})`),
    s.snacks_paise ? `• Snacks: ${formatINR(s.snacks_paise)}` : '',
    Object.entries(s.by_method).map(([m, v]) => `${METHOD[m] ?? m} ${formatINR(v)}`).join(' · '),
    `Expenses ${formatINR(s.expenses_paise)} → Net ${formatINR(s.net_paise)}`,
    s.unpaid_paise ? `Unpaid ${formatINR(s.unpaid_paise)}` : '',
    s.alerts.length ? `⚠️ ${s.alerts.length} to check:\n${s.alerts.map((a) => `- ${a.text}`).join('\n')}` : '✅ Nothing unusual',
  ];
  return lines.filter(Boolean).join('\n');
}

export type Lang = 'en' | 'ml';

export function offerText(lang: Lang, centre: string, name: string, offer: string, link?: string): string {
  const first = name.split(' ')[0] || '';
  return lang === 'ml'
    ? `ഹായ് ${first}! ${centre}-ൽ ഇന്ന് പ്രത്യേക ഓഫർ: ${offer}${link ? `\nബുക്ക് ചെയ്യാം: ${link}` : ''}\nകാണാം! 🎱🎮`
    : `Hi ${first}! Special offer at ${centre} today: ${offer}${link ? `\nBook here: ${link}` : ''}\nSee you soon! 🎱🎮`;
}

/** Who should get the offer: opted in, has a phone, and (optionally) hasn't visited for `awayDays`. Most recent visitors first. */
export function pickRecipients(list: Customer[], awayDays: number, now: Date): Customer[] {
  const cutoff = now.getTime() - awayDays * 86_400_000;
  return list
    .filter((c) => c.status !== 'blocked' && c.marketing_opt_in && /\d{8,}/.test(c.phone.replace(/\D/g, '')))
    .filter((c) => awayDays === 0 || !c.last_visit_at || new Date(c.last_visit_at).getTime() < cutoff)
    .sort((a, b) => (b.last_visit_at ?? '').localeCompare(a.last_visit_at ?? ''));
}
