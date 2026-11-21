# XS Arena — Progress

Plan: Xelorsoft project doc `claude/xs-arena-implementation-plan.md` (go-live Sat 28 Nov 2026).

## Day 1 · Sat 21 Nov — Foundation ✅

**Kept from XS Salon:** auth (sign in / sign up / reset), onboarding, shell (sidebar, phone tab bar, sheets), design system, customers, inventory → **Snacks & stock**, team, settings, WhatsApp tap-to-send sheet (English / മലയാളം), CI + Cloudflare worker, branded auth emails.
**Removed:** stylist calendar, services, appointments, salon billing/invoices, reports, public booking (billing is rebuilt around sessions/tabs on Day 5; booking in Phase 2).
**New:**
- Database (`supabase/migrations/0001–0004`): centres, plans + `plan_features` (Starter/Growth/Pro, `has_feature`, `feature_limit`, `require_feature`), centre_subscriptions (new centres = 14-day **Pro** trial), staff roles **owner / manager / front_desk**, role_permissions (floor.operate, floor.design, pricing.manage, billing.*, customers.manage, inventory.manage, expenses.manage, loyalty.manage, reports.view, staff.manage, settings.manage), customers, products/stock_moves, **expenses** (category, method, paid from drawer/bank/owner, void with reason), audit log, centre UPI ID.
- Hardening: no TRUNCATE/REFERENCES/TRIGGER for API roles; anon has no table access.
- DB tests (`supabase/tests/`, `scripts/db-test.sh`, runs in CI before build): centre isolation, phone normalisation, roles (front desk / manager limits), plan gating + staff-login limit, last-owner protection, UPI format, anon blocked.
- Screens: owner home (sales placeholders until billing, expenses, net profit, team, low stock, birthdays), **Expenses** page, Floor placeholder, Settings (plan, UPI ID), interim landing page.
- Supabase project `xs-arena` (Mumbai) migrated; demo login **admin@xelorsoft.com** → centre **XS Arena Demo** (`/s/xs-arena-demo`), owner, Pro trial.

**Open / to do by hand**
- Cloudflare: create Worker `xs-arena` from `worker/index.js`, route `arena.xelorsoft.com/*`, DNS record. (Worker reads the public `deploy` branch, so the repo must stay public unless hosting changes.)
- Supabase Auth → URL configuration: Site URL `https://arena.xelorsoft.com`, redirect `https://arena.xelorsoft.com/**`.
- Paste branded templates from `supabase/templates/`; custom SMTP (Resend) shared with XS Salon.
- ~~Worker camera policy~~ → `camera=(self)` deployed 21 Nov for QR check-in.

## Day 2 · Sat 21 Nov — Floor, prices, timers (database) ✅

- `0005_floor_and_pricing.sql`: **activities** (Snooker, Pool, PS5, RC Drift, RC Offroad seeded for every centre), **floors** (outline polygon + fixtures, versioned), **resources** = tables/consoles/tracks with geometry (x, y, w, h, rotation, shape/points), capacity, online-bookable, out of service, archived (never deleted); **rate cards** versioned (per minute / hourly block / per frame / per slot, minimum, grace, overtime, per-player, extra player, peak/happy-hour time rules, add-ons). Commands: `save_floor` (designer save with stale-version check, archives removed tables, refuses removing a table with a live game), `save_rate_card`, `save_activity`.
- `0006_sessions.sql`: **tabs** (group bill), **sessions** (one live game per table, enforced), **session_events** (immutable ledger), **waitlist**. Commands: `start_session` (walk-in in one call: phone → customer, new or existing tab, slot length for RC), `pause/resume/extend/transfer/set_session_players/end_session`, `void_session` (manager+, reason), `set_resource_status`, `add_to_waitlist`, `set_waitlist_status`, `floor_state` (everything the floor/TV/owner phone needs in one call), `session_billable_seconds`.
- **Offline-safe:** the app creates game ids; every command carries the device time; device time is used only when plausible (not future, ≤12 h old, not before the previous event); replayed commands are no-ops.
- Realtime publication on sessions, waitlist, resources.
- `0007_function_grants.sql`: no function callable signed out.
- Tests `0002_floor_sessions.test.sql`: 50-min billable with pause, replays, busy table, transfer rules, future device time ignored, extend, group bill, RC slot, roles, waitlist seat, versioned prices (old game keeps old price), floor save conflicts, isolation, ledger immutability, anon blocked. Mutation-checked (a broken timer fails the test).

## Days 3–6 · Sat 21 Nov — Everything for go-live ✅ (built in one push)

