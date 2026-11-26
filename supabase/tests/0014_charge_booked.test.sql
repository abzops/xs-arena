-- XS Arena — staff choose per bill: time played (default) or the full booked time. The closed bill uses the choice.
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
  ('00000000-0000-0000-0000-0000000000b5', 'owner.booked@test.local', '{"display_name":"Owner K"}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create or replace function pg_temp.price(s uuid) returns jsonb language plpgsql volatile as $$ begin return price_session(s); end $$;
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
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare c uuid; pool uuid; fl uuid; t1 uuid := gen_random_uuid(); s uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); v jsonb; tab uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b5');
  c := create_centre('Booked Arena');
  select id into pool from activities where centre_id = c and name = 'Pool';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(jsonb_build_object('id', t1, 'activity_id', pool, 'name', 'Pool 1'))));
  perform save_rate_card(c, pool, '{"billing_mode":"per_minute","price_paise":15000,"min_minutes":30,"grace_minutes":5}');

  -- booked 1h 15m, left after 9 minutes
  v := start_session(c, s, t1, 1, 75, null, null, null, now() - interval '9 minutes');
  tab := (v->>'tab_id')::uuid;
  perform end_session(c, s, now());
  perform pg_temp.eq('default: time played (minimum 30 min)', (pg_temp.price(s)->>'amount_paise')::bigint, 7500::bigint);

  -- staff choose the booked time: 75 min at ₹150/hr = ₹187.50 → ₹188, one line
  v := set_charge_booked(c, s, true);
  perform pg_temp.eq('booked time', (v->>'amount_paise')::bigint, 18800::bigint);
  perform pg_temp.eq('one line', jsonb_array_length(v->'lines'), 1);
  perform pg_temp.eq('label', v->'lines'->0->>'label', 'Booked 1h 15m @ ₹150/hr');
  perform pg_temp.eq('flag shown', (v->>'charge_booked')::boolean, true);
  -- and back
  perform pg_temp.eq('switch back', (set_charge_booked(c, s, false)->>'amount_paise')::bigint, 7500::bigint);
  perform set_charge_booked(c, s, true);

  -- the closed bill uses the choice
  perform close_tab(c, tab, 0, null, jsonb_build_array(jsonb_build_object('method','cash','amount_paise',18800)), gen_random_uuid(), null, null);
  perform pg_temp.eq('bill total', (select total_paise from bills where tab_id = tab), 18800::bigint);
  perform pg_temp.expect_error(format('select set_charge_booked(%L, %L, false)', c, s), 'already billed');

  -- open timer: nothing to choose
  perform start_session(c, s2, t1, 1, null, null, null, null, now() - interval '5 minutes');
  perform pg_temp.expect_error(format('select set_charge_booked(%L, %L, true)', c, s2), 'no booked time');
  perform pg_temp.reset();
end $$;

select 'charge booked ok';

drop trigger zz_test_old_rules on public.centres;
drop function public._test_old_rules();
