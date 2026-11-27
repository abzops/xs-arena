-- XS Arena — centre profile (logo, cover, about, links), own UPI QR, staff photos.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000711', 'owner.cp@test.local', '{"display_name":"Owner CP"}'),
  ('00000000-0000-0000-0000-000000000712', 'desk.cp@test.local', '{"display_name":"Desk CP"}'),
  ('00000000-0000-0000-0000-000000000713', 'other.cp@test.local', '{"display_name":"Other CP"}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'set role anon'; end $$;
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
grant execute on all functions in schema pg_temp to authenticated, anon;
create temp table t(k text primary key, v text);
grant all on t to authenticated, anon;

-- ── Owner sets the profile and UPI ──
do $$
declare c uuid; s text; snooker uuid; fl uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000711');
  c := create_centre('Profile Arena');
  insert into t values ('c', c::text);
  select slug into s from centres where id = c;
  insert into t values ('slug', s);
  perform pg_temp.eq('new centre: exact-amount UPI by default', (select upi_mode from centres where id = c), 'amount');
  update centres set logo_path = c || '/logo-1.webp', cover_path = c || '/cover-1.webp', about = 'Snooker and PS5 in Kakkanad',
    maps_url = 'https://maps.app.goo.gl/abc', instagram = 'profile.arena', upi_id = 'profile@okaxis', upi_payee = 'PROFILE ARENA'
  where id = c;
  perform pg_temp.eq('profile saved', (select instagram from centres where id = c), 'profile.arena');
  -- pictures must sit in this centre's folder
  perform pg_temp.expect_error(format('update centres set logo_path = %L where id = %L', gen_random_uuid() || '/x.png', c), 'centres_media_paths');
  -- own-QR mode needs an uploaded QR
  perform pg_temp.expect_error(format('update centres set upi_mode = %L where id = %L', 'own', c), 'centres_upi_own_needs_qr');
  update centres set upi_qr_path = c || '/upi-1.png', upi_mode = 'own' where id = c;
  perform pg_temp.eq('own QR mode on', (select upi_mode from centres where id = c), 'own');
  perform pg_temp.expect_error(format('update centres set maps_url = %L where id = %L', 'javascript:alert(1)', c), 'maps_url');
  perform pg_temp.expect_error(format('update centres set instagram = %L where id = %L', '@bad name!', c), 'instagram');
  -- booking page + ticket show the profile
  update centres set open_time = '00:00', close_time = '00:00' where id = c;
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid(), 'activity_id', snooker, 'name', 'Table 1'),
    jsonb_build_object('id', gen_random_uuid(), 'activity_id', snooker, 'name', 'Table 2'))));
  perform save_booking_settings(c, jsonb_build_object('enabled', true, 'activities',
    jsonb_build_array(jsonb_build_object('id', snooker, 'walkin_reserve', 0))));
end $$;

-- A front-desk member can't change the profile
do $$
declare c uuid := (select v::uuid from t where k = 'c');
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000711');
  perform save_staff(c, null, 'Desk CP', 'front_desk', null, null, 'desk.cp@test.local');
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000712');
  update centres set about = 'hacked' where id = c;
  perform pg_temp.reset();
  perform pg_temp.eq('desk cannot edit profile', (select about from centres where id = c), 'Snooker and PS5 in Kakkanad');
end $$;

-- ── Signed-out booking page ──
do $$
declare s text := (select v from t where k = 'slug'); c uuid := (select v::uuid from t where k = 'c'); v jsonb;
begin
  perform pg_temp.as_anon();
  v := booking_page(s);
  perform pg_temp.eq('booking page: logo', v->'centre'->>'logo_path', c || '/logo-1.webp');
  perform pg_temp.eq('booking page: cover', v->'centre'->>'cover_path', c || '/cover-1.webp');
  perform pg_temp.eq('booking page: about', v->'centre'->>'about', 'Snooker and PS5 in Kakkanad');
  perform pg_temp.eq('booking page: instagram', v->'centre'->>'instagram', 'profile.arena');
  perform pg_temp.eq('booking page still has activities', jsonb_array_length(v->'activities') > 0, true);
  perform pg_temp.eq('booking page: name kept', v->'centre'->>'name', 'Profile Arena');
  v := booking_page(upper(s));
  perform pg_temp.eq('booking page: any-case slug', v->'centre'->>'logo_path', c || '/logo-1.webp');
  perform pg_temp.expect_error('select _booking_page_base(''x'')', 'permission denied');
  perform pg_temp.expect_error('select _booking_ticket_base(''x'')', 'permission denied');
  perform pg_temp.reset();
end $$;

-- ── Ticket shows logo + own QR ──
do $$
declare c uuid := (select v::uuid from t where k = 'c'); snooker uuid; v jsonb; tk text;
begin
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  perform pg_temp.as_anon();
  v := create_booking((select t.v from t where k = 'slug'), snooker,
    date_trunc('hour', now()) + interval '3 hours', 60, 2, 'Arun Profile', '9876500011');
  tk := v->>'token';
  v := booking_ticket(tk);
  perform pg_temp.eq('ticket: logo', v->'centre'->>'logo_path', c || '/logo-1.webp');
  perform pg_temp.eq('ticket: own QR', v->'centre'->>'upi_qr_path', c || '/upi-1.png');
  perform pg_temp.eq('ticket: UPI mode', v->'centre'->>'upi_mode', 'own');
  perform pg_temp.eq('ticket: payee', v->'centre'->>'upi_payee', 'PROFILE ARENA');
  perform pg_temp.eq('ticket: booking kept', v->'booking'->>'name', 'Arun Profile');
  perform pg_temp.reset();
end $$;

-- ── Staff photos ──
do $$
declare c uuid := (select v::uuid from t where k = 'c');
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000712');
  perform set_my_avatar(c, c || '/staff/00000000-0000-0000-0000-000000000712/me-1.webp');
  perform pg_temp.reset();
  perform pg_temp.eq('desk photo saved', (select avatar_path from centre_staff where centre_id = c and user_id = '00000000-0000-0000-0000-000000000712'),
    c || '/staff/00000000-0000-0000-0000-000000000712/me-1.webp');
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000712');
  -- not someone else's folder
  perform pg_temp.expect_error(format('select set_my_avatar(%L, %L)', c, c || '/staff/00000000-0000-0000-0000-000000000711/me.webp'), 'Invalid photo');
  perform pg_temp.expect_error(format('select set_my_avatar(%L, %L)', c, c || '/logo.webp'), 'Invalid photo');
  perform set_my_avatar(c, null);
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000713');
  perform pg_temp.expect_error(format('select set_my_avatar(%L, %L)', c, c || '/staff/00000000-0000-0000-0000-000000000713/me.webp'), 'Not a member');
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(format('select set_my_avatar(%L, null)', c), 'permission denied');
  perform pg_temp.reset();
  perform pg_temp.eq('photo cleared', (select avatar_path from centre_staff where centre_id = c and user_id = '00000000-0000-0000-0000-000000000712'), null::text);
end $$;

select 'centre profile ok';
