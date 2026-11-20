-- XS Arena — Day 2b: tabs, sessions, immutable session events, waiting list, live floor state.
--
-- Time rules
--  * Billable time = sum of running intervals reconstructed from session_events (pauses excluded).
--  * Offline-safe: the app creates session ids itself and sends client_at with every command. An event's
--    time is the client's time when it is plausible (not in the future, not before the previous event,
--    at most 12 h old), otherwise the server's time. Both are stored. Repeating a command with the same
--    session id + kind + client_at is a no-op, so a queued command can be replayed safely.

-- ───────────────────────── Tabs ─────────────────────────
create table public.tabs (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  customer_id uuid references public.customers(id),
  label text,
  status text not null default 'open' check (status in ('open','settled','void')),
  opened_by uuid,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create index tabs_centre_open_idx on public.tabs(centre_id) where status = 'open';

-- ───────────────────────── Sessions ─────────────────────────
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  resource_id uuid not null references public.resources(id),
  activity_id uuid not null references public.activities(id),
  rate_card_id uuid not null references public.rate_cards(id),
  tab_id uuid not null references public.tabs(id),
  customer_id uuid references public.customers(id),
  players integer not null default 1 check (players between 1 and 50),
  planned_minutes integer check (planned_minutes is null or planned_minutes between 1 and 1440),
  status text not null default 'running' check (status in ('running','paused','ended','void')),
  started_at timestamptz not null,
  ended_at timestamptz,
  billable_seconds integer,
  void_reason text,
  source text not null default 'walk_in' check (source in ('walk_in','booking','waitlist')),
  created_by uuid,
  created_at timestamptz not null default now()
);
-- one live game per table/console/track
create unique index sessions_one_live_per_resource on public.sessions(resource_id) where status in ('running','paused');
create index sessions_centre_live_idx on public.sessions(centre_id) where status in ('running','paused');
create index sessions_centre_time_idx on public.sessions(centre_id, started_at desc);
create index sessions_tab_idx on public.sessions(tab_id);
create index sessions_customer_idx on public.sessions(customer_id, started_at desc);

create table public.session_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  centre_id uuid not null references public.centres(id) on delete cascade,
  kind text not null check (kind in ('start','pause','resume','extend','transfer','players','end','void')),
  at timestamptz not null,
  client_at timestamptz,
  server_at timestamptz not null default now(),
  data jsonb,
  actor uuid
);
create index session_events_session_idx on public.session_events(session_id, at, id);
create unique index session_events_replay_uq on public.session_events(session_id, kind, client_at) where client_at is not null;

-- Events are a ledger: no edits, no deletes (except when the whole centre is deleted).
create or replace function public._events_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'Session events cannot be changed'; end if;
  -- deletes only happen as part of deleting the whole session/centre (cascade)
  if not exists (select 1 from sessions where id = old.session_id) or not exists (select 1 from centres where id = old.centre_id) then
    return old;
  end if;
  raise exception 'Session events cannot be deleted';
  return null;
end $$;
create trigger session_events_immutable before update or delete on public.session_events
  for each row execute function public._events_immutable();

-- ───────────────────────── Waiting list ─────────────────────────
create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  activity_id uuid not null references public.activities(id),
  customer_id uuid references public.customers(id),
  name text not null check (length(trim(name)) between 1 and 80),
  phone text,
  party_size integer not null default 1 check (party_size between 1 and 50),
  note text,
  status text not null default 'waiting' check (status in ('waiting','notified','seated','cancelled','no_show')),
  session_id uuid references public.sessions(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  closed_at timestamptz
);
create index waitlist_centre_live_idx on public.waitlist(centre_id, created_at) where status in ('waiting','notified');

