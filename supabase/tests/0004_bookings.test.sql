-- XS Arena — booking DB tests: availability engine, walk-in reserve, online/staff bookings, check-in, seating,
-- smart extensions, "free until", ticket privacy, cancellations, permissions.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner.c@test.local', '{"display_name":"Owner C"}'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner.d@test.local', '{"display_name":"Owner D"}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'set role anon'; end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm not ilike '%' || p_like || '%' then raise exception 'Expected error like "%" but got "%"', p_like, sqlerrm; end if;
    return;
  end;
  raise exception 'Expected an error like "%" for: %', p_like, p_sql;
end $$;
create or replace function pg_temp.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin if got is distinct from want then raise exception '%: expected % but got %', label, want, got; end if; end $$;
create or replace function pg_temp.tomorrow(p time) returns timestamptz language sql as $$
  select ((now() at time zone 'Asia/Kolkata')::date + 1 + p) at time zone 'Asia/Kolkata' $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- shared between blocks
create temp table t(k text primary key, v text);
grant all on t to authenticated, anon;

do $$
declare c uuid; d uuid; snooker uuid; pool uuid; fl uuid; t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); p1 uuid := gen_random_uuid();
  v_at timestamptz := date_trunc('hour', now()) + interval '3 hours';   -- on a slot, 2–3 h from now
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  c := create_centre('Booking Arena');
  update centres set open_time = '00:00', close_time = '00:00' where id = c;   -- open round the clock for the test
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into pool from activities where centre_id = c and name = 'Pool';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', t1, 'activity_id', snooker, 'name', 'Table 1'),
    jsonb_build_object('id', t2, 'activity_id', snooker, 'name', 'Table 2'),
    jsonb_build_object('id', p1, 'activity_id', pool, 'name', 'Pool 1'))));
  -- booking closed by default
  perform pg_temp.expect_error(format('select booking_page(%L)', (select slug from centres where id = c)), 'not open');
  perform save_booking_settings(c, jsonb_build_object('enabled', true, 'activities',
    jsonb_build_array(jsonb_build_object('id', snooker, 'walkin_reserve', 1))));
  perform pg_temp.reset();   -- internal helpers are only callable by the database itself
  perform pg_temp.eq('online snooker tables (2 minus 1 reserve)', _activity_capacity(snooker, true), 1);
  perform pg_temp.eq('all snooker tables', _activity_capacity(snooker, false), 2);
  insert into t values ('c', c), ('snooker', snooker), ('pool', pool), ('t1', t1), ('t2', t2), ('p1', p1),
    ('slug', (select slug from centres where id = c)), ('at', v_at);

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c2');
  d := create_centre('Other Arena');
  insert into t values ('d', d);
  perform pg_temp.reset();
end $$;

-- ── Customer books online (signed out)
do $$
declare v_slug text := (select t.v from t where t.k = 'slug'); snooker uuid := (select t.v from t where t.k = 'snooker')::uuid;
  v_at timestamptz := (select t.v from t where t.k = 'at')::timestamptz; v jsonb; s jsonb;
