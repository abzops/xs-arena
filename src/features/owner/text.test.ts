import { describe, expect, it } from 'vitest';
import type { Customer } from '../../lib/types';
import { offerText, pickRecipients, summaryText, type DaySummary } from './text';

const base: DaySummary = {
  date: '2026-11-24', centre: 'XS Arena', revenue_paise: 34000, expenses_paise: 5000, net_paise: 29000, discount_paise: 6000,
  bills: 2, customers: 2, games: 3, snacks_paise: 4000, unpaid_paise: 0, bookings: 1,
  by_game: [{ name: 'Snooker', amount_paise: 30000, games: 2 }], by_method: { cash: 20000, upi: 14000 }, alerts: [],
};

describe('summaryText', () => {
  it('has sales, games, payments and net', () => {
    const t = summaryText(base);
    expect(t).toContain('*XS Arena — Tue, 24 Nov*');
    expect(t).toContain('Sales ₹340 · 2 bills · 2 customers');
    expect(t).toContain('• Snooker: ₹300 (2)');
    expect(t).toContain('• Snacks: ₹40');
    expect(t).toContain('Cash ₹200 · UPI ₹140');
    expect(t).toContain('Expenses ₹50 → Net ₹290');
    expect(t).toContain('✅ Nothing unusual');
  });
  it('lists the things to check', () => {
    const t = summaryText({ ...base, alerts: [{ kind: 'void_bill', level: 'warn', text: 'Bill voided — ₹200: wrong table' }] });
    expect(t).toContain('⚠️ 1 to check:\n- Bill voided — ₹200: wrong table');
  });
});

describe('offerText', () => {
  it('uses the first name, offer and booking link', () => {
    expect(offerText('en', 'XS Arena', 'Rahul Nair', '1 hour free', 'https://x/b/a'))
      .toBe('Hi Rahul! Special offer at XS Arena today: 1 hour free\nBook here: https://x/b/a\nSee you soon! 🎱🎮');
  });
  it('has a Malayalam version without a link', () => {
    const t = offerText('ml', 'XS Arena', 'Anu', '50% off PS5');
    expect(t.startsWith('ഹായ് Anu!')).toBe(true);
    expect(t).not.toContain('ബുക്ക്');
  });
});

describe('pickRecipients', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const c = (id: string, last: string | null, opt = true, phone = '+919847000001'): Customer => ({
    id, centre_id: 'c', customer_no: 1, full_name: id, phone, email: null, gender: null, date_of_birth: null, anniversary: null, notes: null,
    tags: [], source: 'walk_in', marketing_opt_in: opt, visit_count: 1, total_spent_paise: 0, last_visit_at: last, status: 'active', created_at: '',
  });
  const list = [c('recent', '2026-11-22T10:00:00Z'), c('old', '2026-10-01T10:00:00Z'), c('never', null), c('optout', '2026-10-01T10:00:00Z', false),
    c('nophone', '2026-10-01T10:00:00Z', true, '')];
  it('skips people who opted out or have no phone', () => {
    expect(pickRecipients(list, 0, now).map((x) => x.id)).toEqual(['recent', 'old', 'never']);
  });
  it('"not in 7 days" leaves out recent visitors', () => {
    expect(pickRecipients(list, 7, now).map((x) => x.id)).toEqual(['old', 'never']);
  });
});
