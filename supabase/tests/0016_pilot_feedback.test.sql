-- XS Arena — pilot feedback: snacks add-on, customer-details setting, assets, maintenance tickets, games per console.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000611', 'owner.pf@test.local', '{"display_name":"Owner PF"}'),
  ('00000000-0000-0000-0000-000000000612', 'desk.pf@test.local', '{"display_name":"Desk PF"}'),
  ('00000000-0000-0000-0000-000000000613', 'other.pf@test.local', '{"display_name":"Other PF"}');

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

-- ── Snacks add-on, customer-details setting ──
do $$
declare c uuid; ctx jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000611');
  c := create_centre('Feedback Arena');
  insert into t values ('c', c::text);
  ctx := centre_context((select slug from centres where id = c));
  perform pg_temp.eq('new centre: no snacks add-on', ctx->'features' ? 'snacks', false);
  perform pg_temp.eq('new centre: no add-ons listed', jsonb_array_length(ctx->'addons'), 0);
  perform pg_temp.eq('new centre: name + phone required by default', (ctx->'centre'->>'require_customer')::boolean, true);
  perform pg_temp.eq('new owner has not seen the guide', ctx->'me'->>'guide_seen_at', null::text);
  perform mark_guide_seen(c);
  perform pg_temp.eq('guide marked seen', (select guide_seen_at is not null from centre_staff where centre_id = c and user_id = auth.uid()), true);
  perform pg_temp.eq('owner may switch it', (select count(*) from centres where id = c)::int, 1);
  update centres set require_customer = false where id = c;
  perform pg_temp.eq('setting saved', (select require_customer from centres where id = c), false);
  update centres set require_customer = true where id = c;
  -- owners can't give themselves the add-on
  perform pg_temp.expect_error(format('select set_centre_addon(%L, %L, true)', c, 'snacks'), 'permission denied');
  perform pg_temp.expect_error(format('insert into centre_addons values (%L, %L)', c, 'snacks'), 'permission denied');
  perform pg_temp.reset();
  perform set_centre_addon(c, 'snacks', true);      -- Xelorsoft turns it on
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000611');
  ctx := centre_context((select slug from centres where id = c));
  perform pg_temp.eq('add-on on: snacks feature', ctx->'features' ? 'snacks', true);
  perform pg_temp.eq('add-on listed', ctx->'addons' ? 'snacks', true);
  perform pg_temp.eq('has_feature sees add-on', has_feature(c, 'snacks'), true);
  perform pg_temp.reset();
  perform set_centre_addon(c, 'snacks', false);
  perform pg_temp.eq('add-on off again', has_feature(c, 'snacks'), false);
  -- a cancelled subscription loses add-ons too
  perform set_centre_addon(c, 'snacks', true);
  update centre_subscriptions set status = 'cancelled' where centre_id = c;
  perform pg_temp.eq('cancelled: no add-on', has_feature(c, 'snacks'), false);
  update centre_subscriptions set status = 'trialing' where centre_id = c;
end $$;

