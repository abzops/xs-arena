// Everything a gaming arena may have, ready-made: name, type, drawing size, players and a typical Kerala price.
// The setup steps ("What's in your arena?") and the floor designer use this list; owners change any price later.
import type { Activity, BillingMode } from './floor';

export type CatalogueItem = {
  key: string; name: string; kind: Activity['kind']; icon: string; color: string; group: CatalogueGroup;
  /** What one of them is called: "table", "console", "track"… */ unit: string; units: string;
  size: { w: number; h: number; shape: 'rect' | 'round' }; capacity: number;
  card: { billing_mode: BillingMode; price_paise: number; slot_minutes?: number; min_minutes?: number; grace_minutes?: number;
    per_player?: boolean; included_players?: number; extra_player_paise?: number };
  /** Name for item n, e.g. "Snooker 1", "PS5 #2", "RC Drift track". */
  itemName: (n: number, total: number) => string;
  hint?: string;
};
export type CatalogueGroup = 'cue' | 'gaming' | 'rc' | 'table' | 'other';
export const GROUP_LABEL: Record<CatalogueGroup, string> = {
  cue: 'Snooker & pool', gaming: 'Consoles, PC & VR', rc: 'RC & racing', table: 'Table games', other: 'Rooms & more',
};

const hourly = (price: number, extra: Partial<CatalogueItem['card']> = {}): CatalogueItem['card'] =>
  ({ billing_mode: 'per_minute', price_paise: price * 100, min_minutes: 30, grace_minutes: 5, per_player: false, included_players: 4, ...extra });
const slot = (price: number, minutes: number, extra: Partial<CatalogueItem['card']> = {}): CatalogueItem['card'] =>
  ({ billing_mode: 'per_slot', price_paise: price * 100, slot_minutes: minutes, per_player: true, included_players: 1, ...extra });
const numbered = (base: string) => (n: number) => `${base} ${n}`;
const hashed = (base: string) => (n: number) => `${base} #${n}`;
const track = (base: string) => (n: number, total: number) => (total > 1 ? `${base} track ${n}` : `${base} track`);

export const CATALOGUE: CatalogueItem[] = [
  { key: 'snooker', name: 'Snooker', kind: 'table', icon: 'snooker', color: '#1BAF7A', group: 'cue', unit: 'table', units: 'tables',
    size: { w: 370, h: 190, shape: 'rect' }, capacity: 4, card: hourly(200), itemName: numbered('Snooker') },
  { key: 'pool', name: 'Pool', kind: 'table', icon: 'pool', color: '#2A78D6', group: 'cue', unit: 'table', units: 'tables',
    size: { w: 260, h: 140, shape: 'rect' }, capacity: 4, card: hourly(150), itemName: numbered('Pool'), hint: '8-ball / 9-ball' },
  { key: 'ps5', name: 'PS5', kind: 'console', icon: 'gamepad', color: '#9B5DE5', group: 'gaming', unit: 'console', units: 'consoles',
    size: { w: 160, h: 110, shape: 'rect' }, capacity: 4, card: hourly(120, { included_players: 2, extra_player_paise: 3000 }), itemName: hashed('PS5'),
    hint: '2 players included, ₹30/h each extra' },
  { key: 'ps4', name: 'PS4', kind: 'console', icon: 'gamepad', color: '#6B5BD5', group: 'gaming', unit: 'console', units: 'consoles',
    size: { w: 160, h: 110, shape: 'rect' }, capacity: 4, card: hourly(80, { included_players: 2, extra_player_paise: 2000 }), itemName: hashed('PS4') },
  { key: 'xbox', name: 'Xbox', kind: 'console', icon: 'gamepad', color: '#2E9E44', group: 'gaming', unit: 'console', units: 'consoles',
    size: { w: 160, h: 110, shape: 'rect' }, capacity: 4, card: hourly(120, { included_players: 2, extra_player_paise: 3000 }), itemName: hashed('Xbox') },
  { key: 'pc', name: 'Gaming PC', kind: 'console', icon: 'monitor', color: '#00A3B4', group: 'gaming', unit: 'PC', units: 'PCs',
    size: { w: 140, h: 90, shape: 'rect' }, capacity: 1, card: hourly(80, { included_players: 1 }), itemName: hashed('PC') },
  { key: 'vr', name: 'VR', kind: 'console', icon: 'glasses', color: '#E0457B', group: 'gaming', unit: 'station', units: 'stations',
    size: { w: 220, h: 220, shape: 'rect' }, capacity: 1, card: slot(150, 15), itemName: hashed('VR') },
  { key: 'rc-drift', name: 'RC Drift', kind: 'track', icon: 'car', color: '#EB6834', group: 'rc', unit: 'track', units: 'tracks',
    size: { w: 700, h: 450, shape: 'round' }, capacity: 6, card: slot(150, 15), itemName: track('RC Drift') },
  { key: 'rc-offroad', name: 'RC Offroad', kind: 'track', icon: 'mountain', color: '#EDA100', group: 'rc', unit: 'track', units: 'tracks',
    size: { w: 700, h: 450, shape: 'round' }, capacity: 6, card: slot(150, 15), itemName: track('RC Offroad') },
  { key: 'sim', name: 'Racing simulator', kind: 'console', icon: 'gauge', color: '#C2410C', group: 'rc', unit: 'seat', units: 'seats',
    size: { w: 200, h: 120, shape: 'rect' }, capacity: 1, card: slot(150, 15), itemName: hashed('Racing sim') },
  { key: 'tt', name: 'Table tennis', kind: 'table', icon: 'circle', color: '#0E7490', group: 'table', unit: 'table', units: 'tables',
    size: { w: 274, h: 152, shape: 'rect' }, capacity: 4, card: hourly(100), itemName: numbered('Table tennis') },
  { key: 'foosball', name: 'Foosball', kind: 'table', icon: 'circle', color: '#4D7C0F', group: 'table', unit: 'table', units: 'tables',
    size: { w: 140, h: 75, shape: 'rect' }, capacity: 4, card: slot(50, 15, { per_player: false, included_players: 4 }), itemName: numbered('Foosball') },
  { key: 'air-hockey', name: 'Air hockey', kind: 'table', icon: 'circle', color: '#1D4ED8', group: 'table', unit: 'table', units: 'tables',
    size: { w: 230, h: 120, shape: 'rect' }, capacity: 2, card: slot(50, 10, { per_player: false, included_players: 2 }), itemName: numbered('Air hockey') },
  { key: 'carrom', name: 'Carrom', kind: 'table', icon: 'circle', color: '#B45309', group: 'table', unit: 'board', units: 'boards',
    size: { w: 120, h: 120, shape: 'rect' }, capacity: 4, card: hourly(60), itemName: numbered('Carrom') },
  { key: 'darts', name: 'Darts', kind: 'other', icon: 'circle', color: '#BE123C', group: 'table', unit: 'board', units: 'boards',
    size: { w: 120, h: 240, shape: 'rect' }, capacity: 4, card: slot(50, 15, { per_player: false, included_players: 4 }), itemName: numbered('Darts') },
  { key: 'party', name: 'Party room', kind: 'other', icon: 'circle', color: '#7C3AED', group: 'other', unit: 'room', units: 'rooms',
    size: { w: 500, h: 400, shape: 'rect' }, capacity: 20, card: hourly(800, { included_players: 20 }), itemName: numbered('Party room') },
  { key: 'turf', name: 'Turf', kind: 'other', icon: 'circle', color: '#15803D', group: 'other', unit: 'court', units: 'courts',
    size: { w: 900, h: 500, shape: 'rect' }, capacity: 14, card: hourly(1000, { included_players: 14 }), itemName: numbered('Turf'), hint: 'Box cricket / 5-a-side' },
];

