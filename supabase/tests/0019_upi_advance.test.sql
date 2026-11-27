-- XS Arena — booking advance by UPI and the free Snacks add-on during the pilot.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000911', 'owner.ad@test.local', '{"display_name":"Owner AD"}'),
  ('00000000-0000-0000-0000-000000000912', 'desk.ad@test.local', '{"display_name":"Desk AD"}'),
  ('00000000-0000-0000-0000-000000000913', 'other.ad@test.local', '{"display_name":"Other AD"}');

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

-- centre with two snooker tables, online booking on
do $$
declare c uuid; snooker uuid; fl uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000911');
  c := create_centre('Advance Arena');
  update centres set open_time = '00:00', close_time = '00:00', upi_id = 'advance@okaxis' where id = c;
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'activity_id', snooker, 'name', 'Table 1'),
    jsonb_build_object('id', gen_random_uuid(), 'activity_id', snooker, 'name', 'Table 2'))));
  perform save_booking_settings(c, jsonb_build_object('enabled', true, 'activities', jsonb_build_array(jsonb_build_object('id', snooker, 'walkin_reserve', 0))));
  perform save_staff(c, null, 'Desk AD', 'front_desk', null, null, 'desk.ad@test.local');
  insert into t values ('c', c::text), ('snooker', snooker::text), ('slug', (select slug from centres where id = c));
  perform pg_temp.eq('advance off for a new centre', (select booking_advance_on from centres where id = c), false);
  perform pg_temp.reset();
  perform pg_temp.as_anon();
  perform pg_temp.eq('booking page: no advance asked', (booking_page((select t.v from t where k = 'slug'))->'centre'->>'advance_on')::boolean, false);
  perform pg_temp.reset();
  -- owner switches it on
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000911');
  update centres set booking_advance_on = true where id = c;
  perform pg_temp.reset();
  perform pg_temp.as_anon();
  perform pg_temp.eq('booking page: advance asked', (booking_page((select t.v from t where k = 'slug'))->'centre'->>'advance_on')::boolean, true);
  perform pg_temp.reset();
end $$;

-- booking → advance received → seated → bill: advance is a UPI payment, total unchanged
do $$
declare c uuid := (select v::uuid from t where k = 'c'); snooker uuid := (select v::uuid from t where k = 'snooker');
  v jsonb; bk uuid; res uuid; sid uuid := gen_random_uuid(); tab uuid; bill jsonb; pays jsonb; prev jsonb;
