export type Role = 'owner' | 'manager' | 'front_desk';
export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', manager: 'Manager', front_desk: 'Front desk' };

export type PlanCode = 'starter' | 'growth' | 'pro';
export const PLAN_LABEL: Record<PlanCode, string> = { starter: 'Starter', growth: 'Growth', pro: 'Pro' };

export type Centre = {
  id: string; name: string; slug: string; phone: string | null; email: string | null; address: string | null; city: string | null;
  timezone: string; currency: string; upi_id: string | null; gstin: string | null; gst_enabled: boolean; gst_rate_bp: number; prices_include_tax: boolean;
  open_time: string; close_time: string; slot_minutes: number; booking_enabled: boolean; booking_note: string | null;
  booking_advance_bp: number; booking_hold_minutes: number; booking_days_ahead: number; booking_durations: number[]; booking_lead_minutes: number;
  invoice_prefix: string; invoice_seq: number; customer_seq: number; status: string; onboarded_at: string | null; created_at: string;
  /** New customers must give name + phone before a game or waiting-list entry (pilot feedback, on by default). */
  require_customer: boolean;
  /** Centre profile (public: booking page, ticket, receipt, WhatsApp images). Paths are in the "centre-media" bucket. */
  logo_path: string | null; cover_path: string | null; about: string | null; maps_url: string | null; instagram: string | null;
  /** 'amount' = XS Arena draws a QR with the exact amount from upi_id; 'own' = show the centre's uploaded QR. */
  upi_mode: 'amount' | 'own'; upi_qr_path: string | null; upi_payee: string | null;
};
export type Subscription = {
  centre_id: string; plan: PlanCode; status: 'trialing' | 'active' | 'past_due' | 'cancelled'; trial_ends_at: string; paid_until: string | null;
};
export type Staff = {
  id: string; centre_id: string; user_id: string | null; role: Role; display_name: string; title: string | null; phone: string | null; email: string | null; username: string | null; guide_seen_at?: string | null; avatar_path?: string | null;
  color: string; sort: number; status: 'active' | 'inactive';
};
export type Customer = {
  id: string; centre_id: string; customer_no: number; full_name: string; phone: string; email: string | null; gender: 'female' | 'male' | 'other' | null;
  date_of_birth: string | null; anniversary: string | null; notes: string | null; tags: string[]; source: string; marketing_opt_in: boolean;
  visit_count: number; total_spent_paise: number; last_visit_at: string | null; status: string; created_at: string;
};
export type Product = {
  id: string; centre_id: string; name: string; brand: string | null; sku: string | null; kind: 'retail' | 'consumable'; price_paise: number; cost_paise: number;
  stock_qty: number; reorder_level: number; unit: string; status: 'active' | 'archived';
};
export type Expense = {
  id: string; centre_id: string; category: string; amount_paise: number; expense_date: string; method: Method;
  paid_from: 'drawer' | 'bank' | 'owner'; description: string | null; status: 'ok' | 'void'; created_at: string;
  photo_path?: string | null; recurring_id?: string | null;
};
export type RecurringExpense = {
  id: string; centre_id: string; category: string; amount_paise: number; day_of_month: number; method: Method;
  paid_from: Expense['paid_from']; description: string | null; starts_on: string; active: boolean;
};
export const EXPENSE_CATEGORIES = [
  'Rent', 'Electricity', 'Salary', 'Snacks stock', 'RC repairs', 'Batteries', 'Equipment', 'Maintenance', 'Internet', 'Marketing', 'Other',
];
export const PAID_FROM_LABEL: Record<Expense['paid_from'], string> = { drawer: 'Cash drawer', bank: 'Bank / UPI', owner: 'Owner paid' };
export type Method = 'cash' | 'upi' | 'card' | 'bank' | 'other';
export const METHOD_LABEL: Record<Method, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', other: 'Other' };
export const METHODS = Object.keys(METHOD_LABEL) as Method[];
export const SOURCE_LABEL: Record<string, string> = { walk_in: 'Walk-in', phone: 'Phone', online: 'Online', whatsapp: 'WhatsApp', instagram: 'Instagram', referral: 'Referral', other: 'Other' };