-- ───────────────────────── RLS ─────────────────────────
alter table public.tabs enable row level security;
alter table public.sessions enable row level security;
alter table public.session_events enable row level security;
alter table public.waitlist enable row level security;
create policy tabs_read on public.tabs for select to authenticated using (is_centre_member(centre_id));
create policy sessions_read on public.sessions for select to authenticated using (is_centre_member(centre_id));
create policy session_events_read on public.session_events for select to authenticated using (is_centre_member(centre_id));
create policy waitlist_read on public.waitlist for select to authenticated using (is_centre_member(centre_id));
grant select on public.tabs, public.sessions, public.session_events, public.waitlist to authenticated;

-- ───────────────────────── Time helpers ─────────────────────────
-- Pick the event time: trust the device clock only when it is plausible.
create or replace function public._event_time(p_client_at timestamptz, p_not_before timestamptz)
returns timestamptz language sql stable set search_path = public as $$
  select case
    when p_client_at is null then now()
    when p_client_at > now() + interval '2 minutes' then now()
    when p_client_at < now() - interval '12 hours' then now()
    when p_not_before is not null and p_client_at < p_not_before then greatest(now(), p_not_before)
    else least(p_client_at, now()) end;
$$;

-- Seconds a session has been running (pauses excluded), up to p_until or its end.
create or replace function public.session_billable_seconds(p_session uuid, p_until timestamptz default now())
returns integer language plpgsql stable security definer set search_path = public as $$
declare e record; v_since timestamptz; v_total numeric := 0;
begin
  if not exists (select 1 from sessions s where s.id = p_session and is_centre_member(s.centre_id)) then return null; end if;
  for e in select kind, at from session_events where session_id = p_session order by at, id loop
    if e.kind in ('start','resume') then
      if v_since is null then v_since := e.at; end if;
    elsif e.kind in ('pause','end','void') then
      if v_since is not null then v_total := v_total + greatest(extract(epoch from e.at - v_since), 0); v_since := null; end if;
      exit when e.kind in ('end','void');
    end if;
  end loop;
  if v_since is not null then v_total := v_total + greatest(extract(epoch from p_until - v_since), 0); end if;
  return floor(v_total)::int;
end $$;

-- internal: last event time of a session (for ordering)
create or replace function public._last_event_at(p_session uuid)
returns timestamptz language sql stable set search_path = public as $$
  select max(at) from session_events where session_id = p_session;
$$;

-- internal: append an event, idempotent on (session, kind, client_at). Returns false if it was a replay.
create or replace function public._add_event(p_session uuid, p_centre uuid, p_kind text, p_client_at timestamptz, p_data jsonb default null)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  if p_client_at is not null and exists (select 1 from session_events where session_id = p_session and kind = p_kind and client_at = p_client_at) then
    return null; -- replayed command
  end if;
  v_at := _event_time(p_client_at, _last_event_at(p_session));
  insert into session_events(session_id, centre_id, kind, at, client_at, data, actor)
  values (p_session, p_centre, p_kind, v_at, p_client_at, p_data, auth.uid());
  return v_at;
end $$;

-- internal: lock a session of this centre for a state change
create or replace function public._session_for_update(p_centre uuid, p_session uuid)
returns sessions language plpgsql security definer set search_path = public as $$
declare s sessions;
begin
  select * into s from sessions where id = p_session and centre_id = p_centre for update;
  if not found then raise exception 'Game not found'; end if;
  return s;
end $$;