export const priceLabel = (c: CatalogueItem['card'], kind?: Activity['kind']) =>
  c.billing_mode === 'per_slot'
    ? `per ${c.slot_minutes} min${c.per_player ? (kind === 'track' ? ' per car' : ' per player') : ''}`
    : 'per hour';

/** Rows of items on one hall: big tracks/rooms down the right, the rest in rows from the top-left. Sizes in cm. */
export function layoutItems(picks: { item: CatalogueItem; count: number; activityId: string }[], floor: { width: number; height: number }) {
  const gap = 80;
  const out: { activity_id: string; name: string; shape: 'rect' | 'round'; x: number; y: number; w: number; h: number; capacity: number }[] = [];
  const big = picks.filter((p) => p.item.size.w >= 500);
  const small = picks.filter((p) => p.item.size.w < 500);
  let ty = gap; let width = floor.width; let height = floor.height;
  const bigW = big.length ? Math.max(...big.map((p) => p.item.size.w)) : 0;
  for (const p of big) for (let i = 0; i < p.count; i++) {
    out.push({ activity_id: p.activityId, name: p.item.itemName(i + 1, p.count), shape: p.item.size.shape, x: 0, y: ty, w: p.item.size.w, h: p.item.size.h, capacity: p.item.capacity });
    ty += p.item.size.h + gap;
  }
  // the left area holds the small items; widen the hall if it can't
  const leftW = Math.max(900, width - (bigW ? bigW + gap * 2 : gap));
  let x = gap, y = gap, rowH = 0, maxX = 0;
  for (const p of small) {
    for (let i = 0; i < p.count; i++) {
      if (x + p.item.size.w > leftW && x > gap) { x = gap; y += rowH + gap; rowH = 0; }
      out.push({ activity_id: p.activityId, name: p.item.itemName(i + 1, p.count), shape: p.item.size.shape, x, y, w: p.item.size.w, h: p.item.size.h, capacity: p.item.capacity });
      x += p.item.size.w + gap; maxX = Math.max(maxX, x); rowH = Math.max(rowH, p.item.size.h);
    }
    if (p.count) { x = gap; y += rowH + gap; rowH = 0; }
  }
  const bigX = Math.max(maxX, gap);   // big items start right after the widest row
  for (const r of out) if (r.w >= 500) r.x = bigX;
  width = Math.max(width, bigX + (bigW ? bigW + gap : 0), maxX + gap);
  height = Math.max(height, y + gap, ty);
  return { resources: out, width: Math.ceil(width / 100) * 100, height: Math.ceil(height / 100) * 100 };
}