-- ── Assets ──
do $$
declare c uuid := (select v::uuid from t where k = 'c'); a uuid; t1 uuid := gen_random_uuid(); fl uuid; snooker uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000611');
  perform save_staff(c, null, 'Desk PF', 'front_desk', null, null, 'desk.pf@test.local');
  select id into snooker from activities where centre_id = c and name = 'Snooker';
  select id into fl from floors where centre_id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', t1, 'activity_id', snooker, 'name', 'Table 1'))));
  insert into t values ('t1', t1::text);
  a := save_asset(c, jsonb_build_object('name', 'Cue sticks', 'category', 'cue', 'qty', 8, 'resource_id', t1, 'cost_paise', 400000, 'bought_on', '2026-11-01'));
  insert into t values ('cue', a::text);
  perform pg_temp.eq('asset saved', (select qty from assets where id = a), 8);
  perform save_asset(c, jsonb_build_object('id', a, 'name', 'Cue sticks', 'category', 'cue', 'qty', 10, 'resource_id', t1, 'condition', 'worn'));
  perform pg_temp.eq('asset edited', (select qty || ' ' || condition from assets where id = a), '10 worn');
  perform pg_temp.eq('asset changes audited', (select count(*) from audit_logs where centre_id = c and entity = 'asset')::int, 2);
  perform pg_temp.expect_error(format('select save_asset(%L, %L)', c, '{"name":"  "}'), 'Enter a name');
  perform pg_temp.expect_error(format('select save_asset(%L, %L)', c, '{"name":"Bad","category":"rocket"}'), 'check');

  perform pg_temp.as_user('00000000-0000-0000-0000-000000000612');   -- front desk
  perform claim_invites();
  perform pg_temp.eq('front desk can see assets', (select count(*) from assets where centre_id = c)::int, 1);
  perform pg_temp.expect_error(format('select save_asset(%L, %L)', c, '{"name":"Balls"}'), '');
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000613');   -- another owner
  perform pg_temp.eq('other centre sees nothing', (select count(*) from assets where centre_id = c)::int, 0);
  perform pg_temp.reset();
end $$;

-- ── Maintenance tickets ──
do $$
declare c uuid := (select v::uuid from t where k = 'c'); t1 uuid := (select v::uuid from t where k = 't1'); cue uuid := (select v::uuid from t where k = 'cue');
  tk jsonb; tk2 jsonb; s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
begin
  -- front desk raises: cloth torn, take Table 1 out of use
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000612');
  tk := raise_ticket(c, 'Cloth torn near the top pocket', 'Long tear, balls catch on it', t1, null, 'urgent', true);
  perform pg_temp.eq('ticket number', (tk->>'ticket_no')::int, 1);
  perform pg_temp.eq('raised by name', tk->>'raised_by_name', 'Desk PF');
  perform pg_temp.eq('table out of use', (select status from resources where id = t1), 'out_of_service');
  perform pg_temp.expect_error(format('select start_session(%L, %L, %L)', c, s1, t1), 'out of service');
  perform pg_temp.eq('floor shows the open ticket', (select (x->>'open_tickets')::int from jsonb_array_elements(floor_state(c)->'resources') x where x->>'id' = t1::text), 1);

  -- second ticket on the same table (asset) keeps it out until both are closed
  tk2 := raise_ticket(c, 'Two cues broken', null, t1, cue, 'normal', true);
  perform pg_temp.eq('asset marked needs repair', (select condition from assets where id = cue), 'needs_repair');
  perform start_ticket(c, (tk->>'id')::uuid);
  perform pg_temp.eq('in progress', (select status from tickets where id = (tk->>'id')::uuid), 'in_progress');

  -- closing needs what was done, a sane time, and expense rights for a cost
  perform pg_temp.expect_error(format('select resolve_ticket(%L, %L, %L)', c, tk->>'id', ' '), 'what was done');
  perform pg_temp.expect_error(format('select resolve_ticket(%L, %L, %L, %L)', c, tk->>'id', 'New cloth', now() + interval '1 day'), 'future');
  perform pg_temp.expect_error(format('select resolve_ticket(%L, %L, %L, null, 250000)', c, tk->>'id', 'New cloth'), '');
  perform pg_temp.expect_error(format('select resolve_ticket(%L, %L, %L, %L)', c, tk->>'id', 'New cloth', now() - interval '1 hour'), 'before the ticket');
  perform resolve_ticket(c, (tk->>'id')::uuid, 'Replaced the cloth with new Strachan cloth', now());
  perform pg_temp.eq('ticket closed', (select status from tickets where id = (tk->>'id')::uuid), 'resolved');
  perform pg_temp.eq('fix text kept', (select resolution from tickets where id = (tk->>'id')::uuid), 'Replaced the cloth with new Strachan cloth');
  perform pg_temp.eq('closed by', (select resolved_by_name from tickets where id = (tk->>'id')::uuid), 'Desk PF');
  perform pg_temp.eq('still out: other ticket open', (select status from resources where id = t1), 'out_of_service');
  perform pg_temp.expect_error(format('select resolve_ticket(%L, %L, %L)', c, tk->>'id', 'again'), 'already closed');

  -- owner closes the cue ticket with a cost → table back in use, asset good, Repairs expense
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000611');
  perform resolve_ticket(c, (tk2->>'id')::uuid, 'Bought two new cues', null, 180000);
  perform pg_temp.eq('table back in use', (select status from resources where id = t1), 'active');
  perform pg_temp.eq('asset good again', (select condition from assets where id = cue), 'good');
  perform pg_temp.eq('repair expense', (select amount_paise::text || ' ' || category from expenses e join tickets k on k.expense_id = e.id where k.id = (tk2->>'id')::uuid), '180000 Repairs');
  perform pg_temp.eq('tickets audited', (select count(*) from audit_logs where centre_id = c and entity = 'ticket')::int, 5);

  -- can't take a table out while a game is running on it
  perform start_session(c, s2, t1, 1, null, '9847066666', 'Arun');
  perform pg_temp.expect_error(format('select raise_ticket(%L, %L, null, %L, null, %L, true)', c, 'Light flickers', t1, 'low'), 'End the game');
  perform raise_ticket(c, 'Light flickers', null, t1, null, 'low', false);   -- fine without taking it out
  perform pg_temp.eq('table still active', (select status from resources where id = t1), 'active');

  -- other centres and anon get nothing
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000613');
  perform pg_temp.expect_error(format('select raise_ticket(%L, %L)', c, 'Hack'), '');
  perform pg_temp.eq('other centre sees no tickets', (select count(*) from tickets where centre_id = c)::int, 0);
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(format('select raise_ticket(%L, %L)', c, 'Hack'), 'permission denied');
  perform pg_temp.reset();
