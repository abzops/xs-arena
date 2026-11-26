-- XS Arena — loyalty rewards + tiers tests.
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
  ('00000000-0000-0000-0000-0000000000a7', 'owner.r@test.local', '{"display_name":"Owner R"}');

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
create or replace function pg_temp.game(c uuid, r uuid, p_phone text) returns uuid language plpgsql as $$
declare s uuid := gen_random_uuid(); v jsonb;
begin
  v := start_session(c, s, r, 1, null, p_phone, 'Guest', null, now() - interval '60 minutes');
  perform end_session(c, s, now());
  return (v->>'tab_id')::uuid;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare c uuid; snooker uuid; fl uuid; t1 uuid := gen_random_uuid(); v jsonb; cu uuid; p jsonb; free30 text; big text; b3 uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
  c := create_centre('Rewards Arena');
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(jsonb_build_object('id', t1, 'activity_id', snooker, 'name', 'Table 1'))));

  -- bad rewards / tiers are refused
  perform pg_temp.expect_error(format('select save_loyalty_settings(%L,%L)', c, '{"rewards":[{"name":"x","points":0,"value_paise":100}]}'), 'needs points');
  perform pg_temp.expect_error(format('select save_loyalty_settings(%L,%L)', c, '{"tiers":[{"name":"Gold","min_points":10,"multiplier":9}]}'), 'between 1');
  perform save_loyalty_settings(c, '{
    "rewards":[{"name":"30 min snooker free","points":100,"value_paise":10000},{"name":"Party room","points":150,"value_paise":50000}],
    "tiers":[{"name":"Gold","min_points":100,"multiplier":3},{"name":"Silver","min_points":30,"multiplier":2}]}');
  select r->>'id' into free30 from jsonb_array_elements((loyalty_settings_get(c))->'rewards') r where r->>'name' = '30 min snooker free';
  select r->>'id' into big from jsonb_array_elements((loyalty_settings_get(c))->'rewards') r where r->>'name' = 'Party room';
  if free30 is null then raise exception 'reward ids are generated'; end if;
  perform pg_temp.eq('tiers sorted by points', (loyalty_settings_get(c))->'tiers'->0->>'name', 'Silver');

  -- ₹200 game: 20 + 50 welcome; lifetime 20 (bonuses don't count), no tier yet
  v := close_tab(c, pg_temp.game(c, t1, '9847200001'), 0, null, '[]');
  perform pg_temp.eq('first bill', (v->>'points_earned')::int, 70);
  select id into cu from customers where centre_id = c and phone = '+919847200001';
  p := customer_points(c, cu);
  perform pg_temp.eq('lifetime 20', (p->>'lifetime')::int, 20);
  perform pg_temp.eq('no tier yet', coalesce(p->>'tier', 'none'), 'none');
  perform pg_temp.eq('next tier Silver', p->'next_tier'->>'name', 'Silver');
  perform pg_temp.eq('reward not yet affordable', (p->'rewards'->0->>'affordable')::boolean, false);
  -- second bill: still below Silver at the time → 20; lifetime 40 → Silver
  perform pg_temp.eq('second bill', (close_tab(c, pg_temp.game(c, t1, '9847200001'), 0, null, '[]')->>'points_earned')::int, 20);
  perform pg_temp.eq('Silver reached', customer_points(c, cu)->'tier'->>'name', 'Silver');
  -- third bill: Silver earns 2× → 40
  perform pg_temp.eq('Silver earns 2x', (close_tab(c, pg_temp.game(c, t1, '9847200001'), 0, null, '[]')->>'points_earned')::int, 40);
  perform pg_temp.eq('balance 130', (customer_points(c, cu)->>'balance')::int, 130);

  -- reward: 100 points = ₹100 off a ₹200 bill (no 50% cap check needed here; reward value is fixed)
  v := close_tab(c, pg_temp.game(c, t1, '9847200001'), 0, null, '[{"method":"cash","amount_paise":10000}]', null, 0, free30);
  perform pg_temp.eq('reward total', (v->>'total_paise')::bigint, 10000::bigint);
  perform pg_temp.eq('reward name', v->>'reward', '30 min snooker free');
  perform pg_temp.eq('reward points used', (v->>'points_used')::int, 100);
  -- earned on the ₹100 paid: 10 × Silver 2 = 20; lifetime 80
  perform pg_temp.eq('earn after reward', (v->>'points_earned')::int, 20);
  perform pg_temp.eq('balance 130 - 100 + 20', (customer_points(c, cu)->>'balance')::int, 50);
  b3 := (v->>'bill_id')::uuid;

  -- not enough points; unknown reward
  perform pg_temp.expect_error(format('select close_tab(%L,%L,0,null,%L,null,0,%L)', c, pg_temp.game(c, t1, '9847200001'), '[]', big), 'Not enough');
  perform pg_temp.expect_error(format('select close_tab(%L,%L,0,null,%L,null,0,%L)', c, (select id from tabs where centre_id = c and status = 'open' limit 1), '[]', 'nope'), 'no longer offered');

  -- a reward worth more than the bill only takes the bill amount
  perform adjust_points(c, cu, 200, 'test');
  v := close_tab(c, (select id from tabs where centre_id = c and status = 'open' limit 1), 0, null, '[]', null, 0, big);
  perform pg_temp.eq('capped at the bill', (v->>'total_paise')::bigint, 0::bigint);
  perform pg_temp.eq('bill points value = bill', (select points_paise from bills where id = (v->>'bill_id')::uuid), 20000::bigint);

  -- voiding the reward bill gives back 100, takes back 20; lifetime drops by 20
  perform pg_temp.eq('lifetime before void (20+20+40+20)', (customer_points(c, cu)->>'lifetime')::int, 100);
  perform void_bill(c, b3, 'test');
  perform pg_temp.eq('lifetime after void drops by that bill''s 20', (customer_points(c, cu)->>'lifetime')::int, 80);
  perform pg_temp.reset();
end $$;

select 'loyalty rewards ok';

drop trigger zz_test_old_rules on public.centres;
drop function public._test_old_rules();
