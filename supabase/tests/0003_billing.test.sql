-- XS Arena — billing DB tests: exact prices for every rule, bills, payments, stock, shifts, TV screens.
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
  ('00000000-0000-0000-0000-0000000000b1', 'owner.b@test.local', '{"display_name":"Owner B"}'),
  ('00000000-0000-0000-0000-0000000000b2', 'desk.b@test.local', '{}');

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
-- play a finished game: start p_minutes_ago, end now (now() is fixed inside this transaction)
create or replace function pg_temp.play(c uuid, r uuid, p_minutes numeric, p_players int default 1, p_planned int default null, p_tab uuid default null)
returns uuid language plpgsql as $$
declare s uuid := gen_random_uuid();
begin
  perform start_session(c, s, r, p_players, p_planned, null, null, p_tab, now() - make_interval(secs => p_minutes * 60));
  perform end_session(c, s, now());
  return s;
end $$;
-- volatile on purpose: reads with a fresh snapshot so it sees a game created in the same statement
create or replace function pg_temp.amount(s uuid) returns bigint language plpgsql volatile as $$
begin return (price_session(s)->>'amount_paise')::bigint; end $$;
create or replace function pg_temp.check(label text, got bigint, want bigint) returns void language plpgsql as $$
begin if got is distinct from want then raise exception '%: expected ₹% but got ₹%', label, want / 100.0, got / 100.0; end if; end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

