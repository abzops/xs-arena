-- XS Arena — RC fleet tests: items, charge cycles, damage → repair → expense, deposits, permissions, history immutable.
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
  ('00000000-0000-0000-0000-0000000000a8', 'owner.rc@test.local', '{"display_name":"Owner RC"}'),
  ('00000000-0000-0000-0000-0000000000a9', 'desk.rc@test.local', '{}');

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
create temp table t(k text primary key, v text);
grant all on t to authenticated;

do $$
declare c uuid; car uuid; bat uuid; v jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a8');
  c := create_centre('RC Arena');
  perform save_staff(c, null, 'Desk RC', 'front_desk', null, null, 'desk.rc@test.local');
  car := save_rc_item(c, jsonb_build_object('kind', 'car', 'name', 'Car 1', 'deposit_paise', 50000,
    'activity_id', (select id from activities where centre_id = c and name = 'RC Drift')));
  bat := save_rc_item(c, '{"kind":"battery","name":"Battery A"}');
  perform pg_temp.expect_error(format('select save_rc_item(%L,%L)', c, '{"kind":"car","name":"Car 1"}'), 'already an item');
  insert into t values ('c', c), ('car', car), ('bat', bat);
  perform pg_temp.reset();

  -- front desk: charge twice, report damage, can't repair with a cost (needs expenses permission), can't add items
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a9');
  perform claim_invites();
  perform rc_log(c, bat, 'status', null, 0, 'charging');
  perform pg_temp.eq('charging', (select status from rc_items where id = bat), 'charging');
  perform rc_log(c, bat, 'charge'); perform rc_log(c, bat, 'charge');
  perform pg_temp.eq('2 cycles', (select charge_cycles from rc_items where id = bat), 2);
  perform pg_temp.eq('ready after charge', (select status from rc_items where id = bat), 'ready');
  perform pg_temp.expect_error(format('select rc_log(%L,%L,%L)', c, car, 'damage'), 'what is damaged');
  perform rc_log(c, car, 'damage', 'Front wheel broken', 0, null, c::text || '/wheel.jpg');
  perform pg_temp.eq('in repair', (select status from rc_items where id = car), 'repair');
  perform pg_temp.expect_error(format('select rc_log(%L,%L,%L,%L,%s)', c, car, 'repair', 'new wheel', 30000), '');
  perform pg_temp.expect_error(format('select save_rc_item(%L,%L)', c, '{"name":"Car 9"}'), '');
  perform rc_log(c, car, 'deposit_in', 'Rahul', 50000);
  perform pg_temp.reset();

  -- owner: repair with cost → RC repairs expense, back to ready; deposit returned
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a8');
  v := rc_log(c, car, 'repair', 'New wheel', 30000, null, null, 'drawer');
  perform pg_temp.eq('ready after repair', (select status from rc_items where id = car), 'ready');
  perform pg_temp.eq('expense recorded', (select category || ' ' || amount_paise || ' ' || paid_from from expenses where id = (v->>'expense_id')::uuid), 'RC repairs 30000 drawer');
  v := rc_fleet(c);
  perform pg_temp.eq('deposit held', (select (x->>'deposit_held_paise')::bigint from jsonb_array_elements(v->'items') x where x->>'name' = 'Car 1'), 50000::bigint);
  perform rc_log(c, car, 'deposit_out', 'Rahul', 50000);
  perform pg_temp.eq('deposit returned', (select (x->>'deposit_held_paise')::bigint from jsonb_array_elements(rc_fleet(c)->'items') x where x->>'name' = 'Car 1'), 0::bigint);
  perform pg_temp.eq('repairs total', (select (x->>'repairs_paise')::bigint from jsonb_array_elements(rc_fleet(c)->'items') x where x->>'name' = 'Car 1'), 30000::bigint);
  -- retire: no more logs
  perform save_rc_item(c, jsonb_build_object('id', bat, 'name', 'Battery A', 'status', 'retired'));
  perform pg_temp.expect_error(format('select rc_log(%L,%L,%L)', c, bat, 'charge'), 'retired');
  perform pg_temp.reset();

  perform pg_temp.expect_error('update rc_logs set note = ''x''', 'cannot be changed');
  perform pg_temp.expect_error('delete from rc_logs', 'cannot be deleted');
end $$;

select 'rc fleet ok';

drop trigger zz_test_old_rules on public.centres;
drop function public._test_old_rules();
