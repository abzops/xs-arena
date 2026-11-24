-- XS Arena — recurring expenses + bill photo path tests.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000d1', 'owner.f@test.local', '{"display_name":"Owner F"}'),
  ('00000000-0000-0000-0000-0000000000d2', 'owner.g@test.local', '{"display_name":"Owner G"}');

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
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare c uuid; d uuid; rent uuid; v_today date := (now() at time zone 'Asia/Kolkata')::date; v_start date; n int; e uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
  c := create_centre('Expense Arena');
  v_start := date_trunc('month', v_today - interval '2 months')::date;

  -- rent on the 1st, started two months ago: posts this month and the two before
  rent := save_recurring_expense(c, jsonb_build_object('category', 'Rent', 'amount_paise', 3000000, 'day_of_month', 1, 'starts_on', v_start));
  perform pg_temp.eq('3 months of rent posted', (select count(*) from expenses where recurring_id = rent), 3::bigint);
  perform pg_temp.eq('one per month', (select count(distinct recurring_month) from expenses where recurring_id = rent), 3::bigint);
  perform pg_temp.eq('amount', (select sum(amount_paise) from expenses where recurring_id = rent), 9000000::numeric);
  perform pg_temp.eq('paid from bank by default', (select min(paid_from) from expenses where recurring_id = rent), 'bank');
  -- running again adds nothing
  perform pg_temp.eq('nothing new on re-run', post_due_recurring(c), 0);
  perform pg_temp.eq('still 3', (select count(*) from expenses where recurring_id = rent), 3::bigint);

  -- day 31 posts on the month's last day; a day still ahead this month isn't posted yet
  perform save_recurring_expense(c, jsonb_build_object('category', 'Salary', 'amount_paise', 1500000, 'day_of_month', 31, 'starts_on', v_start));
  if exists (select 1 from expenses where centre_id = c and category = 'Salary'
             and expense_date <> (date_trunc('month', expense_date) + interval '1 month - 1 day')::date) then
    raise exception 'Salary should land on the last day of each month';
  end if;
  if exists (select 1 from expenses where centre_id = c and expense_date > v_today) then raise exception 'Posted a future expense'; end if;

  -- pausing stops new months (nothing new is due anyway; check the flag sticks)
  perform save_recurring_expense(c, jsonb_build_object('id', rent, 'category', 'Rent', 'amount_paise', 3000000, 'active', false));
  perform pg_temp.eq('paused', (select active from recurring_expenses where id = rent), false);

  -- bill photo must sit in this centre's folder
  e := record_expense(c, 'Snacks stock', 50000, v_today, 'cash', 'drawer', 'Coke crate', c::text || '/bill1.jpg');
  perform pg_temp.eq('photo saved', (select photo_path from expenses where id = e), c::text || '/bill1.jpg');
  perform pg_temp.expect_error(format('select record_expense(%L,%L,100,null,%L,%L,null,%L)', c, 'Other', 'cash', 'drawer', gen_random_uuid()::text || '/x.jpg'), 'Invalid photo');
  perform pg_temp.expect_error(format('select save_recurring_expense(%L,%L)', c, '{"category":"Rent","amount_paise":0}'), 'amount');
  perform pg_temp.reset();

  -- another centre's owner can't see or post
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
  d := create_centre('Other Expense Arena');
  perform pg_temp.expect_error(format('select post_due_recurring(%L)', c), 'Not allowed');
  perform pg_temp.expect_error(format('select save_recurring_expense(%L,%L)', c, '{"category":"Rent","amount_paise":100}'), '');
  perform pg_temp.eq('rules hidden', (select count(*) from recurring_expenses where centre_id = c), 0::bigint);
  perform pg_temp.reset();
end $$;

select 'expenses ok';
