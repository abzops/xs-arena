-- XS Arena — web push: subscriptions, due alerts sent once per planned time, only to the centre's floor staff.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000ac', 'owner.push@test.local', '{"display_name":"Owner P"}'),
  ('00000000-0000-0000-0000-0000000000ad', 'owner.other@test.local', '{"display_name":"Other"}');

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
declare c uuid; d uuid; snooker uuid; fl uuid; t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000ac');
  c := create_centre('Push Arena');
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', t1, 'activity_id', snooker, 'name', 'Table 1'), jsonb_build_object('id', t2, 'activity_id', snooker, 'name', 'Table 2'))));
  perform save_push_subscription(c, 'https://push.example/abc', 'key1', 'auth1', 'test phone');
  perform save_push_subscription(c, 'https://push.example/abc', 'key2', 'auth2', 'test phone');   -- same phone again: updated, not doubled
  perform pg_temp.expect_error(format('select save_push_subscription(%L,%L,%L,%L)', c, 'http://bad', 'k', 'a'), 'Invalid');
  -- Table 1: 60 min game started 57 min ago → 3 min left; Table 2: 60 min started 61 min ago → time's up
  perform start_session(c, s1, t1, 1, 60, '9847099001', 'Anu', null, now() - interval '57 minutes');
  perform start_session(c, s2, t2, 1, 60, null, null, null, now() - interval '61 minutes');
  insert into t values ('c', c), ('s1', s1);
  perform pg_temp.reset();

  -- another centre's owner can't subscribe to this centre
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000ad');
  d := create_centre('Other Push');
  perform pg_temp.expect_error(format('select save_push_subscription(%L,%L,%L,%L)', c, 'https://push.example/x', 'k', 'a'), '');
  perform pg_temp.expect_error('select * from _due_push_alerts()', 'permission denied');
  perform pg_temp.reset();

  -- server: two alerts, each to the one phone
  perform pg_temp.eq('one subscription', (select count(*) from push_subscriptions where centre_id = c), 1::bigint);
  create temp table got as select * from _due_push_alerts();
  perform pg_temp.eq('2 alerts', (select count(*) from got), 2::bigint);
  perform pg_temp.eq('soon alert', (select title || ' / ' || body from got where kind = 'soon'), 'Table 1: 3 min left / Anu');
  perform pg_temp.eq('over alert', (select title from got where kind = 'over'), 'Table 2: time''s up');
  perform pg_temp.eq('latest keys', (select min(p256dh) from got), 'key2');
  -- second run: nothing new
  perform pg_temp.eq('sent once', (select count(*) from _due_push_alerts()), 0::bigint);
  -- extending Table 1 makes a new planned time → its alert can come again later, but not now (not due)
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000ac');
  perform extend_session(c, s1, 30);
  perform pg_temp.reset();
  perform pg_temp.eq('not due after extend', (select count(*) from _due_push_alerts()), 0::bigint);
  -- dead phone removed
  perform _drop_push_endpoint('https://push.example/abc');
  perform pg_temp.eq('dropped', (select count(*) from push_subscriptions where centre_id = c), 0::bigint);
end $$;

-- VAPID keys: signed-in staff read the public key only; the private key is hidden from everyone but the service role
insert into push_vapid(public_key, private_key) values ('PUBKEY', 'SECRET');
do $$ begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000ac');
  perform pg_temp.eq('public key', push_public_key(), 'PUBKEY');
  perform pg_temp.expect_error('select private_key from push_vapid', 'permission denied');
  perform pg_temp.reset();
  perform pg_temp.as_user(null);
  perform pg_temp.eq('no key when signed out', push_public_key(), null::text);
  perform pg_temp.reset();
end $$;

select 'web push ok';