end $$;

-- ── Games per console: 5 PS5, 4 with GTA 6 ──
do $$
declare c uuid := (select v::uuid from t where k = 'c'); ps uuid; fl uuid; slug text; p uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_at timestamptz := date_trunc('hour', now()) + interval '3 hours'; pg jsonb; sl jsonb; ci jsonb; b jsonb; i int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000611');
  update centres set open_time = '00:00', close_time = '00:00' where id = c;
  select id into ps from activities where centre_id = c and name = 'PS5';
  select id into fl from floors where centre_id = c;
  select centres.slug into slug from centres where id = c;
  perform save_floor(c, jsonb_build_object('id', fl, 'resources', jsonb_build_array(
    jsonb_build_object('id', (select v from t where k = 't1'), 'activity_id', (select id from activities where centre_id = c and name = 'Snooker'), 'name', 'Table 1'),
    jsonb_build_object('id', p[1], 'activity_id', ps, 'name', 'PS5 #1'), jsonb_build_object('id', p[2], 'activity_id', ps, 'name', 'PS5 #2'),
    jsonb_build_object('id', p[3], 'activity_id', ps, 'name', 'PS5 #3'), jsonb_build_object('id', p[4], 'activity_id', ps, 'name', 'PS5 #4'),
    jsonb_build_object('id', p[5], 'activity_id', ps, 'name', 'PS5 #5'))));
  for i in 1..4 loop perform set_resource_games(c, p[i], array['GTA 6', 'FIFA 26', ' fifa 26 ', '']); end loop;
  perform set_resource_games(c, p[5], array['FIFA 26', 'Tekken 8']);
  perform pg_temp.eq('games cleaned and de-duplicated', (select games from resources where id = p[1]), array['FIFA 26', 'GTA 6']);
  perform pg_temp.eq('games audited', (select count(*) from audit_logs where centre_id = c and action = 'games')::int, 5);

  -- booking page lists games with console counts
  pg := booking_page(slug);
  select a into pg from jsonb_array_elements(pg->'activities') a where a->>'name' = 'PS5';
  perform pg_temp.eq('GTA on 4 consoles', (select (g->>'consoles')::int from jsonb_array_elements(pg->'games') g where g->>'name' = 'GTA 6'), 4);
  perform pg_temp.eq('FIFA on 5 consoles', (select (g->>'consoles')::int from jsonb_array_elements(pg->'games') g where g->>'name' = 'FIFA 26'), 5);
  perform pg_temp.eq('Tekken on 1 console', (select (g->>'consoles')::int from jsonb_array_elements(pg->'games') g where g->>'name' = 'Tekken 8'), 1);
  perform pg_temp.eq('public floor hides tickets', (select count(*) from jsonb_array_elements(booking_page(slug)->'resources') x where x ? 'open_tickets')::int, 0);

  -- Tekken: one booking fills the only Tekken console; plain PS5 still free
  perform pg_temp.as_anon();
  b := create_booking(slug, ps, v_at, 60, 1, 'Tek One', '9847000001', null, 'tekken 8');
  perform pg_temp.eq('game stored as on the console', b->'booking'->>'game', 'Tekken 8');
  sl := booking_slots(slug, ps, (v_at at time zone 'Asia/Kolkata')::date, 60, 1, 'Tekken 8');
  perform pg_temp.eq('Tekken slot now full', (select (x->>'free')::boolean from jsonb_array_elements(sl->'slots') x where (x->>'at')::timestamptz = v_at), false);
  sl := booking_slots(slug, ps, (v_at at time zone 'Asia/Kolkata')::date, 60, 1);
  perform pg_temp.eq('any-game slot still free', (select (x->>'free')::boolean from jsonb_array_elements(sl->'slots') x where (x->>'at')::timestamptz = v_at), true);
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,1,%L,%L,null,%L)', slug, ps, v_at, 'Tek Two', '9847000002', 'Tekken 8'), 'just taken');
  perform pg_temp.expect_error(format('select create_booking(%L,%L,%L,60,1,%L,%L,null,%L)', slug, ps, v_at, 'Mario', '9847000003', 'Mario Kart'), 'No console here has');

  -- GTA: 4 consoles; Tekken booking above uses PS5 #5 so 4 GTA bookings still fit, the 5th doesn't
  for i in 1..3 loop perform create_booking(slug, ps, v_at, 60, 1, 'Gta ' || i, '984700010' || i, null, 'GTA 6'); end loop;
  perform pg_temp.reset();
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000611');
  b := staff_create_booking(c, ps, v_at, 60, 1, 'Gta Four', '9847000104', null, 'gta 6');
  perform pg_temp.eq('staff booking with game', b->'booking'->>'game', 'GTA 6');
  perform pg_temp.expect_error(format('select staff_create_booking(%L,%L,%L,60,1,%L,%L,null,%L)', c, ps, v_at, 'Gta Five', '9847000105', 'GTA 6'), 'just taken');
  perform pg_temp.expect_error(format('select staff_create_booking(%L,%L,%L,60,1,%L,%L)', c, ps, v_at, 'Anyone', '9847000106'), 'just taken');   -- all 5 held

  -- check-in lists consoles with the booked game first
  ci := check_in_booking(c, b->'booking'->>'code');
  perform pg_temp.eq('booked game shown', ci->'booking'->>'game', 'GTA 6');
  perform pg_temp.eq('game consoles first', (ci->'free_tables'->0->>'has_game')::boolean, true);
  perform pg_temp.eq('non-game console last', ci->'free_tables'->4->>'name', 'PS5 #5');
  perform pg_temp.eq('non-game console flagged', (ci->'free_tables'->4->>'has_game')::boolean, false);
  -- the floor knows each console's games
  perform pg_temp.eq('floor has games', (select x->'games' from jsonb_array_elements(floor_state(c)->'resources') x where x->>'id' = p[5]::text), '["FIFA 26", "Tekken 8"]'::jsonb);

  -- front desk can't change games; other owners can't either
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000612');
  perform pg_temp.expect_error(format('select set_resource_games(%L, %L, %L)', c, p[1], '{X}'), '');
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000613');
  perform pg_temp.expect_error(format('select set_resource_games(%L, %L, %L)', c, p[1], '{X}'), '');
  perform pg_temp.reset();
end $$;

select 'pilot feedback ok';
