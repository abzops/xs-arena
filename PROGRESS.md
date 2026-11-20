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
- Worker sends `permissions-policy: camera=()` — must allow camera before QR check-in (Phase 2).

## Day 2 · Sat 21 Nov — Floor, prices, timers (database) ✅

- `0005_floor_and_pricing.sql`: **activities** (Snooker, Pool, PS5, RC Drift, RC Offroad seeded for every centre), **floors** (outline polygon + fixtures, versioned), **resources** = tables/consoles/tracks with geometry (x, y, w, h, rotation, shape/points), capacity, online-bookable, out of service, archived (never deleted); **rate cards** versioned (per minute / hourly block / per frame / per slot, minimum, grace, overtime, per-player, extra player, peak/happy-hour time rules, add-ons). Commands: `save_floor` (designer save with stale-version check, archives removed tables, refuses removing a table with a live game), `save_rate_card`, `save_activity`.
- `0006_sessions.sql`: **tabs** (group bill), **sessions** (one live game per table, enforced), **session_events** (immutable ledger), **waitlist**. Commands: `start_session` (walk-in in one call: phone → customer, new or existing tab, slot length for RC), `pause/resume/extend/transfer/set_session_players/end_session`, `void_session` (manager+, reason), `set_resource_status`, `add_to_waitlist`, `set_waitlist_status`, `floor_state` (everything the floor/TV/owner phone needs in one call), `session_billable_seconds`.
- **Offline-safe:** the app creates game ids; every command carries the device time; device time is used only when plausible (not future, ≤12 h old, not before the previous event); replayed commands are no-ops.
- Realtime publication on sessions, waitlist, resources.
- `0007_function_grants.sql`: no function callable signed out.
- Tests `0002_floor_sessions.test.sql`: 50-min billable with pause, replays, busy table, transfer rules, future device time ignored, extend, group bill, RC slot, roles, waitlist seat, versioned prices (old game keeps old price), floor save conflicts, isolation, ledger immutability, anon blocked. Mutation-checked (a broken timer fails the test).

## Next — Day 3 · Sun 22 Nov
Floor designer (owner only): draw hall (rectangle / L / polygon), drag-drop pool, snooker, PS5, RC tracks, custom shapes and fixtures; rotate/resize; starter layout from counts; multiple floors; save via `save_floor`. Prices screen on top of `save_rate_card`.