-- ───────────────────────── Commands ─────────────────────────
-- Start a game on a table/console/track. p_session is created by the app (offline-safe); calling again
-- with the same id returns the existing game. Pass p_phone (+ p_name) to link a customer, or nothing for a
-- walk-in without number. Pass p_tab to add this game to an existing group bill.
create or replace function public.start_session(
  p_centre uuid, p_session uuid, p_resource uuid, p_players int default 1, p_planned_minutes int default null,
  p_phone text default null, p_name text default null, p_tab uuid default null, p_client_at timestamptz default null,
  p_source text default 'walk_in', p_waitlist uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r resources; v_card rate_cards; v_customer uuid; v_tab uuid := p_tab; v_at timestamptz; s sessions;
begin
  perform require_perm(p_centre, 'floor.operate');
  if p_session is null then raise exception 'Missing game id'; end if;
  select * into s from sessions where id = p_session;
  if found then
    if s.centre_id <> p_centre then raise exception 'Game not found'; end if;
    return jsonb_build_object('session_id', s.id, 'tab_id', s.tab_id, 'status', s.status, 'started_at', s.started_at, 'replayed', true);
  end if;

  select * into r from resources where id = p_resource and centre_id = p_centre for update;
  if not found or r.status = 'archived' then raise exception 'Table not found'; end if;
  if r.status = 'out_of_service' then raise exception '% is out of service', r.name; end if;
  if exists (select 1 from sessions where resource_id = p_resource and status in ('running','paused')) then
    raise exception '% is already in use', r.name;
  end if;
  if coalesce(p_players,1) > r.capacity then raise exception '% takes at most % players', r.name, r.capacity; end if;
  select * into v_card from rate_cards where activity_id = r.activity_id and active;
  if not found then raise exception 'Set a price for this game first'; end if;
  if v_card.billing_mode = 'per_slot' and p_planned_minutes is null then
    p_planned_minutes := v_card.slot_minutes;
  end if;

  if nullif(trim(coalesce(p_phone,'')),'') is not null then
    perform require_perm(p_centre, 'customers.manage');
    v_customer := _customer_by_phone(p_centre, p_name, p_phone, case when p_source = 'booking' then 'online' else 'walk_in' end);
  end if;

  if v_tab is not null then
    if not exists (select 1 from tabs where id = v_tab and centre_id = p_centre and status = 'open') then raise exception 'That bill is already closed'; end if;
    if v_customer is not null then update tabs set customer_id = coalesce(customer_id, v_customer) where id = v_tab; end if;
  else
    insert into tabs(centre_id, customer_id, label, opened_by) values (p_centre, v_customer, r.name, auth.uid()) returning id into v_tab;
  end if;

  v_at := _event_time(p_client_at, null);
  insert into sessions(id, centre_id, resource_id, activity_id, rate_card_id, tab_id, customer_id, players, planned_minutes,
    status, started_at, source, created_by)
  values (p_session, p_centre, p_resource, r.activity_id, v_card.id, v_tab, v_customer, coalesce(p_players,1), p_planned_minutes,
    'running', v_at, coalesce(p_source,'walk_in'), auth.uid());
  insert into session_events(session_id, centre_id, kind, at, client_at, data, actor)
  values (p_session, p_centre, 'start', v_at, p_client_at,
    jsonb_build_object('resource', p_resource, 'players', coalesce(p_players,1), 'planned_minutes', p_planned_minutes), auth.uid());

  if p_waitlist is not null then
    update waitlist set status = 'seated', session_id = p_session, closed_at = now(), customer_id = coalesce(customer_id, v_customer)
    where id = p_waitlist and centre_id = p_centre and status in ('waiting','notified');
  end if;
  return jsonb_build_object('session_id', p_session, 'tab_id', v_tab, 'customer_id', v_customer, 'status', 'running',
    'started_at', v_at, 'planned_minutes', p_planned_minutes, 'replayed', false);
end $$;

create or replace function public.pause_session(p_centre uuid, p_session uuid, p_client_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s sessions;
begin
  perform require_perm(p_centre, 'floor.operate');
  s := _session_for_update(p_centre, p_session);
  if s.status = 'paused' then return jsonb_build_object('status', 'paused', 'replayed', true); end if;
  if s.status <> 'running' then raise exception 'This game is not running'; end if;
  if _add_event(p_session, p_centre, 'pause', p_client_at) is not null then
    update sessions set status = 'paused' where id = p_session;
  end if;
  return jsonb_build_object('status', 'paused', 'billable_seconds', session_billable_seconds(p_session));
end $$;

create or replace function public.resume_session(p_centre uuid, p_session uuid, p_client_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s sessions;
begin
  perform require_perm(p_centre, 'floor.operate');
  s := _session_for_update(p_centre, p_session);
  if s.status = 'running' then return jsonb_build_object('status', 'running', 'replayed', true); end if;
  if s.status <> 'paused' then raise exception 'This game is not paused'; end if;
  if _add_event(p_session, p_centre, 'resume', p_client_at) is not null then
    update sessions set status = 'running' where id = p_session;
  end if;
  return jsonb_build_object('status', 'running', 'billable_seconds', session_billable_seconds(p_session));
end $$;

-- Add minutes to a fixed-time game (or give an open-timer game an end time).
create or replace function public.extend_session(p_centre uuid, p_session uuid, p_minutes int, p_client_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s sessions; v_planned int;
begin
  perform require_perm(p_centre, 'floor.operate');
  if coalesce(p_minutes,0) <= 0 or p_minutes > 720 then raise exception 'Choose how many minutes to add'; end if;
  s := _session_for_update(p_centre, p_session);
  if s.status not in ('running','paused') then raise exception 'This game has ended'; end if;
  v_planned := coalesce(s.planned_minutes, ceil(session_billable_seconds(p_session) / 60.0)::int) + p_minutes;
  if _add_event(p_session, p_centre, 'extend', p_client_at, jsonb_build_object('minutes', p_minutes, 'planned_minutes', v_planned)) is not null then
    update sessions set planned_minutes = v_planned where id = p_session;
  else
    select planned_minutes into v_planned from sessions where id = p_session;
  end if;
  return jsonb_build_object('planned_minutes', v_planned);
end $$;

-- Move a live game to another free table of the same kind (time keeps running).
create or replace function public.transfer_session(p_centre uuid, p_session uuid, p_to_resource uuid, p_client_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s sessions; r resources;
begin
  perform require_perm(p_centre, 'floor.operate');
  s := _session_for_update(p_centre, p_session);
  if s.status not in ('running','paused') then raise exception 'This game has ended'; end if;
  if s.resource_id = p_to_resource then return jsonb_build_object('resource_id', p_to_resource, 'replayed', true); end if;
  select * into r from resources where id = p_to_resource and centre_id = p_centre for update;
  if not found or r.status <> 'active' then raise exception 'That table is not available'; end if;
  if r.activity_id <> s.activity_id then raise exception 'Move the game to a table of the same type'; end if;
  if exists (select 1 from sessions where resource_id = p_to_resource and status in ('running','paused')) then
    raise exception '% is already in use', r.name;
  end if;
  if _add_event(p_session, p_centre, 'transfer', p_client_at, jsonb_build_object('from', s.resource_id, 'to', p_to_resource)) is not null then
    update sessions set resource_id = p_to_resource where id = p_session;
  end if;
  return jsonb_build_object('resource_id', p_to_resource);
end $$;

create or replace function public.set_session_players(p_centre uuid, p_session uuid, p_players int, p_client_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s sessions; v_cap int;
begin
  perform require_perm(p_centre, 'floor.operate');
  s := _session_for_update(p_centre, p_session);
  if s.status not in ('running','paused') then raise exception 'This game has ended'; end if;
  select capacity into v_cap from resources where id = s.resource_id;
  if coalesce(p_players,0) < 1 or p_players > v_cap then raise exception 'Players must be between 1 and %', v_cap; end if;
  if _add_event(p_session, p_centre, 'players', p_client_at, jsonb_build_object('from', s.players, 'to', p_players)) is not null then
    update sessions set players = p_players where id = p_session;
  end if;
  return jsonb_build_object('players', p_players);
end $$;

-- End a game: stops the clock and records billable time. The bill itself is built from the tab (Day 5).
create or replace function public.end_session(p_centre uuid, p_session uuid, p_client_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s sessions; v_at timestamptz; v_secs int;
begin
  perform require_perm(p_centre, 'floor.operate');
  s := _session_for_update(p_centre, p_session);
  if s.status = 'ended' then
    return jsonb_build_object('status', 'ended', 'ended_at', s.ended_at, 'billable_seconds', s.billable_seconds, 'tab_id', s.tab_id, 'replayed', true);
  end if;
  if s.status = 'void' then raise exception 'This game was cancelled'; end if;
  v_at := _add_event(p_session, p_centre, 'end', p_client_at);
  if v_at is null then select max(at) into v_at from session_events where session_id = p_session and kind = 'end'; end if;
  v_secs := session_billable_seconds(p_session, v_at);
  update sessions set status = 'ended', ended_at = v_at, billable_seconds = v_secs where id = p_session;
  return jsonb_build_object('status', 'ended', 'ended_at', v_at, 'billable_seconds', v_secs, 'tab_id', s.tab_id);
end $$;

-- Cancel a game started by mistake. Manager or owner only, reason required.
create or replace function public.void_session(p_centre uuid, p_session uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare s sessions;
begin
  perform require_perm(p_centre, 'billing.void');
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  s := _session_for_update(p_centre, p_session);
  if s.status = 'void' then return; end if;
  if exists (select 1 from tabs where id = s.tab_id and status = 'settled') then raise exception 'This game is already billed. Void the bill instead.'; end if;
  perform _add_event(p_session, p_centre, 'void', null, jsonb_build_object('reason', trim(p_reason)));
  update sessions set status = 'void', void_reason = trim(p_reason), ended_at = coalesce(ended_at, now()), billable_seconds = 0 where id = p_session;
  -- an open tab left with nothing in it is closed as void
  update tabs set status = 'void', closed_at = now() where id = s.tab_id and status = 'open'
    and not exists (select 1 from sessions x where x.tab_id = s.tab_id and x.status <> 'void');
  perform log_audit(p_centre, 'void', 'session', p_session, jsonb_build_object('resource', s.resource_id, 'started_at', s.started_at), trim(p_reason));
end $$;

-- Take a table out of service (broken cue, console fault) or bring it back.
create or replace function public.set_resource_status(p_centre uuid, p_resource uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm(p_centre, 'pricing.manage');
  if p_status not in ('active','out_of_service') then raise exception 'Invalid status'; end if;
  if p_status = 'out_of_service' and exists (select 1 from sessions where resource_id = p_resource and status in ('running','paused')) then
    raise exception 'End the game on this table first';
  end if;
  update resources set status = p_status where id = p_resource and centre_id = p_centre and status <> 'archived';
  if not found then raise exception 'Table not found'; end if;
  perform log_audit(p_centre, 'status', 'resource', p_resource, jsonb_build_object('status', p_status), p_reason);
end $$;

-- ───────────────────────── Waiting list ─────────────────────────
create or replace function public.add_to_waitlist(p_centre uuid, p_activity uuid, p_name text, p_phone text default null,
  p_party_size int default 1, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_customer uuid;
begin
  perform require_perm(p_centre, 'floor.operate');
  if not exists (select 1 from activities where id = p_activity and centre_id = p_centre) then raise exception 'Activity not found'; end if;
  if nullif(trim(coalesce(p_phone,'')),'') is not null then
    perform require_perm(p_centre, 'customers.manage');
    v_customer := _customer_by_phone(p_centre, p_name, p_phone, 'walk_in');
  end if;
  insert into waitlist(centre_id, activity_id, customer_id, name, phone, party_size, note, created_by)
  values (p_centre, p_activity, v_customer, coalesce(nullif(trim(p_name),''), 'Guest'), normalize_phone(nullif(trim(coalesce(p_phone,'')),'')),
    coalesce(p_party_size,1), nullif(trim(coalesce(p_note,'')),''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.set_waitlist_status(p_centre uuid, p_entry uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm(p_centre, 'floor.operate');
  if p_status not in ('waiting','notified','cancelled','no_show') then raise exception 'Invalid status'; end if;
  update waitlist set status = p_status,
    notified_at = case when p_status = 'notified' then now() else notified_at end,
    closed_at = case when p_status in ('cancelled','no_show') then now() else null end
  where id = p_entry and centre_id = p_centre and status in ('waiting','notified');
  if not found then raise exception 'Waiting list entry not found'; end if;
end $$;

-- ───────────────────────── Live floor ─────────────────────────
-- Everything the floor screen, TV display and owner phone need in one call.
create or replace function public.floor_state(p_centre uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'server_time', now(),
    'floors', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'width', f.width, 'height', f.height,
        'outline', f.outline, 'fixtures', f.fixtures, 'version', f.version) order by f.sort, f.created_at), '[]') from floors f where f.centre_id = p_centre),
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'icon', a.icon, 'color', a.color,
        'active', a.active, 'rate_card', (select to_jsonb(rc) - 'centre_id' - 'created_by' from rate_cards rc where rc.activity_id = a.id and rc.active))
        order by a.sort), '[]') from activities a where a.centre_id = p_centre),
    'resources', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'floor_id', r.floor_id, 'activity_id', r.activity_id, 'name', r.name, 'shape', r.shape,
        'x', r.x, 'y', r.y, 'w', r.w, 'h', r.h, 'rotation', r.rotation, 'points', r.points, 'capacity', r.capacity,
        'online_bookable', r.online_bookable, 'status', r.status,
        'session', (select jsonb_build_object('id', s.id, 'status', s.status, 'started_at', s.started_at, 'players', s.players,
            'planned_minutes', s.planned_minutes, 'tab_id', s.tab_id, 'billable_seconds', session_billable_seconds(s.id),
            'running_since', case when s.status = 'running' then (select max(at) from session_events e where e.session_id = s.id and e.kind in ('start','resume')) end,
            'customer', (select jsonb_build_object('id', c.id, 'name', c.full_name, 'phone', c.phone) from customers c where c.id = s.customer_id))
          from sessions s where s.resource_id = r.id and s.status in ('running','paused')))
        order by r.sort), '[]') from resources r where r.centre_id = p_centre and r.status <> 'archived'),
    'waitlist', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'activity_id', w.activity_id, 'name', w.name, 'phone', w.phone,
        'party_size', w.party_size, 'note', w.note, 'status', w.status, 'created_at', w.created_at) order by w.created_at), '[]')
        from waitlist w where w.centre_id = p_centre and w.status in ('waiting','notified'))
  );
