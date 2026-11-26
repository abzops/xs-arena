-- XS Arena — day summary + leakage alerts tests.
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
  ('00000000-0000-0000-0000-0000000000aa', 'owner.ds@test.local', '{"display_name":"Owner DS"}'),
  ('00000000-0000-0000-0000-0000000000ab', 'desk.ds@test.local', '{}');

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
create or replace function pg_temp.game(c uuid, r uuid, p_mins int, p_end boolean default true) returns uuid language plpgsql as $$
declare s uuid := gen_random_uuid(); v jsonb;
begin
  v := start_session(c, s, r, 1, null, null, null, null, now() - make_interval(mins => p_mins));
  if p_end then perform end_session(c, s, now()); end if;
  return (v->>'tab_id')::uuid;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare c uuid; snooker uuid; fl uuid; t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); v jsonb; b uuid; a jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000aa');
  c := create_centre('Summary Arena');
  perform pg_temp.reset(); update centres set timezone = 'UTC' where id = c;   -- keep "today" simple for the test
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000aa');
  perform save_staff(c, null, 'Desk DS', 'front_desk', null, null, 'desk.ds@test.local');
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', t1, 'activity_id', snooker, 'name', 'Table 1'), jsonb_build_object('id', t2, 'activity_id', snooker, 'name', 'Table 2'))));

  -- ₹200 bill paid in cash; ₹200 bill with ₹60 discount paid by UPI; a ₹200 bill voided
  perform close_tab(c, pg_temp.game(c, t1, 60), 0, null, '[{"method":"cash","amount_paise":20000}]');
  perform close_tab(c, pg_temp.game(c, t1, 60), 6000, 'friend', '[{"method":"upi","amount_paise":14000}]');
  b := (close_tab(c, pg_temp.game(c, t1, 60), 0, null, '[]')->>'bill_id')::uuid;
  perform void_bill(c, b, 'wrong table');
  perform record_expense(c, 'Electricity', 5000, (now() at time zone 'UTC')::date, 'cash', 'drawer');
  -- a game still running after 7 hours
  perform pg_temp.game(c, t2, 7 * 60, false);
  -- shift short by ₹150
  perform open_shift(c, 100000);
  perform close_shift(c, (current_shift(c)->>'expected_cash_paise')::bigint - 15000, 'counted twice');

  v := day_summary(c);
  perform pg_temp.eq('revenue = 200 + 140', (v->>'revenue_paise')::bigint, 34000::bigint);
  perform pg_temp.eq('expenses', (v->>'expenses_paise')::bigint, 5000::bigint);
  perform pg_temp.eq('net', (v->>'net_paise')::bigint, 29000::bigint);
  perform pg_temp.eq('2 bills (void excluded)', (v->>'bills')::int, 2);
  perform pg_temp.eq('by game', v->'by_game'->0->>'name', 'Snooker');
  perform pg_temp.eq('cash', (v->'by_method'->>'cash')::bigint, 20000::bigint);
  perform pg_temp.eq('upi', (v->'by_method'->>'upi')::bigint, 14000::bigint);
  a := v->'alerts';
  if not exists (select 1 from jsonb_array_elements(a) x where x->>'kind' = 'void_bill' and x->>'text' like '%wrong table%' and x->>'text' like '%Owner DS%') then
    raise exception 'void alert missing: %', a; end if;
  if not exists (select 1 from jsonb_array_elements(a) x where x->>'kind' = 'discounts' and x->>'text' like '%15%%') then
    raise exception 'discount alert missing (60 of 400 = 15%%): %', a; end if;
  if not exists (select 1 from jsonb_array_elements(a) x where x->>'kind' = 'long_game' and x->>'text' like 'Table 2%') then
    raise exception 'long game alert missing: %', a; end if;
  if not exists (select 1 from jsonb_array_elements(a) x where x->>'kind' = 'cash_difference' and x->>'text' like 'Cash short by ₹150%' and x->>'level' = 'bad') then
    raise exception 'cash alert missing: %', a; end if;
  perform pg_temp.reset();

  -- front desk can't see the money summary
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000ab');
  perform claim_invites();
  perform pg_temp.expect_error(format('select day_summary(%L)', c), '');
  perform pg_temp.reset();
end $$;

select 'day summary ok';

drop trigger zz_test_old_rules on public.centres;
drop function public._test_old_rules();