begin
  perform pg_temp.as_anon();
  v := booking_page(v_slug);
  perform pg_temp.eq('booking page shows snooker with 1 online table',
    (select (x->>'online_tables')::int from jsonb_array_elements(v->'activities') x where x->>'name' = 'Snooker'), 1);
  if exists (select 1 from jsonb_array_elements(v->'resources') x where x ? 'session') then raise exception 'Public floor must not show sessions'; end if;

  s := booking_slots(v_slug, snooker, (v_at at time zone 'Asia/Kolkata')::date, 60);
  perform pg_temp.eq('slot free before booking', (select (x->>'free')::boolean from jsonb_array_elements(s->'slots') x where (x->>'at')::timestamptz = v_at), true);

  v := create_booking(v_slug, snooker, v_at, 60, 2, 'Anu', '98470 11111');
  perform pg_temp.eq('estimate ₹200 for 1h snooker', (v->'booking'->>'estimate_paise')::bigint, 20000::bigint);
  perform pg_temp.eq('20% advance = ₹40', (v->'booking'->>'advance_paise')::bigint, 4000::bigint);
  perform pg_temp.eq('6-char code', length(v->'booking'->>'code'), 6);
  if v->'booking'->>'phone' like '%11111' and v->'booking'->>'phone' not like '%•%' then raise exception 'Phone should be masked for the public'; end if;
  insert into t values ('token1', v->>'token'), ('code1', v->'booking'->>'code'), ('b1', v->'booking'->>'id');

  -- the only online table is now taken for that hour; 30 min later still overlaps
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,1,%L,%L)', v_slug, snooker, v_at, 'Ben', '9847022222'), 'just taken');
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,1,%L,%L)', v_slug, snooker, v_at + interval '30 minutes', 'Ben', '9847022222'), 'just taken');
  s := booking_slots(v_slug, snooker, (v_at at time zone 'Asia/Kolkata')::date, 60);
  perform pg_temp.eq('slot full after booking', (select (x->>'free')::boolean from jsonb_array_elements(s->'slots') x where (x->>'at')::timestamptz = v_at), false);
  -- right after it ends is fine
  perform create_booking(v_slug, snooker, v_at + interval '60 minutes', 60, 1, 'Ben', '9847022222');

  -- bad inputs
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,45,1,%L,%L)', v_slug, snooker, v_at, 'X', '9847033333'), 'times shown');
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,1,%L,%L)', v_slug, snooker, now() - interval '1 hour', 'X', '9847033333'), 'passed');
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,1,%L,%L)', v_slug, snooker, now() + interval '5 minutes', 'X', '9847033333'), 'ahead');
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,1,%L,%L)', v_slug, snooker, now() + interval '30 days', 'X', '9847033333'), 'days ahead');
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,9,%L,%L)', v_slug, snooker, v_at + interval '5 hours', 'X', '9847033333'), 'At most');
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,1,%L,%L)', v_slug, snooker, v_at + interval '5 hours', 'X', '12'), 'valid phone');

  -- ticket link works signed out, phone masked
  v := booking_ticket((select t.v from t where t.k = 'token1'));
  perform pg_temp.eq('ticket shows the booking', v->'booking'->>'name', 'Anu');
  if v->'booking'->>'phone' not like '%•%' then raise exception 'Ticket phone should be masked'; end if;
  perform pg_temp.expect_error('select booking_ticket(''nope'')', 'not found');
  -- staff functions are not callable signed out
  perform pg_temp.expect_error(format('select bookings_for_day(%L, current_date)', (select t.v from t where t.k = 'c')), 'permission denied');
  perform pg_temp.reset();
end $$;