end $$;

-- ───────────────────────── Grants ─────────────────────────
revoke execute on function public._seed_activities(uuid), public._centre_defaults(), public._event_time(timestamptz,timestamptz),
  public._last_event_at(uuid), public._add_event(uuid,uuid,text,timestamptz,jsonb), public._session_for_update(uuid,uuid),
  public._events_immutable()
  from public, anon, authenticated;
grant execute on function
  public.save_rate_card(uuid,uuid,jsonb), public.save_activity(uuid,uuid,text,text,text,text,boolean), public.save_floor(uuid,jsonb),
  public.start_session(uuid,uuid,uuid,int,int,text,text,uuid,timestamptz,text,uuid),
  public.pause_session(uuid,uuid,timestamptz), public.resume_session(uuid,uuid,timestamptz),
  public.extend_session(uuid,uuid,int,timestamptz), public.transfer_session(uuid,uuid,uuid,timestamptz),
  public.set_session_players(uuid,uuid,int,timestamptz), public.end_session(uuid,uuid,timestamptz),
  public.void_session(uuid,uuid,text), public.set_resource_status(uuid,uuid,text,text),
  public.add_to_waitlist(uuid,uuid,text,text,int,text), public.set_waitlist_status(uuid,uuid,text),
  public.floor_state(uuid), public.session_billable_seconds(uuid,timestamptz)
to authenticated;
-- Realtime: the floor, TV and owner phone listen for changes.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.sessions, public.waitlist, public.resources;
  end if;
end $$;