do $$
declare
  c uuid; snooker uuid; pool uuid; ps5 uuid; drift uuid; fl uuid; t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  t3 uuid := gen_random_uuid(); p1 uuid := gen_random_uuid(); tr uuid := gen_random_uuid(); pl uuid := gen_random_uuid();
  s uuid; s2 uuid; tab uuid; soda uuid; v jsonb; b jsonb; loc timestamp; n numeric; tv jsonb; v_screen uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  c := create_centre('Billing Arena');
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into pool from activities where centre_id = c and name = 'Pool';
  select id into ps5 from activities where centre_id = c and name = 'PS5';
  select id into drift from activities where centre_id = c and name = 'RC Drift';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', t1, 'activity_id', snooker, 'name', 'Table 1'),
    jsonb_build_object('id', t2, 'activity_id', snooker, 'name', 'Table 2'),
    jsonb_build_object('id', t3, 'activity_id', snooker, 'name', 'Table 3'),
    jsonb_build_object('id', pl, 'activity_id', pool, 'name', 'Pool 1'),
    jsonb_build_object('id', p1, 'activity_id', ps5, 'name', 'PS5 #1', 'capacity', 4),
    jsonb_build_object('id', tr, 'activity_id', drift, 'name', 'Drift Track', 'capacity', 8))));
  perform save_staff(c, null, 'Desk B', 'front_desk', null, null, 'desk.b@test.local');

  -- ── Snooker ₹200/hr per minute, minimum 30, grace 5 (starter prices)
  perform pg_temp.check('45 min snooker', pg_temp.amount(pg_temp.play(c, t1, 45)), 15000);
  perform pg_temp.check('10 min snooker hits 30-min minimum', pg_temp.amount(pg_temp.play(c, t1, 10)), 10000);
  perform pg_temp.check('started minute counts (45m 10s = 46 min)', pg_temp.amount(pg_temp.play(c, t1, 45 + 10/60.0)), 15300);
  -- fixed 60-min game: 63 min within grace → 60 min; 70 min → 60 + 10 overtime at normal rate
  perform pg_temp.check('63 min on a 60-min booking (grace)', pg_temp.amount(pg_temp.play(c, t1, 63, 1, 60)), 20000);
  perform pg_temp.check('70 min on a 60-min booking (overtime)', pg_temp.amount(pg_temp.play(c, t1, 70, 1, 60)), 23300);
  -- pause is not charged
  s := gen_random_uuid();
  perform start_session(c, s, t2, 2, null, null, null, null, now() - interval '90 minutes');
  perform pause_session(c, s, now() - interval '60 minutes');
  perform resume_session(c, s, now() - interval '30 minutes');
  perform end_session(c, s, now());
  perform pg_temp.check('90 min with 30 min paused = 60 min', pg_temp.amount(s), 20000);
  -- live (running) game is priced up to now
  s := gen_random_uuid();
  perform start_session(c, s, t3, 2, null, null, null, null, now() - interval '30 minutes');
  perform pg_temp.check('running 30 min', pg_temp.amount(s), 10000);
  if ((select x->'session'->>'cost_paise' from jsonb_array_elements(floor_state(c)->'resources') x where x->>'id' = t3::text))::bigint <> 10000 then
    raise exception 'Floor state should show the running cost';
  end if;
  perform void_session(c, s, 'test');
  perform pg_temp.check('void game costs nothing', pg_temp.amount(s), 0);

  -- ── Peak price split by the local clock: last 20 minutes at ₹300/hr
  loc := now() at time zone 'Asia/Kolkata';
  perform save_rate_card(c, snooker, jsonb_build_object('billing_mode','per_minute','price_paise',20000,'min_minutes',30,'grace_minutes',5,
    'time_rules', jsonb_build_array(jsonb_build_object('label','Peak','days', jsonb_build_array(0,1,2,3,4,5,6),
      'start', to_char(loc - interval '20 minutes', 'HH24:MI'), 'end', to_char(loc + interval '60 minutes', 'HH24:MI'), 'price_paise', 30000))));
  -- align the game to whole minutes of the local clock so the split is exact
  s := gen_random_uuid();
  perform start_session(c, s, t1, 1, null, null, null, null, date_trunc('minute', now()) - interval '60 minutes');
  perform end_session(c, s, date_trunc('minute', now()));
  -- 40 min standard = ₹133.33 → ₹133; 20 min peak = ₹100
  perform pg_temp.check('peak split', pg_temp.amount(s), 23300);
  if jsonb_array_length(price_session(s)->'lines') <> 2 then raise exception 'Peak split should give 2 lines: %', price_session(s)->'lines'; end if;

  -- ── Hourly blocks: 30-min blocks, grace 5 → 40 min = 2 blocks, 34 min = 1 block (within grace)
  perform save_rate_card(c, pool, '{"billing_mode":"hourly_block","price_paise":15000,"block_minutes":30,"grace_minutes":5,"min_minutes":30}');
  perform pg_temp.check('pool 40 min = 2 blocks', pg_temp.amount(pg_temp.play(c, pl, 40)), 15000);
  perform pg_temp.check('pool 34 min = 1 block (grace)', pg_temp.amount(pg_temp.play(c, pl, 34)), 7500);

  -- ── PS5 ₹120/hr, 2 players included, extra ₹30/hr each: 4 players 60 min = 120 + 60
  perform pg_temp.check('PS5 4 players 60 min', pg_temp.amount(pg_temp.play(c, p1, 60, 4)), 18000);

  -- ── RC Drift ₹150 per car per 15-min slot: 3 cars → ₹450; 25 min → +10 min overtime at ₹600/hr per car = ₹300
  perform pg_temp.check('RC 3 cars 15 min', pg_temp.amount(pg_temp.play(c, tr, 15, 3)), 45000);
  perform pg_temp.check('RC 3 cars 25 min (overtime)', pg_temp.amount(pg_temp.play(c, tr, 25, 3)), 75000);

  -- ── Per frame (snooker set to ₹50/frame): 3 frames
  perform save_rate_card(c, snooker, '{"billing_mode":"per_frame","price_paise":5000}');
  s := pg_temp.play(c, t2, 50);
  perform set_session_frames(c, s, 3);
  perform pg_temp.check('3 frames', pg_temp.amount(s), 15000);
  perform save_rate_card(c, snooker, '{"billing_mode":"per_minute","price_paise":20000,"min_minutes":30,"grace_minutes":5}');

  -- ── A group bill: snooker 60 min + PS5 2 players 30 min + 2 soft drinks
  s := gen_random_uuid();
  v := start_session(c, s, t1, 2, null, '9847033333', 'Vishnu', null, now() - interval '60 minutes');
  tab := (v->>'tab_id')::uuid;
  s2 := gen_random_uuid();
  perform start_session(c, s2, p1, 2, null, null, null, tab, now() - interval '30 minutes');
  select id into soda from products where centre_id = c and name = 'Soft drink';
  n := (select stock_qty from products where id = soda);
  perform tab_add_item(c, tab, soda, 2);
  if (select stock_qty from products where id = soda) <> n - 2 then raise exception 'Stock not reduced'; end if;
  perform tab_add_item(c, tab, null, 1, 'Extra controller', 3000);
  v := tab_preview(c, tab);
  -- 200 + 60 + 80 + 30 = 370
  perform pg_temp.check('group bill preview', (v->>'subtotal_paise')::bigint, 37000);
  if not (v->>'live')::boolean then raise exception 'Preview should show live games'; end if;
  perform pg_temp.reset();

  -- Front desk: can bill, cannot discount or void
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
  perform claim_invites();
  perform pg_temp.expect_error(format('select close_tab(%L, %L, 5000, %L)', c, tab, 'regular'), 'permission');
  b := close_tab(c, tab, 0, null, '[{"method":"cash","amount_paise":20000},{"method":"upi","amount_paise":17000}]', '11111111-1111-1111-1111-111111111111');
  if b->>'status' <> 'paid' then raise exception 'Bill should be paid: %', b; end if;
  perform pg_temp.check('bill total', (b->>'total_paise')::bigint, 37000);
  -- same key again → same bill, no double charge
  b := close_tab(c, tab, 0, null, '[{"method":"cash","amount_paise":37000}]', '11111111-1111-1111-1111-111111111111');
  if not (b->>'duplicate')::boolean then raise exception 'Duplicate close not detected'; end if;
  if (select count(*) from sessions where tab_id = tab and status = 'ended') <> 2 then raise exception 'Closing should end live games'; end if;
  if (select visit_count from customers where phone = '+919847033333' and centre_id = c) <> 1 then raise exception 'Customer visit not counted'; end if;
  perform pg_temp.expect_error(format('select void_bill(%L, %L, %L)', c, b->>'bill_id', 'oops'), 'permission');
  perform pg_temp.expect_error(format('select tab_add_item(%L, %L, %L, 1)', c, tab, soda), 'closed');
  perform pg_temp.reset();

  -- Owner: discount needs a reason; partial payment; dues; void restores stock
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  s := pg_temp.play(c, t2, 60);
  tab := (select tab_id from sessions where id = s);
  perform tab_add_item(c, tab, soda, 1);
  perform pg_temp.expect_error(format('select close_tab(%L, %L, 2000)', c, tab), 'reason');
  perform pg_temp.expect_error(format('select close_tab(%L, %L, 0, null, %L::jsonb)', c, tab, '[{"method":"cash","amount_paise":999999}]'), 'more than');
  b := close_tab(c, tab, 4000, 'Regular customer', '[{"method":"cash","amount_paise":10000}]');
  perform pg_temp.check('discounted total', (b->>'total_paise')::bigint, 20000);   -- 200 + 40 - 40
  if b->>'status' <> 'partial' then raise exception 'Should be partial'; end if;
  if (dashboard_summary(c)->>'dues_paise')::bigint <> 10000 then raise exception 'Dues not on dashboard'; end if;
  perform add_payment(c, (b->>'bill_id')::uuid, 'upi', 10000);
  if (select status from bills where id = (b->>'bill_id')::uuid) <> 'paid' then raise exception 'Should be paid after dues'; end if;
  n := (select stock_qty from products where id = soda);
  perform void_bill(c, (b->>'bill_id')::uuid, 'Wrong table');
  if (select stock_qty from products where id = soda) <> n + 1 then raise exception 'Void should restore stock'; end if;
  if (select count(*) from payments where bill_id = (b->>'bill_id')::uuid and status = 'ok') <> 0 then raise exception 'Void should void payments'; end if;

  -- GST on, prices include tax: ₹200 → tax 30.51
  update centres set gst_enabled = true, gst_rate_bp = 1800 where id = c;
  s := pg_temp.play(c, t3, 60);
  b := close_tab(c, (select tab_id from sessions where id = s), 0, null, '[{"method":"card","amount_paise":20000}]');
  if (select tax_paise from bills where id = (b->>'bill_id')::uuid) <> 3051 then raise exception 'GST wrong: %', (select tax_paise from bills where id = (b->>'bill_id')::uuid); end if;
  update centres set gst_enabled = false where id = c;

  -- Dashboard sees today's sales (37000 + 20000; the voided bill doesn't count)
  v := dashboard_summary(c);
  perform pg_temp.check('revenue today', (v->>'revenue_today')::bigint, 57000);
  if (v->'by_activity_today'->>'Snooker')::bigint <> 40000 then raise exception 'By-activity wrong: %', v->'by_activity_today'; end if;

  -- ── Shift: opening 1000, then a ₹150 cash bill and a ₹50 drawer expense → expected 1100
  perform open_shift(c, 100000);
  perform pg_temp.expect_error(format('select open_shift(%L, 0)', c), 'already open');
  perform pg_temp.reset();
  -- (move the shift start back a moment so this transaction's rows count)
  update shifts set opened_at = now() - interval '1 second' where centre_id = c and status = 'open';
  -- everything in this test shares one clock time: push earlier money before the shift
  update payments set created_at = now() - interval '1 hour' where centre_id = c;
  update expenses set created_at = now() - interval '1 hour' where centre_id = c;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  s := pg_temp.play(c, t1, 45);
  perform close_tab(c, (select tab_id from sessions where id = s), 0, null, '[{"method":"cash","amount_paise":15000}]');
  perform record_expense(c, 'Snacks stock', 5000, null, 'cash', 'drawer', 'Milk');
  perform pg_temp.check('expected cash', (current_shift(c)->>'expected_cash_paise')::bigint, 110000);
  perform pg_temp.expect_error(format('select close_shift(%L, 100000)', c), 'short');
  v := close_shift(c, 100000, 'Paid the electrician from the drawer');
  perform pg_temp.check('shift difference', (v->>'difference_paise')::bigint, -10000);
  perform pg_temp.reset();

  -- ── TV screen pairing (signed-out TV)
  execute 'set role anon';
  tv := tv_begin();
  if length(tv->>'code') <> 6 then raise exception 'TV code should be 6 digits'; end if;
  if tv_poll(tv->>'token')->>'state' <> 'pairing' then raise exception 'TV should be waiting to pair'; end if;
  perform pg_temp.expect_error(format('select floor_state(%L)', c), 'permission denied');
  perform pg_temp.reset();
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
  perform pg_temp.expect_error(format('select tv_link(%L, %L)', c, tv->>'code'), 'permission');
  perform pg_temp.reset();
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  perform pg_temp.expect_error(format('select tv_link(%L, %L)', c, '000000x'), 'wrong or has expired');
  v_screen := tv_link(c, tv->>'code', 'Hall TV', 'customer');
  s := gen_random_uuid();
  perform start_session(c, s, t1, 2, 60, '9847044444', 'Secret Person', null, now() - interval '5 minutes');
  perform pg_temp.reset();
  execute 'set role anon';
  v := tv_poll(tv->>'token');
  if v->>'state' <> 'live' then raise exception 'TV should be live: %', v; end if;
  if v::text like '%Secret%' or v::text like '%9847044444%' or v::text like '%cost_paise%' then raise exception 'Customer TV leaks private data'; end if;
  if tv_poll('not-a-token')->>'state' <> 'revoked' then raise exception 'Bad token should be refused'; end if;
  perform pg_temp.reset();
  -- Starter plan allows 1 TV
  update centre_subscriptions set plan = 'starter' where centre_id = c;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  tv := tv_begin();
  perform pg_temp.expect_error(format('select tv_link(%L, %L)', c, tv->>'code'), 'plan allows 1');
  perform tv_revoke(c, v_screen);
  perform pg_temp.reset();
  execute 'set role anon';
  if tv_poll((select 'x')) ->> 'state' <> 'revoked' then raise exception 'x'; end if;
  perform pg_temp.reset();

  raise notice 'All billing tests passed';
end $$;

drop trigger zz_test_old_rules on public.centres;
drop function public._test_old_rules();
