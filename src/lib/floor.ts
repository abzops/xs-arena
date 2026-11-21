// Shared types and helpers for the floor designer, live floor, bills and TV display.
import { useEffect, useState } from 'react';
import { formatINR } from './money';

export type BillingMode = 'per_minute' | 'hourly_block' | 'per_frame' | 'per_slot';
export type TimeRule = { label: string; days: number[]; start: string; end: string; price_paise: number };
export type RateCard = {
  id: string; activity_id: string; version: number; billing_mode: BillingMode; price_paise: number; block_minutes: number;
  slot_minutes: number; min_minutes: number; grace_minutes: number; overtime_price_paise: number | null; per_player: boolean;
  included_players: number; extra_player_paise: number; time_rules: TimeRule[]; addons: { code: string; name: string; price_paise: number }[];
  active: boolean;
};
export type Activity = { id: string; name: string; kind: 'table' | 'console' | 'track' | 'other'; icon: string; color: string; active: boolean; rate_card: RateCard | null; free_until?: string | null };
export type Fixture = { id: string; type: FixtureType; label: string; x: number; y: number; w: number; h: number; rotation: number };
export type FixtureType = 'counter' | 'entrance' | 'cafe' | 'toilet' | 'wall' | 'tv' | 'other';
export type Floor = { id: string; name: string; width: number; height: number; outline: [number, number][]; fixtures: Fixture[]; version: number };
export type LiveSession = {
  id: string; status: 'running' | 'paused'; started_at: string; players: number; planned_minutes: number | null; frames: number;
  tab_id?: string | null; billable_seconds: number; running_since: string | null; cost_paise?: number | null;
  customer?: { id?: string; name: string; phone?: string } | null;
};
export type Resource = {
  id: string; floor_id: string; activity_id: string; name: string; shape: 'rect' | 'round' | 'polygon'; x: number; y: number; w: number; h: number;
  rotation: number; points: [number, number][] | null; capacity: number; online_bookable: boolean; status: 'active' | 'out_of_service';
  session: LiveSession | null;
};
export type WaitEntry = { id: string; activity_id: string; name: string; phone: string | null; party_size: number; note: string | null; status: 'waiting' | 'notified'; created_at: string };
export type OpenTab = { id: string; label: string | null; opened_at: string; customer: string | null; live: boolean };
export type FloorState = {
  server_time: string; floors: Floor[]; activities: Activity[]; resources: Resource[]; waitlist: WaitEntry[]; open_tabs: OpenTab[];
  bookings?: import('../features/booking/types').Booking[];
};

export const MODE_LABEL: Record<BillingMode, string> = {
  per_minute: 'Per hour, charged by the minute', hourly_block: 'Hourly blocks', per_frame: 'Per frame', per_slot: 'Per slot',
};
export const FIXTURE_LABEL: Record<FixtureType, string> = {
  counter: 'Counter', entrance: 'Entrance', cafe: 'Café', toilet: 'Toilet', wall: 'Wall', tv: 'TV', other: 'Other',
};

/** Ticks every second so timers move without refetching. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Server clock minus device clock, so a wrong tablet clock doesn't change timers. */
export function clockSkew(serverTime: string | undefined, fetchedAt: number) {
  return serverTime ? Date.parse(serverTime) - fetchedAt : 0;
}

/** Seconds played so far, live: the snapshot's billable seconds plus time since the snapshot while running. */
export function playedSeconds(s: LiveSession, snapshotAt: number, now: number) {
  return s.status === 'running' ? s.billable_seconds + Math.max(0, Math.floor((now - snapshotAt) / 1000)) : s.billable_seconds;
}

export type Tone = 'free' | 'playing' | 'paused' | 'soon' | 'over' | 'off';
export function toneOf(r: Resource, played: number): Tone {
  if (r.status === 'out_of_service') return 'off';
  const s = r.session;
  if (!s) return 'free';
  if (s.planned_minutes) {
    const left = s.planned_minutes * 60 - played;
    if (left <= 0) return 'over';
    if (left <= 300) return 'soon';
  }
  return s.status === 'paused' ? 'paused' : 'playing';
}
export const TONE_LABEL: Record<Tone, string> = {
  free: 'Free', playing: 'Playing', paused: 'Paused', soon: '5 min left', over: "Time's up", off: 'Out of service',
};

export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export function minutesLabel(min: number) {
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`;
}

/** The big number on a card: time left for fixed games, time played for open timers. */
export function timerText(s: LiveSession, played: number) {
  if (s.planned_minutes) {
    const left = s.planned_minutes * 60 - played;
    return left >= 0 ? clock(left) : `+${clock(-left)}`;
  }
  return clock(played);
}

export function priceSummary(rc: RateCard | null) {
  if (!rc) return 'No price set';
  const p = formatINR(rc.price_paise);
  switch (rc.billing_mode) {
    case 'per_minute': return `${p}/hr${rc.per_player ? ' per player' : ''}${rc.min_minutes ? ` · min ${rc.min_minutes}m` : ''}`;
    case 'hourly_block': return `${p}/hr in ${rc.block_minutes}-min blocks`;
    case 'per_frame': return `${p} per frame`;
    case 'per_slot': return `${p} per ${rc.slot_minutes}-min slot${rc.per_player ? ' per car' : ''}`;
  }
}

export const KIND_LABEL: Record<Activity['kind'], string> = { table: 'Table', console: 'Console', track: 'Track', other: 'Other' };

/** Default size (floor units ≈ cm) for a new item of an activity. */
export function defaultSize(a: Activity): { w: number; h: number; capacity: number; shape: Resource['shape'] } {
  const n = a.name.toLowerCase();
  if (n.includes('snooker')) return { w: 370, h: 190, capacity: 4, shape: 'rect' };
  if (n.includes('pool')) return { w: 260, h: 140, capacity: 4, shape: 'rect' };
  if (a.kind === 'console') return { w: 160, h: 110, capacity: 4, shape: 'rect' };
  if (a.kind === 'track') return { w: 700, h: 450, capacity: 6, shape: 'round' };
  return { w: 200, h: 120, capacity: 4, shape: 'rect' };
}

export function uid() {
  return crypto.randomUUID();
}
