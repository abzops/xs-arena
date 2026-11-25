import { describe, expect, it } from 'vitest';
import { minutesIn, normalize, parse, type Ctx } from './parse';

const ctx: Ctx = {
  resources: [
    { id: 's1', name: 'Snooker 1' }, { id: 's2', name: 'Snooker 2' }, { id: 'p1', name: 'Pool 1' },
    { id: 'x1', name: 'PS5 #1' }, { id: 'x2', name: 'PS5 #2' }, { id: 'rd', name: 'RC Drift track' },
  ],
  products: [{ id: 'coke', name: 'Coke' }, { id: 'sd', name: 'Soft drink' }, { id: 'chips', name: 'Lays chips' }],
  activities: [{ id: 'a1', name: 'Snooker' }, { id: 'a2', name: 'Pool' }, { id: 'a3', name: 'PS5' }, { id: 'a4', name: 'RC Drift' }],
};
const p = (s: string) => parse(s, ctx);

describe('normalize + durations', () => {
  it('turns spoken numbers and "PS 5" into digits', () => {
    expect(normalize('PS 5 number two')).toBe('ps5 number 2');
    expect(normalize('Snooker One START')).toBe('snooker 1 start');
  });
  it('reads durations in English and Malayalam', () => {
    expect(minutesIn('1 hour')).toBe(60);
    expect(minutesIn('1.5 hours')).toBe(90);
    expect(minutesIn('30 min')).toBe(30);
    expect(minutesIn('half an hour')).toBe(30);
    expect(minutesIn(normalize('ഒരു മണിക്കൂർ'))).toBe(60);
    expect(minutesIn(normalize('അര മണിക്കൂർ'))).toBe(30);
    expect(minutesIn(normalize('2 മണിക്കൂർ'))).toBe(120);
  });
});

describe('table actions', () => {
  it('start with time and players', () => {
    expect(p('Snooker 1 start 1 hour 2 players')).toEqual({ type: 'start', resource: ctx.resources[0], minutes: 60, players: 2 });
    expect(p('start ps5 #2 for 30 minutes')).toMatchObject({ type: 'start', resource: { id: 'x2' }, minutes: 30, players: null });
    expect(p('PS 5 two start open timer')).toMatchObject({ type: 'start', resource: { id: 'x2' }, minutes: null });
  });
  it('picks Snooker 1 not Snooker 12 style partial matches', () => {
    expect(p('pool 1 start')).toMatchObject({ resource: { id: 'p1' } });
  });
  it('extend / pause / resume / stop', () => {
    expect(p('PS5 1 extend 30 min')).toEqual({ type: 'extend', resource: ctx.resources[3], minutes: 30 });
    expect(p('snooker 2 add one more hour')).toMatchObject({ type: 'extend', resource: { id: 's2' }, minutes: 60 });
    expect(p('pause snooker 1')).toMatchObject({ type: 'pause', resource: { id: 's1' } });
    expect(p('resume snooker 1')).toMatchObject({ type: 'resume', resource: { id: 's1' } });
    expect(p('pool 1 stop')).toMatchObject({ type: 'end', resource: { id: 'p1' } });
  });
  it('Malayalam / Manglish commands', () => {
    expect(p('സ്നൂക്കർ 1 സ്റ്റാർട്ട്')).toMatchObject({ type: 'unknown' }); // table names must match what is on the floor
    expect(p('snooker 1 തുടങ്ങ് ഒരു മണിക്കൂർ')).toMatchObject({ type: 'start', resource: { id: 's1' }, minutes: 60 });
    expect(p('ps5 2 അര മണിക്കൂർ കൂട്ട്')).toMatchObject({ type: 'extend', resource: { id: 'x2' }, minutes: 30 });
    expect(p('pool 1 നിർത്ത്')).toMatchObject({ type: 'end', resource: { id: 'p1' } });
  });
  it('"table 3" style only when it is unambiguous', () => {
    expect(p('table 2 start')).toMatchObject({ type: 'start', resource: { id: 's2' } });
    expect(p('table 1 start')).toMatchObject({ type: 'unknown' }); // Snooker 1 and Pool 1 — ask instead of guessing
  });
  it('needs a duration to extend', () => {
    expect(p('extend snooker 1')).toMatchObject({ type: 'unknown' });
  });
});

describe('snacks', () => {
  it('adds products to a table', () => {
    expect(p('add 2 coke to snooker 2')).toEqual({ type: 'add_item', resource: ctx.resources[1], product: ctx.products[0], qty: 2 });
    expect(p('3 soft drink ps5 1')).toMatchObject({ type: 'add_item', resource: { id: 'x1' }, product: { id: 'sd' }, qty: 3 });
    expect(p('add coke')).toMatchObject({ type: 'unknown' });
  });
});

describe('questions', () => {
  it('owner questions in English and Malayalam', () => {
    expect(p("What's today's revenue?")).toEqual({ type: 'ask', metric: 'revenue_today' });
    expect(p('collection this month')).toEqual({ type: 'ask', metric: 'revenue_month' });
    expect(p('ഇന്നത്തെ കളക്ഷൻ എത്ര')).toEqual({ type: 'ask', metric: 'revenue_today' });
    expect(p('how many customers today')).toEqual({ type: 'ask', metric: 'customers_today' });
    expect(p('best selling game today')).toEqual({ type: 'ask', metric: 'best_game_today' });
    expect(p('net profit this month')).toEqual({ type: 'ask', metric: 'net_month' });
    expect(p('ഈ മാസത്തെ ലാഭം')).toEqual({ type: 'ask', metric: 'net_month' });
    expect(p('expenses this month')).toEqual({ type: 'ask', metric: 'expenses_month' });
    expect(p("who's waiting?")).toEqual({ type: 'waiting' });
    expect(p('which tables are free')).toEqual({ type: 'free' });
  });
});

describe('layout', () => {
  it('reads counts per game', () => {
    const r = p('4 pool, 2 snooker, 6 PS5');
    expect(r.type).toBe('layout');
    if (r.type === 'layout') expect(r.counts.map((c) => [c.activity.name, c.count])).toEqual([['Snooker', 2], ['Pool', 4], ['PS5', 6]]);
  });
});

describe('unknown', () => {
  it('never guesses', () => {
    expect(p('hello')).toMatchObject({ type: 'unknown' });
    expect(p('')).toEqual({ type: 'unknown' });
  });
});

describe('owner questions (24 Nov UX test)', () => {
  const c = { resources: [{ id: 'r1', name: 'Snooker 1' }], products: [], activities: [{ id: 'a1', name: 'Snooker' }] };
  it('answers dues and games today', () => {
    expect(parse('show me dues', c)).toEqual({ type: 'ask', metric: 'dues' });
    expect(parse('how many games today', c)).toEqual({ type: 'ask', metric: 'games_today' });
  });
  it('is honest about periods it cannot answer', () => {
    const r = parse('which game earns most this week?', c);
    expect(r.type).toBe('unknown');
  });
  it('gives question help, not command help, for unknown questions', () => {
    const r = parse('what is the weather?', c);
    expect(r.type === 'unknown' && r.reason).toMatch(/I can answer/);
  });
});
