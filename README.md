# XS Arena

Gaming-centre software by Xelorsoft — for snooker/pool halls, PS5 lounges and RC tracks: live floor with timers, walk-ins and waiting list, billing with snacks and UPI QR, expenses and net profit, staff roles, TV display.
Built on the same design system and stack as XS Gym, XS Connect and XS Salon (React + TypeScript + Vite, TanStack Query, Supabase).

- **App:** https://arena.xelorsoft.com
- **Database:** Supabase project `xs-arena` (org *XS Ecosystem 2*, Mumbai, ref `ppdfdymgtvrimmhcrmbl`). Schema and business logic in `supabase/migrations/`, tests in `supabase/tests/`.
- **Hosting:** Cloudflare Worker `xs-arena` (`worker/index.js`) serves the `deploy` branch, which `.github/workflows/deploy.yml` builds on every push to `main` after the database tests pass.
- **Plan:** see `PROGRESS.md`.

## Develop

```sh
npm ci
cp .env.example .env.local   # or use .env.production values
npm run dev
```

`npm run typecheck`, `npm run lint`, `npm run build` and `scripts/db-test.sh` must pass before merging.

```sh
# database tests against any local Postgres you can create databases on
PGHOST=localhost PGUSER=postgres scripts/db-test.sh
```

## Security model

All money and session writes go through permission-checked database functions (`save_customer`, `record_expense`, `save_staff`, …).
Every table has row level security; centres are fully isolated from each other.
Roles (owner, manager, front desk) map to permissions in `role_permissions`.
Plans (Starter / Growth / Pro) map to features in `plan_features`; `has_feature()` / `require_feature()` gate them. New centres start on a 14-day Pro trial.

## Rules

- Money in integer paise. Ledger rows are never edited — void with a reason instead.
- Commits are authored as Abhinand <abhinand@xelorsoft.com> only.
- Pushing to `main` deploys live. Production database changes need Abhinand's OK.
