-- XS Arena — loyalty DB tests: earning, welcome/birthday bonus, multipliers, happy hours, redeem limits, voids, expiry, permissions.
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
  ('00000000-0000-0000-0000-0000000000e1', 'owner.e@test.local', '{"display_name":"Owner E"}'),
  ('00000000-0000-0000-0000-0000000000e2', 'desk.e@test.local', '{}');

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
create or replace function pg_temp.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin if got is distinct from want then raise exception '%: expected % but got %', label, want, got; end if; end $$;
-- a finished 60-minute snooker game for a phone number; returns its open tab
create or replace function pg_temp.game(c uuid, r uuid, p_phone text, p_minutes int default 60) returns uuid language plpgsql as $$
declare s uuid := gen_random_uuid(); v jsonb;
begin
  v := start_session(c, s, r, 1, null, p_phone, 'Guest', null, now() - make_interval(mins => p_minutes));
  perform end_session(c, s, now());
  return (v->>'tab_id')::uuid;
end $$;
create or replace function pg_temp.bal(c uuid, cu uuid) returns int language plpgsql volatile as $$
begin return (customer_points(c, cu)->>'balance')::int; end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;
create temp table t(k text primary key, v text);
grant all on t to authenticated;

do $$
declare c uuid; snooker uuid; fl uuid; t1 uuid := gen_random_uuid(); tab uuid; v jsonb; cu uuid; b2 uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
  c := create_centre('Loyalty Arena');
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(jsonb_build_object('id', t1, 'activity_id', snooker, 'name', 'Table 1'))));
  perform save_staff(c, null, 'Desk E', 'front_desk', null, null, 'desk.e@test.local');
  insert into t values ('c', c), ('t1', t1), ('snooker', snooker);

  -- on from day one with the default rules (Abhinand, 24 Nov); when the owner turns it off, bills earn nothing
  perform pg_temp.eq('loyalty on by default', (loyalty_settings_get(c)->>'enabled')::boolean, true);
  perform pg_temp.eq('default rules', (loyalty_settings_get(c)->>'earn_points_per_100')::int, 10);
  perform save_loyalty_settings(c, '{"enabled":false}');
  v := close_tab(c, pg_temp.game(c, t1, '9847100001'), 0, null, '[{"method":"cash","amount_paise":20000}]');
  perform pg_temp.eq('no points while off', (v->>'points_earned')::int, 0);

  perform save_loyalty_settings(c, '{"enabled":true}');
  -- ₹200 game: 10 pts per ₹100 = 20, plus 50 welcome
  v := close_tab(c, pg_temp.game(c, t1, '9847100002'), 0, null, '[{"method":"cash","amount_paise":20000}]');
  perform pg_temp.eq('earn 20 + welcome 50', (v->>'points_earned')::int, 70);
  select id into cu from customers where centre_id = c and phone = '+919847100002';
  insert into t values ('cu', cu);
  perform pg_temp.eq('balance 70', pg_temp.bal(c, cu), 70);
  perform pg_temp.eq('70 < minimum 100 so nothing usable', (customer_points(c, cu, 20000)->>'usable')::int, 0);
  -- second bill: no second welcome
  v := close_tab(c, pg_temp.game(c, t1, '9847100002'), 0, null, '[{"method":"cash","amount_paise":20000}]');
  perform pg_temp.eq('no repeat welcome', (v->>'points_earned')::int, 20);
  perform adjust_points(c, cu, 210, 'promo');
  perform pg_temp.eq('balance 300', pg_temp.bal(c, cu), 300);
  perform pg_temp.eq('usable on ₹200 = 50% / ₹0.50 = 200', (customer_points(c, cu, 20000)->>'usable')::int, 200);
  perform pg_temp.eq('usable is whole rupees (₹155 bill → 154)', (customer_points(c, cu, 15500)->>'usable')::int, 154);
  perform pg_temp.reset();
end $$;

