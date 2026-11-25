-- XS Arena — staff logins made by the owner (username + password, no email).
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- Supabase keeps server-only metadata here; the local stand-in for auth.users doesn't have it.
alter table auth.users add column if not exists raw_app_meta_data jsonb default '{}';

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000005f1', 'owner.logins@test.local', '{"display_name":"Owner L"}'),
  ('00000000-0000-0000-0000-0000000005f2', 'other.owner@test.local', '{"display_name":"Owner M"}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
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
declare c uuid; c2 uuid; ravi uuid; ravi2 uuid; boss uuid; v jsonb; acct uuid := gen_random_uuid(); acct2 uuid := gen_random_uuid(); wrong uuid := gen_random_uuid();
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000005f2');
  c2 := create_centre('Other Arena');

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000005f1');
  c := create_centre('Cue Club Kochi');
  ravi := save_staff(c, null, 'Ravi Kumar', 'front_desk', null, '9847011111');
  ravi2 := save_staff(c, null, 'Ravi', 'manager');
  boss := save_staff(c, null, 'Second Owner', 'owner');

  -- 1. a free username from first name + centre slug
  v := prepare_staff_login(c, ravi);
  perform pg_temp.eq('username', v->>'username', 'ravi.cue');
  perform pg_temp.eq('internal email', v->>'email', 'ravi.cue@staff.xelorsoft.com');
  perform pg_temp.eq('role carried', v->>'role', 'front_desk');

  -- 2. the server makes the account (stand-in for the Edge Function)
  perform pg_temp.reset();
  insert into auth.users(id, email, raw_app_meta_data) values
    (acct, 'ravi.cue@staff.xelorsoft.com', jsonb_build_object('xs_staff_centre', c, 'xs_staff_row', ravi)),
    (wrong, 'ravi.cue2@staff.xelorsoft.com', jsonb_build_object('xs_staff_centre', c2, 'xs_staff_row', ravi2));
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000005f1');

  -- an account made for another centre cannot be attached
  perform pg_temp.expect_error(format('select attach_staff_login(%L, %L, %L, %L)', c, ravi2, wrong, 'ravi.cue2'), 'not made for this centre');
  -- nor with a different username than the account's
  perform pg_temp.expect_error(format('select attach_staff_login(%L, %L, %L, %L)', c, ravi, acct, 'someone.else'), 'not made for this centre');

  -- 3. link it
  v := attach_staff_login(c, ravi, acct, 'ravi.cue');
  perform pg_temp.eq('linked username', v->>'username', 'ravi.cue');
  perform pg_temp.eq('user linked', (select user_id from centre_staff where id = ravi), acct);
  perform pg_temp.eq('audited', (select count(*) from audit_logs where centre_id = c and action = 'staff.login_created')::int, 1);
  perform pg_temp.expect_error(format('select prepare_staff_login(%L, %L)', c, ravi), 'already has a login');

  -- next Ravi gets ravi.cue3 (ravi.cue2 is taken in auth.users)
  perform pg_temp.eq('next free username', prepare_staff_login(c, ravi2)->>'username', 'ravi.cue3');

  -- owners and inactive members get no generated login
  perform pg_temp.expect_error(format('select prepare_staff_login(%L, %L)', c, boss), 'managers and front desk');
  perform save_staff(c, ravi2, 'Ravi', 'manager', null, null, null, '#8b8b93', 'inactive');
  perform pg_temp.expect_error(format('select prepare_staff_login(%L, %L)', c, ravi2), 'Reactivate');

  -- the new staff member is in: member of the centre, front-desk rights only
  perform pg_temp.as_user(acct);
  perform pg_temp.eq('staff is member', is_centre_member(c), true);
  perform pg_temp.eq('front desk can run the floor', has_perm(c, 'floor.operate'), true);
  perform pg_temp.eq('front desk cannot manage staff', has_perm(c, 'staff.manage'), false);
  perform pg_temp.expect_error(format('select prepare_staff_login(%L, %L)', c, ravi2), '');
  perform pg_temp.expect_error(format('select prepare_staff_password_reset(%L, %L)', c, ravi), '');

  -- password reset: only by the owner, only for generated logins
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000005f1');
  v := prepare_staff_password_reset(c, ravi);
  perform pg_temp.eq('reset target', (v->>'user_id')::uuid, acct);
  perform pg_temp.expect_error(format('select prepare_staff_password_reset(%L, %L)', c, boss), 'owner');
  perform pg_temp.expect_error(format('select prepare_staff_password_reset(%L, %L)', c, ravi2), 'own email');

  -- another centre's owner cannot touch this team
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000005f2');
  perform pg_temp.expect_error(format('select prepare_staff_login(%L, %L)', c, ravi2), '');
  perform pg_temp.expect_error(format('select prepare_staff_password_reset(%L, %L)', c, ravi), '');

  -- deactivating the member removes access straight away
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000005f1');
  perform save_staff(c, ravi, 'Ravi Kumar', 'front_desk', null, '9847011111', null, '#8b8b93', 'inactive');
  perform pg_temp.as_user(acct);
  perform pg_temp.eq('inactive staff is out', is_centre_member(c), false);
  perform pg_temp.reset();
end $$;

-- anon can call none of it
set role anon;
do $$ begin
  perform pg_temp.expect_error('select prepare_staff_login(gen_random_uuid(), gen_random_uuid())', 'permission denied');
end $$;
reset role;
select 'staff logins ok';
