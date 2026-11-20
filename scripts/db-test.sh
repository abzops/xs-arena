#!/usr/bin/env bash
# Runs all migrations and DB tests against a throwaway local Postgres.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres scripts/db-test.sh
# CI provides a postgres service; locally point PG* at any empty server you can drop databases on.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="xs_arena_test_$$"
PSQL=(psql -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null
trap '"${PSQL[@]}" -d postgres -c "drop database if exists $DB" >/dev/null' EXIT

# Minimal stand-in for Supabase's auth schema and roles.
"${PSQL[@]}" -d "$DB" <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $f$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
SQL

for f in supabase/migrations/*.sql; do echo "migrate  $f"; "${PSQL[@]}" -d "$DB" -f "$f"; done
for f in supabase/tests/*.test.sql; do echo "test     $f"; "${PSQL[@]}" -d "$DB" -f "$f"; done
echo "DB tests passed"
