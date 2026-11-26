-- XS Arena — cancel keeps snacks on the bill; move renames the bill; public receipt token works and hides nothing extra.
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
  ('00000000-0000-0000-0000-0000000000b4', 'owner.desk@test.local', '{"display_name":"Owner D"}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create or replace function pg_temp.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin if got is distinct from want then raise exception '%: expected % but got %', label, want, got; end if; end $$;
grant execute on all functions in schema pg_temp to authenticated;
create temp table t(k text primary key, val text);
grant all on t to authenticated;

do $$
declare c uuid; pool uuid; fl uuid; t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); s uuid := gen_random_uuid(); v jsonb; tab uuid; soda uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b4');
  c := create_centre('Desk Arena');
  select id into pool from activities where centre_id = c and name = 'Pool';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', t1, 'activity_id', pool, 'name', 'Pool 1'), jsonb_build_object('id', t2, 'activity_id', pool, 'name', 'Pool 2'))));
  select id into soda from products where centre_id = c and name = 'Soft drink';

  -- move renames the open bill
  v := start_session(c, s, t1, 2, 60, '9847055555', 'Rahul', null, now() - interval '10 minutes');
  tab := (v->>'tab_id')::uuid;
  perform pg_temp.eq('bill named after table', (select label from tabs where id = tab), 'Pool 1');
  perform transfer_session(c, s, t2);
  perform pg_temp.eq('bill follows the game', (select label from tabs where id = tab), 'Pool 2');

  -- cancel with snacks on it: game gone, bill stays open with the snacks
  perform tab_add_item(c, tab, soda, 2);
  perform void_session(c, s, 'started by mistake');
  perform pg_temp.eq('bill still open', (select status from tabs where id = tab), 'open');
  perform pg_temp.eq('snacks kept', (select count(*) from tab_items where tab_id = tab and status = 'ok'), 1::bigint);

  -- cancel with nothing else on it: bill closes as before
  s := gen_random_uuid();
  v := start_session(c, s, t1, 1, null, null, null, null, now() - interval '2 minutes');
  perform void_session(c, s, 'mistake');
  perform pg_temp.eq('empty bill voided', (select status from tabs where id = (v->>'tab_id')::uuid), 'void');

  -- close the snack bill and read its public receipt
  perform close_tab(c, tab, 0, null, jsonb_build_array(jsonb_build_object('method','cash','amount_paise', (tab_preview(c, tab)->>'subtotal_paise')::bigint)), gen_random_uuid(), null, null);
  insert into t select 'token', share_token from bills where tab_id = tab;
  perform pg_temp.eq('token long', length((select val from t where k = 'token')) >= 64, true);
  perform pg_temp.reset();

  v := _receipt_by_token((select val from t where k = 'token'));
  perform pg_temp.eq('receipt centre', v->'centre'->>'name', 'Desk Arena');
  perform pg_temp.eq('first name only', v->>'customer', 'Rahul');
  perform pg_temp.eq('no phone of customer', v ? 'phone', false);
  perform pg_temp.eq('bad token', _receipt_by_token('nope'), null::jsonb);
  perform pg_temp.eq('short token refused', _receipt_by_token(''), null::jsonb);

  -- signed-in users can't call it directly (only the Edge Function can)
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b4');
  begin
    perform _receipt_by_token((select val from t where k = 'token'));
    raise exception 'authenticated should not call _receipt_by_token';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.reset();
end $$;

select 'desk fixes ok';

drop trigger zz_test_old_rules on public.centres;
drop function public._test_old_rules();