-- ── Front desk uses points; limits; earning on the rest
do $$
declare c uuid := (select t.v from t where t.k = 'c'); t1 uuid := (select t.v from t where t.k = 't1'); cu uuid := (select t.v from t where t.k = 'cu');
  tab uuid; v jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
  perform claim_invites();
  tab := pg_temp.game(c, t1, '9847100002');
  perform pg_temp.expect_error(format('select close_tab(%L,%L,0,null,%L,null,50)', c, tab, '[]'), 'at least 100');
  perform pg_temp.expect_error(format('select close_tab(%L,%L,0,null,%L,null,250)', c, tab, '[]'), 'at most 50 percent');
  perform pg_temp.expect_error(format('select save_loyalty_settings(%L,%L)', c, '{"enabled":false}'), '');
  perform pg_temp.expect_error(format('select adjust_points(%L,%L,10,%L)', c, cu, 'x'), '');
  -- 100 points = ₹50 off a ₹200 bill; earn on the ₹150 actually paid = 15
  v := close_tab(c, tab, 0, null, '[{"method":"upi","amount_paise":15000}]', null, 100);
  perform pg_temp.eq('bill total after points', (v->>'total_paise')::bigint, 15000::bigint);
  perform pg_temp.eq('earned on what was paid', (v->>'points_earned')::int, 15);
  perform pg_temp.eq('points used', (v->>'points_used')::int, 100);
  perform pg_temp.eq('bill stores points', (select points_paise from bills where id = (v->>'bill_id')::uuid), 5000::bigint);
  perform pg_temp.eq('balance 300 - 100 + 15', pg_temp.bal(c, cu), 215);
  insert into t values ('bill2', v->>'bill_id');
  -- not enough points; no customer
  tab := pg_temp.game(c, t1, '9847100002', 300);
  perform pg_temp.expect_error(format('select close_tab(%L,%L,0,null,%L,null,400)', c, tab, '[]'), 'Not enough');
  perform pg_temp.reset();
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
  perform close_tab(c, tab, 0, null, '[]');
  perform pg_temp.reset();
end $$;

-- ── Void gives back used points and takes back earned; multipliers + happy hour; birthday; immutability; expiry
do $$
declare c uuid := (select t.v from t where t.k = 'c'); t1 uuid := (select t.v from t where t.k = 't1'); cu uuid := (select t.v from t where t.k = 'cu');
  snooker uuid := (select t.v from t where t.k = 'snooker'); v jsonb; b int; cu2 uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
  b := pg_temp.bal(c, cu);
  perform void_bill(c, (select t.v from t where t.k = 'bill2')::uuid, 'test');
  perform pg_temp.eq('void: +100 back, -15 earned', pg_temp.bal(c, cu), b + 85);
  perform void_bill(c, (select t.v from t where t.k = 'bill2')::uuid, 'test');   -- again: no change
  perform pg_temp.eq('second void changes nothing', pg_temp.bal(c, cu), b + 85);

  -- snooker ×2, happy hour ×1.5 all day: ₹200 → 60 points
  perform save_loyalty_settings(c, jsonb_build_object('multipliers', jsonb_build_object(snooker, 2),
    'happy_hours', '[{"label":"All day","days":[0,1,2,3,4,5,6],"start":"00:00","end":"00:00","multiplier":1.5}]'::jsonb));
  v := close_tab(c, pg_temp.game(c, t1, '9847100002'), 0, null, '[]');
  perform pg_temp.eq('×2 ×1.5 = 60', (v->>'points_earned')::int, 60);

  -- birthday today: +100 once
  update customers set date_of_birth = ((now() at time zone 'Asia/Kolkata')::date - interval '20 years')::date where id = cu;
  perform save_loyalty_settings(c, '{"multipliers":{},"happy_hours":[]}');
  v := close_tab(c, pg_temp.game(c, t1, '9847100002'), 0, null, '[]');
  perform pg_temp.eq('birthday bonus', (v->>'points_earned')::int, 120);
  v := close_tab(c, pg_temp.game(c, t1, '9847100002'), 0, null, '[]');
  perform pg_temp.eq('birthday only once', (v->>'points_earned')::int, 20);

  -- settings changes don't touch the past
  b := pg_temp.bal(c, cu);
  perform save_loyalty_settings(c, '{"earn_points_per_100":50,"point_value_paise":100}');
  perform pg_temp.eq('balance unchanged by new settings', pg_temp.bal(c, cu), b);
  perform pg_temp.reset();

  perform pg_temp.expect_error('update loyalty_ledger set points = 999', 'cannot be changed');
  perform pg_temp.expect_error('delete from loyalty_ledger', 'cannot be deleted');

  -- expiry, oldest used first: 100 earned (expired), 30 used → 70 expire, balance 0; a fresh 40 stays
  select id into cu2 from customers where centre_id = c and phone = '+919847100001';
  insert into loyalty_ledger(centre_id, customer_id, points, kind, note, expires_at, created_at)
    values (c, cu2, 100, 'adjust', 'old', now() - interval '1 day', now() - interval '13 months'),
           (c, cu2, -30, 'redeem', 'used', null, now() - interval '6 months'),
           (c, cu2, 40, 'adjust', 'new', now() + interval '6 months', now() - interval '1 month');
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
  perform pg_temp.eq('expired 70, kept 40', pg_temp.bal(c, cu2), 40);
  perform pg_temp.eq('expiry runs once', pg_temp.bal(c, cu2), 40);
  perform pg_temp.reset();
  perform pg_temp.eq('one expire row', (select count(*) from loyalty_ledger where customer_id = cu2 and kind = 'expire'), 1::bigint);
end $$;

select 'loyalty ok';

drop trigger zz_test_old_rules on public.centres;
drop function public._test_old_rules();
