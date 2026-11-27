-- XS Arena — setup steps: ready-made arena items, prices, switching off what the centre lacks.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000811', 'owner.sa@test.local', '{"display_name":"Owner SA"}'),
  ('00000000-0000-0000-0000-000000000812', 'desk.sa@test.local', '{"display_name":"Desk SA"}'),
  ('00000000-0000-0000-0000-000000000813', 'other.sa@test.local', '{"display_name":"Other SA"}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'set role anon'; end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create or replace function pg_temp.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin if got is distinct from want then raise exception '%: expected % but got %', label, want, got; end if; end $$;
create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm not ilike '%' || p_like || '%' then raise exception 'Expected error like "%" but got "%"', p_like, sqlerrm; end if;
    return;
  end;
  raise exception 'Expected an error like "%" for: %', p_like, p_sql;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
create temp table t(k text primary key, v text);
grant all on t to authenticated, anon;

do $$
declare c uuid; v jsonb; snooker uuid; vr uuid; n int; ps5_card rate_cards;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000811');
  c := create_centre('Setup Arena');
  insert into t values ('c', c::text);
  perform pg_temp.eq('new centre: setup not done', (select onboarded_at from centres where id = c), null::timestamptz);
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  n := (select count(*) from rate_cards where activity_id = snooker);

  v := setup_arena(c, jsonb_build_array(
    jsonb_build_object('name', 'Snooker', 'kind', 'table', 'icon', 'snooker', 'color', '#1BAF7A',
      'card', jsonb_build_object('billing_mode', 'per_minute', 'price_paise', 20000, 'min_minutes', 30, 'grace_minutes', 5, 'per_player', false, 'included_players', 4)),
    jsonb_build_object('name', 'PS5', 'kind', 'console', 'icon', 'gamepad', 'color', '#9B5DE5',
      'card', jsonb_build_object('billing_mode', 'per_minute', 'price_paise', 10000, 'min_minutes', 30, 'grace_minutes', 5, 'per_player', false,
        'included_players', 2, 'extra_player_paise', 3000)),
    jsonb_build_object('name', 'VR', 'kind', 'console', 'icon', 'glasses', 'color', '#E0457B',
      'card', jsonb_build_object('billing_mode', 'per_slot', 'price_paise', 15000, 'slot_minutes', 15, 'per_player', true, 'included_players', 1))));
  perform pg_temp.eq('returns ids by name', (v->>'Snooker')::uuid, snooker);
  vr := (v->>'VR')::uuid;
  perform pg_temp.eq('VR created', (select kind from activities where id = vr), 'console');
  perform pg_temp.eq('VR price', (select price_paise from rate_cards where activity_id = vr and active), 15000::bigint);
  perform pg_temp.eq('VR per slot', (select billing_mode || slot_minutes from rate_cards where activity_id = vr and active), 'per_slot15');
  perform pg_temp.eq('same snooker price: no new price version', (select count(*) from rate_cards where activity_id = snooker)::int, n);
  select * into ps5_card from rate_cards where activity_id = (v->>'PS5')::uuid and active;
  perform pg_temp.eq('PS5 new price', ps5_card.price_paise, 10000::bigint);
  perform pg_temp.eq('PS5 keeps its extra controller add-on', jsonb_array_length(ps5_card.addons), 1);
  perform pg_temp.eq('Pool switched off (not picked)', (select active from activities where centre_id = c and name = 'Pool'), false);
  perform pg_temp.eq('RC Drift switched off', (select active from activities where centre_id = c and name = 'RC Drift'), false);
  perform pg_temp.eq('picked ones on', (select count(*) from activities where centre_id = c and active)::int, 3);

  -- running it again (owner goes back a step) changes nothing extra and can switch Pool back on
  v := setup_arena(c, jsonb_build_array(
    jsonb_build_object('name', 'Pool', 'kind', 'table', 'card', jsonb_build_object('billing_mode', 'per_minute', 'price_paise', 15000, 'min_minutes', 30, 'grace_minutes', 5, 'included_players', 4)),
    jsonb_build_object('name', 'VR', 'kind', 'console', 'card', jsonb_build_object('billing_mode', 'per_slot', 'price_paise', 15000, 'slot_minutes', 15, 'per_player', true, 'included_players', 1))));
  perform pg_temp.eq('Pool back on', (select active from activities where centre_id = c and name = 'Pool'), true);
  perform pg_temp.eq('VR not duplicated', (select count(*) from activities where centre_id = c and name = 'VR')::int, 1);
  perform pg_temp.eq('VR price unchanged: one version', (select count(*) from rate_cards where activity_id = vr)::int, 1);

  -- an activity with something on the floor is never switched off
  perform save_floor(c, jsonb_build_object('id', (select id from floors where centre_id = c), 'resources', jsonb_build_array(
    jsonb_build_object('activity_id', vr, 'name', 'VR #1', 'w', 220, 'h', 220))));
  perform setup_arena(c, jsonb_build_array(jsonb_build_object('name', 'Pool', 'kind', 'table', 'card', jsonb_build_object('price_paise', 15000))));
  perform pg_temp.eq('VR with a station stays on', (select active from activities where id = vr), true);

  -- bad input
  perform pg_temp.expect_error(format('select setup_arena(%L, %L)', c, '[]'), 'Pick at least one');
  perform pg_temp.expect_error(format('select setup_arena(%L, %L)', c, '[{"name":"X","kind":"spaceship","card":{"price_paise":100}}]'), 'Invalid type');
  perform pg_temp.expect_error(format('select setup_arena(%L, %L)', c, '[{"name":"X","kind":"table","card":{"price_paise":-5}}]'), 'Enter a price');
  perform pg_temp.expect_error(format('select setup_arena(%L, %L)', c, '[{"name":"X","kind":"table","card":{"price_paise":5}},{"name":"x","kind":"table","card":{"price_paise":5}}]'), 'listed twice');
  perform complete_onboarding(c);
  perform pg_temp.eq('setup done', (select onboarded_at is not null from centres where id = c), true);
end $$;

-- front desk and outsiders can't run it
do $$
declare c uuid := (select v::uuid from t where k = 'c');
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000811');
  perform save_staff(c, null, 'Desk SA', 'front_desk', null, null, 'desk.sa@test.local');
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000812');
  perform pg_temp.expect_error(format('select setup_arena(%L, %L)', c, '[{"name":"Pool","kind":"table","card":{"price_paise":1}}]'), '');
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000813');
  perform pg_temp.expect_error(format('select setup_arena(%L, %L)', c, '[{"name":"Pool","kind":"table","card":{"price_paise":1}}]'), '');
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(format('select setup_arena(%L, %L)', c, '[]'), 'permission denied');
  perform pg_temp.reset();
  perform pg_temp.eq('Pool price untouched', (select price_paise from rate_cards r join activities a on a.id = r.activity_id where a.centre_id = c and a.name = 'Pool' and r.active), 15000::bigint);
end $$;

select 'setup arena ok';