**Database** (`0008_billing.sql`, `0009`, `0010`)
- Pricing engine (`_price_session`, `price_session`): per-minute with peak/happy-hour split minute-by-minute on the local clock, minimum charge, grace, overtime (own rate or normal), hourly blocks, per-slot with overtime, per-frame, per-player / extra-player. Lines rounded to the rupee.
- Tabs: snacks/other items (`tab_add_item`, stock moves), `tab_preview`, `tab_set_customer`, `close_tab` (ends live games, snapshot lines, discount needs manager + reason, split payments, idempotent key, GST incl./excl.), `add_payment` (dues), `void_bill` (restores stock, voids payments).
- Shifts: `open_shift`, `current_shift`, `close_shift` (expected = opening + cash − drawer expenses; difference needs a note).
- TV: `tv_begin` / `tv_poll` (signed-out TV with secret token, 6-digit code), `tv_link` (owner, plan limit), `tv_revoke`. Customer mode hides names, phones, money.
- `floor_state` now has running cost + open bills; `dashboard_summary` has real sales, by game, snacks, busy now, waiting, dues, last 7 days.
- Fixes: designer `points: null`; quick layout may reuse names of replaced items.
- Tests `0003_billing.test.sql`: exact rupee amounts for every rule (45 min, minimum, started minute, grace, overtime, pause, live price, void, peak split, hourly blocks + grace, PS5 extra players, RC per car + overtime, frames), group bill, roles, idempotent close, discount rules, partial + dues, void restores stock, GST, dashboard, shift expected cash, TV pairing/privacy/plan limit.

**Screens**
- Floor designer (owner): rectangle / L / custom hall with draggable corners, palette for every game + counter/entrance/café/toilet/wall/TV, drag, resize, rotate, duplicate, out of service, online-bookable, quick layout from counts, multiple halls, version-safe save, unsaved-changes guard.
- Live floor: map or list, live timers (device-independent), colours (free / playing / paused / 5 min / time's up blinking / out of service), walk-in in one sheet (phone → known customer, players, open timer or 30/60/90/120 or RC slots, add to an open group bill), pause / resume / +time / move / players / frames / end & bill / cancel (manager), 5-min and time's-up alerts with optional beep + phone notifications, waiting list (add, WhatsApp "table ready", seat onto a free table), open bills, offline banner + queued commands.
- Bill: games priced live with in/out times, snacks grid, other items, customer, discount + reason, cash (change), UPI QR with exact amount, card, split (rest button, dues), close.
- Receipt: in-time / out-time per game, print (80 mm), WhatsApp receipt English / Malayalam with UPI pay link for dues, collect dues, void.
- Bills list (by day, dues), Shift & cash (open, live figures, close with count, history), Games & prices (all rules, special prices, add a game), TV display `/tv` (pairing code, live floor, free now, finishing soon, waiting list, keeps screen awake), Settings → TV screens + device alerts + floor/prices links, dashboard with real sales, customer visit history.
- Browser end-to-end check (laptop + phone + TV) passes with no console errors.

## Phase 2 · Sat 21 Nov — Booking, check-in, smart extensions, loyalty ✅

- `0011_bookings.sql`: **bookings** (book a game type + time, table chosen at check-in), one **availability engine** (`_activity_load` / `_can_fit`: live games + held bookings + 1 must fit at every moment; online bookings also must fit in online tables − walk-in reserve), public `booking_page` / `booking_slots` / `create_booking` / `booking_ticket` / `cancel_booking_by_token` (only these + TV are callable signed out — enforced by a test), staff `bookings_for_day` / `staff_create_booking` / `check_in_booking` (code, token or scanned ticket URL) / `seat_booking` / `set_booking_status`, **smart extensions** (`extension_check`; `extend_session` refuses to eat into a booking and says how much fits + which games are free), `floor_state` adds bookings + **free until** per game, booking settings (on/off, lengths, hold time, days ahead, notice, advance %, per-game online + walk-in reserve).
- `0012_loyalty.sql` + `0013`: **loyalty points** — owner-editable rules (points per ₹100, point value, use-from, max % of bill, welcome + birthday bonus, expiry, per-game multipliers, happy hours, snacks on/off); append-only ledger; earn on bill close (on what was actually paid); front desk can apply points at checkout (`close_tab(p_points)`); void gives back / takes back; expiry oldest-first; manual adjust with reason; suggested points are worth whole rupees.
- Screens: public **/b/:slug** (live floor, game → day → length/players → time → name + phone → ticket), **/t/:token** ticket (QR, code, hold time, share, directions, cancel ≥1 h before), staff **Bookings** (day list, check in by code or camera QR, seat at a suggested free table, phone bookings with WhatsApp ticket, no-show / cancel), floor **Check in** + due-bookings strip + "Free until 7:30", extension warning with "Add 35m", **Settings → Online booking** (link, QR poster) and **Loyalty points**, bill sheet points box, receipt + WhatsApp points lines, customer points card + adjust.
- Tests `0004_bookings.test.sql`, `0005_loyalty.test.sql`; E2E: customer booking, staff phone bookings + 4th refused, check-in → seat from floor, smart extension, loyalty earn/use/receipt; /verify 8/8; 42 page loads clean.
- Payments for the advance wait for Razorpay keys: until then customers pay at the centre.

## Next
- Pilot centre setup (their floor, prices, staff, UPI ID).
- Phase 2 (from 30 Nov): online booking + 20% advance + QR check-in, loyalty points, XS AI, RC fleet.
