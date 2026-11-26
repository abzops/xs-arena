-- XS Arena — foundation DB tests. Run after the migrations (see scripts/db-test.sh).
-- Fails loudly (raise exception) on the first broken rule.
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
  ('00000000-0000-0000-0000-00000000000a', 'owner.a@test.local', '{"display_name":"Owner A"}'),
  ('00000000-0000-0000-0000-00000000000b', 'owner.b@test.local', '{"display_name":"Owner B"}'),
  ('00000000-0000-0000-0000-00000000000c', 'desk.a@test.local', '{}'),
  ('00000000-0000-0000-0000-00000000000d', 'manager.a@test.local', '{}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false);
  execute 'set role authenticated';
end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm not ilike '%' || p_like || '%' then raise exception 'Expected error like "%" but got "%"', p_like, sqlerrm; end if;
    return;
  end;
  raise exception 'Expected an error like "%" for: %', p_like, p_sql;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare a uuid; b uuid; n int; v_cust uuid; v_desk uuid;
begin
  -- Owner A and Owner B each create a centre
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  a := create_centre('Arena One', '9876543210', 'Kochi');
  perform pg_temp.reset();
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  b := create_centre('Arena Two', null, null);
  perform pg_temp.reset();

  if (select plan from centre_subscriptions where centre_id = a) <> 'pro' then raise exception 'New centres should start on the Pro trial'; end if;
  if (select count(*) from products where centre_id = a) <> 4 then raise exception 'Starter snack menu missing'; end if;
  if (select display_name from centre_staff where centre_id = a and role = 'owner') <> 'Owner A' then raise exception 'Owner display name not taken from sign-up'; end if;

  -- Isolation: A cannot see B
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  select count(*) into n from centres; if n <> 1 then raise exception 'Owner A sees % centres (expected 1)', n; end if;
  select count(*) into n from products where centre_id = b; if n <> 0 then raise exception 'Owner A can read centre B products'; end if;
  perform pg_temp.expect_error(format('select save_customer(%L, null, %L, %L)', b, 'Intruder', '9000000001'), 'permission');
  perform pg_temp.expect_error(format('select dashboard_summary(%L)', b), 'Not allowed');

  -- Customers: phone normalised, unique per centre
  v_cust := save_customer(a, null, 'Rahul', '98470 12345');
  if (select phone from customers where id = v_cust) <> '+919847012345' then raise exception 'Phone not normalised'; end if;
  perform pg_temp.expect_error(format('select save_customer(%L, null, %L, %L)', a, 'Rahul again', '+91 9847012345'), 'already exists');

  -- Team: add front desk + manager by email
  v_desk := save_staff(a, null, 'Desk', 'front_desk', null, null, 'desk.a@test.local');
  perform save_staff(a, null, 'Manager', 'manager', null, null, 'manager.a@test.local');
  perform pg_temp.expect_error(format('select save_staff(%L, null, %L, %L)', a, 'Stylist', 'stylist'), 'Invalid role');

  -- Expenses
  perform record_expense(a, 'Electricity', 450000, null, 'upi', 'bank', 'KSEB bill');
  if (dashboard_summary(a)->>'expenses_month')::bigint <> 450000 then raise exception 'Expense not in dashboard'; end if;
  perform pg_temp.reset();

  -- Front desk: linked by email, can add customers, cannot manage team, expenses or settings
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
  if (select count(*) from my_centres()) <> 1 then raise exception 'Front desk not linked to centre'; end if;
  perform save_customer(a, null, 'Walk-in Arun', '9847000001');
  perform pg_temp.expect_error(format('select save_staff(%L, null, %L, %L)', a, 'Sneaky', 'owner'), 'permission');
  perform pg_temp.expect_error(format('select record_expense(%L, %L, 100, null, %L)', a, 'Snacks', 'cash'), 'permission');
  update centres set name = 'Hacked' where id = a;
  if (select name from centres where id = a) = 'Hacked' then raise exception 'Front desk changed centre settings'; end if;
  select count(*) into n from expenses; if n <> 0 then raise exception 'Front desk can read expenses'; end if;
  perform pg_temp.reset();

  -- Manager: expenses yes, team/settings no
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
  perform record_expense(a, 'Snacks stock', 120000, null, 'cash');
  perform pg_temp.expect_error(format('select save_staff(%L, null, %L, %L)', a, 'X', 'front_desk'), 'permission');
  if has_perm(a, 'floor.design') then raise exception 'Manager must not design the floor'; end if;
  perform pg_temp.reset();

  -- Plan gating: Starter allows 2 logins, has no loyalty
  update centre_subscriptions set plan = 'starter' where centre_id = a;
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  if has_feature(a, 'loyalty') then raise exception 'Starter should not include loyalty'; end if;
  if not has_feature(a, 'floor') then raise exception 'Starter should include the floor'; end if;
  perform pg_temp.expect_error(format('select save_staff(%L, null, %L, %L)', a, 'Third', 'front_desk'), 'plan allows');
  perform pg_temp.reset();
  update centre_subscriptions set plan = 'pro' where centre_id = a;

  -- Last owner cannot be demoted
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  perform pg_temp.expect_error(format('select save_staff(%L, %L, %L, %L)', a,
    (select id from centre_staff where centre_id = a and role = 'owner'), 'Owner A', 'manager'), 'at least one active owner');
  perform pg_temp.reset();

  -- UPI ID format
  update centres set upi_id = 'arena.one@okicici' where id = a;
  perform pg_temp.expect_error(format('update centres set upi_id = %L where id = %L', 'not a upi', a), 'check constraint');

  -- Anonymous: nothing
  execute 'set role anon';
  perform pg_temp.expect_error('select * from centres', 'permission denied');
  perform pg_temp.reset();

  raise notice 'All foundation tests passed';
end $$;

drop trigger zz_test_old_rules on public.centres;
drop function public._test_old_rules();
