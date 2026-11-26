-- XS Arena — a game under the minimum is one line, rounded once (₹75, not ₹53 + ₹23); the bill total matches.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- Written before the 26 Nov 2026 pilot rules (name + mobile required, snacks as a paid add-on). The centres this file
-- creates keep the old behaviour: walk-ins without a mobile, snacks included. Updated with the owner's OK; removed at the end.
create or replace function public._test_old_rules() returns trigger language plpgsql as $t$
begin
  update public.centres set require_customer = false where id = new.id;
  insert into public.centre_addons(centre_id, addon) values (new.id, 'snacks') on conflict do nothing;
  return new;
end $t$;
create trigger zz_test_old_rules after insert on public.centres for each row execute function public._test_old_rules();
revoke execute on function public._test_old_rules() from public, anon, authenticated;
insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b3', 'owner.min@test.local', '{"display_name":"Owner M"}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create or replace function pg_temp.play(c uuid, r uuid, p_minutes numeric) returns uuid language plpgsql as $$
declare s uuid := gen_random_uuid();
begin
  perform start_session(c, s, r, 1, null, null, null, null, now() - make_interval(secs => p_minutes * 60));
  perform end_session(c, s, now());
  return s;
end $$;
-- volatile on purpose: reads with a fresh snapshot so it sees a game created in the same statement
create or replace function pg_temp.price(s uuid) returns jsonb language plpgsql volatile as $$ begin return price_session(s); end $$;
create or replace function pg_temp.check(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin if got is distinct from want then raise exception '%: expected % but got %', label, want, got; end if; end $$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare c uuid; pool uuid; fl uuid; t1 uuid := gen_random_uuid(); s uuid; p jsonb; v jsonb; b jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b3');
  c := create_centre('Minimum Arena');
  select id into pool from activities where centre_id = c and name = 'Pool';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(jsonb_build_object('id', t1, 'activity_id', pool, 'name', 'Pool 1'))));
  perform save_rate_card(c, pool, '{"billing_mode":"per_minute","price_paise":15000,"min_minutes":30,"grace_minutes":5}');

  -- 21 minutes played, 30-minute minimum at ₹150/hr → ₹75 on ONE line
  s := pg_temp.play(c, t1, 21);
  p := pg_temp.price(s);
  perform pg_temp.check('21 min → ₹75', (p->>'amount_paise')::bigint, 7500::bigint);
  perform pg_temp.check('one line', jsonb_array_length(p->'lines'), 1);
  perform pg_temp.check('line label', p->'lines'->0->>'label', 'Minimum 30m @ ₹150/hr');

  -- 29 minutes (used to be ₹73 + ₹3 = ₹76)
  perform pg_temp.check('29 min → ₹75', (pg_temp.price(pg_temp.play(c, t1, 29))->>'amount_paise')::bigint, 7500::bigint);
  -- over the minimum is charged per minute as before: 45 min = ₹112.50 → ₹113 (one line, rounded once)
  perform pg_temp.check('45 min → ₹113', (pg_temp.price(pg_temp.play(c, t1, 45))->>'amount_paise')::bigint, 11300::bigint);

  -- the closed bill says the same ₹75
  s := gen_random_uuid();
  v := start_session(c, s, t1, 1, null, null, null, null, now() - interval '21 minutes');
  perform end_session(c, s, now());
  b := close_tab(c, (v->>'tab_id')::uuid, 0, null, jsonb_build_array(jsonb_build_object('method','cash','amount_paise',7500)), gen_random_uuid(), null, null);
  perform pg_temp.check('bill total', (select total_paise from bills where tab_id = (v->>'tab_id')::uuid), 7500::bigint);
  perform pg_temp.reset();
end $$;

select 'minimum charge ok';

drop trigger zz_test_old_rules on public.centres;
drop function public._test_old_rules();
