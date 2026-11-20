-- XS Arena — Day 2 DB tests: activities, floor save, rate cards, sessions, timers, waitlist.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'owner.f@test.local', '{"display_name":"Owner F"}'),
  ('00000000-0000-0000-0000-0000000000f2', 'desk.f@test.local', '{}'),
  ('00000000-0000-0000-0000-0000000000f3', 'owner.g@test.local', '{}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm not ilike '%' || p_like || '%' then raise exception 'Expected error like "%" but got "%"', p_like, sqlerrm; end if;
    return;
  end;
  raise exception 'Expected an error like "%" for: %', p_like, p_sql;
end $$;
create or replace function pg_temp.near(a int, b int, tol int default 3) returns boolean language sql as $$ select abs(a - b) <= tol $$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare
  c uuid; g uuid; snooker uuid; ps5 uuid; drift uuid; fl uuid; res jsonb; t1 uuid; t2 uuid; p1 uuid; tr uuid;
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); s3 uuid := gen_random_uuid(); s4 uuid := gen_random_uuid();
  t0 timestamptz := now(); secs int; v jsonb; w uuid; n int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  c := create_centre('Floor Test Arena');
  perform pg_temp.reset();
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f3');
  g := create_centre('Other Arena');
  perform pg_temp.reset();

  -- New centre gets five activities with prices and a main hall
  if (select count(*) from activities where centre_id = c) <> 5 then raise exception 'Starter activities missing'; end if;
  if (select count(*) from rate_cards where centre_id = c and active) <> 5 then raise exception 'Starter prices missing'; end if;
  if (select count(*) from floors where centre_id = c) <> 1 then raise exception 'Main hall missing'; end if;
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into ps5 from activities where centre_id = c and name = 'PS5';
  select id into drift from activities where centre_id = c and name = 'RC Drift';
  select id into fl from floors where centre_id = c;

  -- Owner designs the floor
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  t1 := gen_random_uuid(); t2 := gen_random_uuid(); p1 := gen_random_uuid(); tr := gen_random_uuid();
  res := save_floor(c, jsonb_build_object('id', fl, 'version', 1, 'resources', jsonb_build_array(
    jsonb_build_object('id', t1, 'activity_id', snooker, 'name', 'Table 1', 'x', 100, 'y', 100, 'w', 360, 'h', 180),
    jsonb_build_object('id', t2, 'activity_id', snooker, 'name', 'Table 2', 'x', 600, 'y', 100, 'w', 360, 'h', 180),
    jsonb_build_object('id', p1, 'activity_id', ps5, 'name', 'PS5 #1', 'x', 100, 'y', 600, 'w', 120, 'h', 80, 'capacity', 4),
    jsonb_build_object('id', tr, 'activity_id', drift, 'name', 'Drift Track', 'x', 1200, 'y', 300, 'w', 600, 'h', 600, 'capacity', 6))));
  if (res->>'version')::int <> 2 then raise exception 'Floor version should be 2, got %', res->>'version'; end if;
  -- stale save is refused
  perform pg_temp.expect_error(format('select save_floor(%L, %L::jsonb)', c, jsonb_build_object('id', fl, 'version', 1)), 'changed by someone else');
  -- duplicate names are refused
  perform pg_temp.expect_error(format('select save_floor(%L, %L::jsonb)', c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('activity_id', snooker, 'name', 'Table 1'), jsonb_build_object('activity_id', snooker, 'name', 'table 1')))), 'duplicate');
  -- staff team member
  perform save_staff(c, null, 'Desk F', 'front_desk', null, null, 'desk.f@test.local');
  perform pg_temp.reset();

  -- Front desk can't design the floor or change prices
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f2');
  perform claim_invites();
  perform pg_temp.expect_error(format('select save_floor(%L, %L::jsonb)', c, jsonb_build_object('id', fl)), 'permission');
  perform pg_temp.expect_error(format('select save_rate_card(%L, %L, %L::jsonb)', c, snooker, '{"price_paise":1}'), 'permission');

  -- ── Walk-in on Table 1: started 60 min ago, paused 10 min, ended now → 50 min billable
  v := start_session(c, s1, t1, 2, null, '9847011111', 'Rahul', null, t0 - interval '60 minutes');
  if v->>'status' <> 'running' then raise exception 'Session should be running'; end if;
  if (select full_name from customers where id = (v->>'customer_id')::uuid) <> 'Rahul' then raise exception 'Walk-in customer not created'; end if;
  -- replaying the same start (offline queue) returns the same game
  v := start_session(c, s1, t1, 2, null, '9847011111', 'Rahul', null, t0 - interval '60 minutes');
  if not (v->>'replayed')::boolean then raise exception 'Start replay not detected'; end if;
  -- the table is now busy
  perform pg_temp.expect_error(format('select start_session(%L, %L, %L)', c, gen_random_uuid(), t1), 'already in use');
  perform pause_session(c, s1, t0 - interval '40 minutes');
  perform pause_session(c, s1, t0 - interval '40 minutes');           -- replay: no-op
  perform resume_session(c, s1, t0 - interval '30 minutes');
  secs := session_billable_seconds(s1);
  if not pg_temp.near(secs, 50 * 60) then raise exception 'Billable should be ~50 min, got % s', secs; end if;

  -- Transfer to Table 2 keeps the clock; can't transfer to a PS5
  perform transfer_session(c, s1, t2, t0 - interval '20 minutes');
  if (select resource_id from sessions where id = s1) <> t2 then raise exception 'Transfer failed'; end if;
  perform pg_temp.expect_error(format('select transfer_session(%L, %L, %L)', c, s1, p1), 'same type');
  v := end_session(c, s1, t0);
  if not pg_temp.near((v->>'billable_seconds')::int, 50 * 60) then raise exception 'Ended billable should be ~50 min, got %', v->>'billable_seconds'; end if;
  v := end_session(c, s1, t0);                                         -- replay
  if not (v->>'replayed')::boolean then raise exception 'End replay not detected'; end if;
  perform pg_temp.expect_error(format('select resume_session(%L, %L)', c, s1), 'not paused');

  -- Device clock in the future is ignored (server time used)
  perform start_session(c, s2, t1, 1, 60, null, null, null, t0 + interval '3 hours');
  if (select started_at from sessions where id = s2) > now() + interval '1 minute' then raise exception 'Future client time was trusted'; end if;
  -- extend a fixed game
  v := extend_session(c, s2, 30);
  if (v->>'planned_minutes')::int <> 90 then raise exception 'Extend should make 90 minutes, got %', v->>'planned_minutes'; end if;
  -- a second game on the same bill (group: snooker + PS5)
  perform start_session(c, s3, p1, 3, null, null, null, (select tab_id from sessions where id = s2));
  if (select count(*) from sessions where tab_id = (select tab_id from sessions where id = s2)) <> 2 then raise exception 'Group bill should hold 2 games'; end if;
  perform pg_temp.expect_error(format('select set_session_players(%L, %L, 9)', c, s3), 'between 1 and 4');
  perform set_session_players(c, s3, 4);

  -- RC slot: planned minutes default to the slot length
  perform start_session(c, s4, tr, 3);
  if (select planned_minutes from sessions where id = s4) <> 15 then raise exception 'RC slot should default to 15 min'; end if;

  -- Front desk cannot void; can't take a table out of service
  perform pg_temp.expect_error(format('select void_session(%L, %L, %L)', c, s4, 'mistake'), 'permission');
  perform pg_temp.expect_error(format('select set_resource_status(%L, %L, %L)', c, p1, 'out_of_service'), 'permission');

  -- Waiting list
  w := add_to_waitlist(c, snooker, 'Arun', '9847022222', 3, 'wants table near AC');
  if (select status from waitlist where id = w) <> 'waiting' then raise exception 'Waitlist add failed'; end if;
  perform set_waitlist_status(c, w, 'notified');

  -- Floor state shows live games and the waiting list
  v := floor_state(c);
  if jsonb_array_length(v->'resources') <> 4 then raise exception 'Floor state should list 4 resources'; end if;
  select count(*) into n from jsonb_array_elements(v->'resources') x where x->'session' <> 'null'::jsonb;
  if n <> 3 then raise exception 'Floor state should show 3 live games, got %', n; end if;
  if jsonb_array_length(v->'waitlist') <> 1 then raise exception 'Floor state should show the waiting list'; end if;

  -- Seat the waiting customer on Table 2 when free
  perform start_session(c, gen_random_uuid(), t2, 3, null, '9847022222', 'Arun', null, null, 'waitlist', w);
  if (select status from waitlist where id = w) <> 'seated' then raise exception 'Waitlist entry not seated'; end if;
  perform pg_temp.reset();

  -- Owner: void with reason, out of service, prices versioned
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  perform pg_temp.expect_error(format('select void_session(%L, %L, %L)', c, s4, ' '), 'reason');
  perform void_session(c, s4, 'Started on wrong track');
  if (select status from sessions where id = s4) <> 'void' then raise exception 'Void failed'; end if;
  perform pg_temp.expect_error(format('select set_resource_status(%L, %L, %L)', c, p1, 'out_of_service'), 'End the game');
  perform end_session(c, s3);
  perform set_resource_status(c, p1, 'out_of_service', 'Controller broken');
  perform pg_temp.expect_error(format('select start_session(%L, %L, %L)', c, gen_random_uuid(), p1), 'out of service');
  perform save_rate_card(c, snooker, '{"billing_mode":"per_minute","price_paise":25000,"min_minutes":30,"grace_minutes":5,
    "time_rules":[{"label":"Weekend","days":[6,0],"start":"18:00","end":"23:00","price_paise":30000}]}');
  if (select price_paise from rate_cards where activity_id = snooker and active) <> 25000 then raise exception 'New price not active'; end if;
  if (select count(*) from rate_cards where activity_id = snooker) <> 2 then raise exception 'Old price version should be kept'; end if;
  -- the game started before the price change keeps its old card
  if (select price_paise from rate_cards where id = (select rate_card_id from sessions where id = s2)) <> 20000 then raise exception 'Old game lost its price'; end if;
  perform pg_temp.expect_error(format('select save_rate_card(%L, %L, %L::jsonb)', c, snooker, '{"price_paise":1,"time_rules":[{"days":[1]}]}'), 'special price');
  -- removing a table with a live game is refused; removing a free one archives it
  perform pg_temp.expect_error(format('select save_floor(%L, %L::jsonb)', c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', t2, 'activity_id', snooker, 'name', 'Table 2')))), 'game running');
  perform pg_temp.reset();

  -- Isolation: the other centre's owner sees none of this
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f3');
  select count(*) into n from sessions where centre_id = c; if n <> 0 then raise exception 'Other owner can read sessions'; end if;
  select count(*) into n from resources where centre_id = c; if n <> 0 then raise exception 'Other owner can read resources'; end if;
  if session_billable_seconds(s2) is not null then raise exception 'Other owner can read billable time'; end if;
  perform pg_temp.expect_error(format('select floor_state(%L)', c), 'Not allowed');
  perform pg_temp.expect_error(format('select pause_session(%L, %L)', c, s2), 'permission');
  perform pg_temp.expect_error(format('select pause_session(%L, %L)', g, s2), 'not found');
  perform pg_temp.reset();

  -- Signed-out visitors can't call any command
  execute 'set role anon';
  perform pg_temp.expect_error(format('select floor_state(%L)', c), 'permission denied');
  perform pg_temp.expect_error(format('select start_session(%L, %L, %L)', c, gen_random_uuid(), t1), 'permission denied');
  perform pg_temp.reset();

  -- Events are a ledger
  perform pg_temp.expect_error(format('update session_events set at = now() where session_id = %L', s1), 'cannot be changed');
  perform pg_temp.expect_error(format('delete from session_events where session_id = %L', s1), 'cannot be deleted');
  -- ...but deleting a whole centre still works
  delete from centres where id = g;

  raise notice 'All floor/session tests passed';
end $$;