-- ── Staff: phone booking may use the walk-in reserve, walk-in + smart extension, free-until, check-in, seating
do $$
declare c uuid := (select t.v from t where t.k = 'c')::uuid; snooker uuid := (select t.v from t where t.k = 'snooker')::uuid;
  t1 uuid := (select t.v from t where t.k = 't1')::uuid; t2 uuid := (select t.v from t where t.k = 't2')::uuid;
  v_at timestamptz := (select t.v from t where t.k = 'at')::timestamptz; v jsonb; s uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); fs jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  v := staff_create_booking(c, snooker, v_at, 60, 2, 'Chris', '9847044444', 'birthday');
  perform pg_temp.eq('staff booking has no advance', (v->'booking'->>'advance_paise')::bigint, 0::bigint);
  insert into t values ('token2', v->>'token'), ('b2', v->'booking'->>'id');
  perform pg_temp.expect_error(format('select staff_create_booking(%L,%L,%L,60,1,%L,%L)', c, snooker, v_at, 'Dev', '9847055555'), 'just taken');

  -- walk-in now on Table 1 for 60 min; both tables are booked from v_at (2–3 h from now)
  perform start_session(c, s, t1, 2, 60, null, null, null, now());
  v := extension_check(c, s, 120);
  perform pg_temp.eq('extension of 120 min clashes', (v->>'ok')::boolean, false);
  perform pg_temp.eq('can add up to the booking (5-min steps)', (v->>'max_minutes')::int,
    least(115, floor(extract(epoch from v_at - now() - interval '60 minutes') / 300)::int * 5));
  perform pg_temp.eq('clash is the booking time', (v->>'booked_at')::timestamptz, v_at);
  if not exists (select 1 from jsonb_array_elements(v->'alternatives') x where x->>'name' = 'Pool') then raise exception 'Pool should be offered as an alternative'; end if;
  perform pg_temp.expect_error(format('select extend_session(%L,%L,120)', c, s), 'Booked from');
  perform pg_temp.eq('extend 30 is fine', (extend_session(c, s, 30)->>'planned_minutes')::int, 90);
  -- a replayed extend (same client time) is not re-checked
  perform extend_session(c, s, 30, now());
  perform extend_session(c, s, 30, now());
  perform pg_temp.eq('replay does not add twice', (select planned_minutes from sessions where id = s), 120);
  perform pg_temp.expect_error(format('select extend_session(%L,%L,60)', c, s), 'Booked from');

  -- free until: both snooker tables are needed at v_at
  fs := floor_state(c);
  perform pg_temp.eq('snooker free until the booking', (select (x->>'free_until')::timestamptz from jsonb_array_elements(fs->'activities') x where x->>'name' = 'Snooker'), v_at);
  perform pg_temp.eq('pool is free all day', (select x->>'free_until' from jsonb_array_elements(fs->'activities') x where x->>'name' = 'Pool'), null::text);
  perform pg_temp.eq('floor lists 3 upcoming bookings', jsonb_array_length(fs->'bookings'), 3);

  -- check in by code (lower case typed), then by scanned ticket URL
  v := check_in_booking(c, lower((select t.v from t where t.k = 'code1')));
  perform pg_temp.eq('arrived', v->'booking'->>'status', 'arrived');
  perform pg_temp.eq('staff see the full phone', v->'booking'->>'phone', '+919847011111');
  perform pg_temp.eq('Table 2 suggested', (v->'free_tables'->0->>'id')::uuid, t2);
  perform pg_temp.eq('balance = estimate', (v->>'balance_paise')::bigint, 20000::bigint);
  v := check_in_booking(c, 'https://arena.xelorsoft.com/t/' || (select t.v from t where t.k = 'token1'));
  perform pg_temp.eq('scan again is fine', v->'booking'->>'status', 'arrived');
  perform pg_temp.expect_error(format('select check_in_booking(%L,%L)', c, 'ZZZZZZ'), 'No booking');

  -- seat at the wrong game / right table
  perform pg_temp.expect_error(format('select seat_booking(%L,%L,%L,%L)', c, (select t.v from t where t.k = 'b1'), (select t.v from t where t.k = 'p1'), gen_random_uuid()), 'Pick a Snooker');
  v := seat_booking(c, (select t.v from t where t.k = 'b1')::uuid, t2, s2, now());
  perform pg_temp.eq('seated game runs', v->>'status', 'running');
  perform pg_temp.eq('booked minutes carried over', (select planned_minutes from sessions where id = s2), 60);
  perform pg_temp.eq('source is booking', (select source from sessions where id = s2), 'booking');
  perform pg_temp.eq('booking seated', (select status from bookings where id = (select t.v from t where t.k = 'b1')::uuid), 'seated');
  perform pg_temp.eq('party size carried over', (select players from sessions where id = s2), 2);
  -- seating twice with the same game id is a replay
  perform seat_booking(c, (select t.v from t where t.k = 'b1')::uuid, t2, s2, now());
  -- a code of a seated booking no longer checks in
  perform pg_temp.expect_error(format('select check_in_booking(%L,%L)', c, (select t.v from t where t.k = 'code1')), 'No booking');
  perform pg_temp.reset();
end $$;