begin
  perform pg_temp.as_anon();
  v := create_booking((select t.v from t where k = 'slug'), snooker, date_trunc('hour', now()) + interval '2 hours', 60, 2, 'Anu Advance', '9847066601');
  bk := (v->'booking'->>'id')::uuid;
  perform pg_temp.eq('20% advance of ₹200 = ₹40', (v->'booking'->>'advance_paise')::bigint, 4000::bigint);
  perform pg_temp.expect_error(format('select mark_booking_advance(%L, %L, true)', c, bk), 'permission denied');
  perform pg_temp.reset();

  perform pg_temp.as_user('00000000-0000-0000-0000-000000000912');   -- front desk
  v := mark_booking_advance(c, bk, true);
  perform pg_temp.eq('advance received', (v->>'paid_paise')::bigint, 4000::bigint);
  perform pg_temp.eq('payment status paid', v->>'payment_status', 'paid');
  v := mark_booking_advance(c, bk, false);
  perform pg_temp.eq('undo works before billing', (v->>'paid_paise')::bigint, 0::bigint);
  perform mark_booking_advance(c, bk, true);

  v := check_in_booking(c, (select code from bookings where id = bk));
  res := (v->'free_tables'->0->>'id')::uuid;
  perform seat_booking(c, bk, res, sid);
  select tab_id into tab from sessions where id = sid;
  prev := tab_preview(c, tab);
  perform pg_temp.eq('bill preview shows the advance', (prev->>'advance_paise')::bigint, 4000::bigint);
  -- min 30 min of ₹200/h = ₹100; staff collect the other ₹60 in cash
  bill := close_tab(c, tab, 0, null, jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_paise', 6000)));
  perform pg_temp.eq('bill total unchanged', (bill->>'total_paise')::bigint, 10000::bigint);
  perform pg_temp.eq('bill paid in full', bill->>'status', 'paid');
  perform pg_temp.eq('paid = cash + advance', (bill->>'paid_paise')::bigint, 10000::bigint);
  perform pg_temp.eq('nothing to give back', (bill->>'advance_refund_paise')::bigint, 0::bigint);
  perform pg_temp.reset();
  select jsonb_agg(jsonb_build_object('m', method, 'a', amount_paise, 'r', reference) order by amount_paise) into pays from payments where bill_id = (bill->>'bill_id')::uuid;
  perform pg_temp.eq('advance payment row', pays->0->>'r', 'Advance · ' || (select code from bookings where id = bk));
  perform pg_temp.eq('advance by UPI', pays->0->>'m', 'upi');
  perform pg_temp.eq('stored bill paid', (select paid_paise from bills where id = (bill->>'bill_id')::uuid), 10000::bigint);
  perform pg_temp.eq('booking points to the bill', (select advance_bill_id from bookings where id = bk), (bill->>'bill_id')::uuid);
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000912');
  perform pg_temp.expect_error(format('select mark_booking_advance(%L, %L, false)', c, bk), 'already on bill');
  perform pg_temp.reset();
end $$;

-- advance larger than the game: bill says what to give back; no-advance and cancelled bookings refused
do $$
declare c uuid := (select v::uuid from t where k = 'c'); snooker uuid := (select v::uuid from t where k = 'snooker');
  v jsonb; bk uuid; res uuid; sid uuid := gen_random_uuid(); tab uuid; bill jsonb; staff_bk uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000911');
  perform save_booking_settings(c, jsonb_build_object('advance_bp', 10000));   -- full amount ahead
  perform pg_temp.reset();
  perform pg_temp.as_anon();
  v := create_booking((select t.v from t where k = 'slug'), snooker, date_trunc('hour', now()) + interval '2 hours', 120, 2, 'Ben Advance', '9847066602');
  bk := (v->'booking'->>'id')::uuid;
  perform pg_temp.reset();
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000912');
  perform mark_booking_advance(c, bk, true);
  v := check_in_booking(c, (select code from bookings where id = bk));
  res := (v->'free_tables'->0->>'id')::uuid;
  perform seat_booking(c, bk, res, sid);
  select tab_id into tab from sessions where id = sid;
  bill := close_tab(c, tab, 0, null, '[]'::jsonb);
  perform pg_temp.eq('short game: total ₹100', (bill->>'total_paise')::bigint, 10000::bigint);
  perform pg_temp.eq('advance used ₹100', (bill->>'advance_used_paise')::bigint, 10000::bigint);
  perform pg_temp.eq('give back ₹300', (bill->>'advance_refund_paise')::bigint, 30000::bigint);
  perform pg_temp.eq('paid', bill->>'status', 'paid');

  v := staff_create_booking(c, snooker, date_trunc('hour', now()) + interval '6 hours', 60, 1, 'Phone Guy', '9847066603');
  staff_bk := (v->'booking'->>'id')::uuid;
  perform pg_temp.expect_error(format('select mark_booking_advance(%L, %L, true)', c, staff_bk), 'no advance');
  perform pg_temp.reset();
  perform pg_temp.as_anon();
  v := create_booking((select t.v from t where k = 'slug'), snooker, date_trunc('hour', now()) + interval '8 hours', 60, 1, 'Cancel Me', '9847066604');
  perform cancel_booking_by_token(v->>'token');
  perform pg_temp.reset();
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000912');
  perform pg_temp.expect_error(format('select mark_booking_advance(%L, %L, true)', c, (v->'booking'->>'id')), 'cancelled');
  -- a bill without any booking is unchanged
  perform pg_temp.reset();
end $$;

-- Snacks free during the pilot: owner turns it on, front desk can't
do $$
declare c uuid := (select v::uuid from t where k = 'c');
begin
  perform pg_temp.eq('snacks off for a new centre', has_feature(c, 'snacks'), false);
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000912');
  perform pg_temp.expect_error(format('select claim_free_addon(%L, %L)', c, 'snacks'), '');
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000911');
  perform pg_temp.expect_error(format('select claim_free_addon(%L, %L)', c, 'gold'), 'Unknown');
  perform claim_free_addon(c, 'snacks');
  perform claim_free_addon(c, 'snacks');   -- twice is fine
  perform pg_temp.reset();
  perform pg_temp.eq('snacks on', has_feature(c, 'snacks'), true);
end $$;

select 'upi advance ok';
