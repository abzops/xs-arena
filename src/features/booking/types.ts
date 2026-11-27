import type { Floor, Resource } from '../../lib/floor';

export type BookingStatus = 'confirmed' | 'arrived' | 'seated' | 'cancelled' | 'no_show' | 'late';
export type Booking = {
  id: string; activity_id: string; activity: string; color: string; name: string; phone: string; party_size: number;
  starts_at: string; ends_at: string; minutes: number; status: BookingStatus; source: 'online' | 'staff';
  estimate_paise: number; advance_paise: number; paid_paise: number; payment_status: 'pay_at_counter' | 'pending' | 'paid' | 'refunded';
  code: string; resource_id: string | null; resource: string | null; session_id: string | null; session_status: string | null;
  note: string | null; created_at: string; arrived_at: string | null; seated_at: string | null;
  /** The game the customer wants on the console (PS5 etc.), if they picked one. */
  game?: string | null;
};

export type PublicActivity = {
  id: string; name: string; kind: string; color: string; icon: string; online_tables: number; tables: number; max_players: number;
  free_now: number; price: { mode: string; price_paise: number; slot_minutes: number; per_player: boolean } | null;
  /** Games installed on this activity's consoles, with how many consoles have each. */
  games?: { name: string; consoles: number }[];
};
export type PublicCentre = {
  name: string; slug: string; address: string | null; city: string | null; phone: string | null; timezone: string;
  open_time: string; close_time: string; slot_minutes: number; note: string | null; advance_bp: number; hold_minutes: number;
  days_ahead: number; durations: number[]; lead_minutes: number;
  advance_on?: boolean; logo_path?: string | null; cover_path?: string | null; about?: string | null; maps_url?: string | null; instagram?: string | null;
};
export type BookingPageData = {
  server_time: string; centre: PublicCentre; activities: PublicActivity[]; floors: Floor[];
  resources: (Omit<Resource, 'session'> & { busy: boolean })[];
};
export type Slot = { at: string; local: string; free: boolean };

export const STATUS_LABEL: Record<BookingStatus, string> = {
  confirmed: 'Confirmed', arrived: 'Arrived', seated: 'Playing', cancelled: 'Cancelled', no_show: 'No-show', late: 'Late',
};

/** What to show for a booking; a seated booking follows its game (playing → played / cancelled). */
export function bookingLabel(b: Pick<Booking, 'status' | 'session_status'>): { label: string; tone: string } {
  if (b.status === 'seated') {
    if (b.session_status === 'ended') return { label: 'Played', tone: 'done' };
    if (b.session_status === 'void') return { label: 'Game cancelled', tone: 'cancelled' };
    return { label: 'Playing', tone: 'seated' };
  }
  return { label: STATUS_LABEL[b.status], tone: b.status };
}

export function priceLabel(p: PublicActivity['price']): string {
  if (!p) return '';
  const r = `₹${Math.round(p.price_paise / 100)}`;
  const per = p.per_player ? ' per player' : '';
  switch (p.mode) {
    case 'per_slot': return `${r} / ${p.slot_minutes} min${per}`;
    case 'per_frame': return `${r} / frame${per}`;
    default: return `${r} / hour${per}`;
  }
}

export function durationLabel(m: number) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h} hr${h > 1 ? 's' : ''}`;
}

export function ticketUrl(token: string) {
  return `${window.location.origin}/t/${token}`;
}