-- ── Cancel, no-show, hold time, privacy between centres
do $$
declare c uuid := (select t.v from t where t.k = 'c')::uuid; d uuid := (select t.v from t where t.k = 'd')::uuid;
  snooker uuid := (select t.v from t where t.k = 'snooker')::uuid; v_at timestamptz := (select t.v from t where t.k = 'at')::timestamptz; b uuid;
begin
  perform pg_temp.as_anon();
  perform cancel_booking_by_token((select t.v from t where t.k = 'token2'));
  perform pg_temp.expect_error(format('select cancel_booking_by_token(%L)', (select t.v from t where t.k = 'token2')), 'can''t be cancelled');
  perform pg_temp.reset();

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  perform pg_temp.eq('cancelled', (select status from bookings where id = (select t.v from t where t.k = 'b2')::uuid), 'cancelled');
  -- the cancelled slot is bookable again by staff
  b := (staff_create_booking(c, snooker, v_at, 60, 1, 'Dev', '9847055555')->'booking'->>'id')::uuid;
  perform set_booking_status(c, b, 'no_show', 'did not come');
  perform pg_temp.reset();
  perform pg_temp.eq('no-show frees the table', _can_fit(snooker, v_at, v_at + interval '1 hour', false), true);
  -- un-doing a no-show re-checks the table
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  perform set_booking_status(c, b, 'confirmed');
  perform pg_temp.expect_error(format('select set_booking_status(%L,%L,%L)', c, (select t.v from t where t.k = 'b1'), 'cancelled'), 'already playing');

  -- a late, not-arrived booking stops holding its table after the hold time
  perform pg_temp.reset();
  insert into bookings(centre_id, activity_id, name, phone, starts_at, ends_at, minutes, code, token_hash)
  values (c, snooker, 'Late', '9847066666', now() - interval '20 minutes', now() + interval '40 minutes', 60, 'LATE01', 'x-late');
  perform pg_temp.eq('late booking shows as late', (select _booking_json(bk, true)->>'status' from bookings bk where bk.code = 'LATE01'), 'late');
  perform pg_temp.eq('late booking no longer holds a table', _activity_load(snooker, now(), now() + interval '1 minute', null, null, true), 0);
  perform pg_temp.reset();

  -- another centre's owner sees nothing and can't act
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c2');
  perform pg_temp.expect_error(format('select bookings_for_day(%L, current_date)', c), 'Not allowed');
  perform pg_temp.expect_error(format('select check_in_booking(%L,%L)', c, 'ABCDEF'), '');
  perform pg_temp.eq('no rows visible', (select count(*) from bookings where centre_id = c), 0::bigint);
  perform pg_temp.expect_error(format('select save_booking_settings(%L,%L)', c, '{"enabled":true}'), '');
  perform pg_temp.reset();

  -- phone limit: 3 upcoming online bookings
  perform pg_temp.as_anon();
  perform create_booking((select t.v from t where t.k = 'slug'), (select t.v from t where t.k = 'pool')::uuid, pg_temp.tomorrow('10:00'), 60, 1, 'Eve', '9847077777');
  perform create_booking((select t.v from t where t.k = 'slug'), (select t.v from t where t.k = 'pool')::uuid, pg_temp.tomorrow('12:00'), 60, 1, 'Eve', '9847077777');
  perform create_booking((select t.v from t where t.k = 'slug'), (select t.v from t where t.k = 'pool')::uuid, pg_temp.tomorrow('14:00'), 60, 1, 'Eve', '9847077777');
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,1,%L,%L)', (select t.v from t where t.k = 'slug'), (select t.v from t where t.k = 'pool'),
    pg_temp.tomorrow('16:00'), 'Eve', '9847077777'), 'already have 3');
  perform pg_temp.reset();
end $$;

-- ── Signed-out visitors may call only the booking page, ticket and TV functions
do $$
declare v text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
    and p.proname not in ('booking_page','booking_slots','create_booking','booking_ticket','cancel_booking_by_token','tv_begin','tv_poll');
  if v is not null then raise exception 'Signed-out visitors can call: %', v; end if;
end $$;

select 'bookings ok';
