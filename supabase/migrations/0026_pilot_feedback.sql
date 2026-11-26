-- XS Arena — pilot feedback (25 Nov 2026 pitch):
--   1. name + phone required for every new customer (centre setting, on by default; enforced by the app screens)
--   2. assets: cues, balls, cloth, controllers, RC cars… in one list, with condition and cost
--   3. maintenance tickets: raise for a table/console/asset, optionally take it out of use, close with what was done and when
--   4. games installed on each console: customers pick a game when booking and only consoles with it count
--   5. snacks become a paid add-on (centre_addons); existing centres keep it

-- ───────────────────────── 1. Customer details setting ─────────────────────────
alter table public.centres add column require_customer boolean not null default true;
grant update (require_customer) on public.centres to authenticated;

-- In-app guide: opens by itself once for each new team member; people already using XS Arena aren't interrupted.
alter table public.centre_staff add column guide_seen_at timestamptz;
update public.centre_staff set guide_seen_at = now() where guide_seen_at is null;

create or replace function public.mark_guide_seen(p_centre uuid)
returns void language sql volatile security definer set search_path = public as $$
  update centre_staff set guide_seen_at = coalesce(guide_seen_at, now()) where centre_id = p_centre and user_id = auth.uid();
$$;

-- ───────────────────────── 5. Add-ons ─────────────────────────
-- Paid extras on top of the plan. Turned on by Xelorsoft (service role) when the centre pays for it.
create table public.centre_addons (
  centre_id uuid not null references public.centres(id) on delete cascade,
  addon text not null check (addon in ('snacks')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (centre_id, addon)
);
alter table public.centre_addons enable row level security;
create policy centre_addons_read on public.centre_addons for select to authenticated using (is_centre_member(centre_id));
grant select on public.centre_addons to authenticated;
-- centres that already sell snacks keep them
insert into public.centre_addons(centre_id, addon) select id, 'snacks' from public.centres on conflict do nothing;

create or replace function public.has_feature(p_centre uuid, p_feature text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
      select 1 from centre_subscriptions cs join plan_features pf on pf.plan = cs.plan
      where cs.centre_id = p_centre and pf.feature = p_feature and cs.status in ('trialing','active','past_due'))
    or exists (
      select 1 from centre_addons ad join centre_subscriptions cs on cs.centre_id = ad.centre_id
      where ad.centre_id = p_centre and ad.addon = p_feature and ad.active and cs.status in ('trialing','active','past_due'));
$$;

create or replace function public.centre_context(p_slug text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare c centres; st centre_staff; cs centre_subscriptions; v_plan text;
begin
  if auth.uid() is null then return null; end if;
  perform claim_invites();
  select * into c from centres where slug = p_slug;
  if not found then return null; end if;
  select * into st from centre_staff where centre_id = c.id and user_id = auth.uid() and status = 'active';
  if not found then return null; end if;
  select * into cs from centre_subscriptions where centre_id = c.id;
  v_plan := coalesce(cs.plan, 'pro');
  return jsonb_build_object(
    'centre', to_jsonb(c), 'me', to_jsonb(st), 'subscription', case when cs.centre_id is null then null else to_jsonb(cs) end, 'plan', v_plan,
    'permissions', coalesce((select jsonb_agg(permission) from role_permissions where role = st.role), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(f) from (
        select feature f from plan_features where plan = v_plan
        union select addon from centre_addons where centre_id = c.id and active) x), '[]'::jsonb),
    'addons', coalesce((select jsonb_agg(addon) from centre_addons where centre_id = c.id and active), '[]'::jsonb));
end $$;

-- Xelorsoft only (run with the service key / SQL editor) when a centre buys or drops an add-on.
create or replace function public.set_centre_addon(p_centre uuid, p_addon text, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into centre_addons(centre_id, addon, active) values (p_centre, p_addon, p_active)
  on conflict (centre_id, addon) do update set active = excluded.active;
end $$;

-- ───────────────────────── 2. Assets ─────────────────────────
create table public.assets (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  category text not null default 'other'
    check (category in ('cue','balls','cloth','rack','chalk','controller','console','headset','screen','rc_car','battery','furniture','other')),
  qty integer not null default 1 check (qty between 0 and 10000),
  resource_id uuid references public.resources(id) on delete set null,
  condition text not null default 'good' check (condition in ('good','worn','needs_repair','retired')),
  bought_on date,
  cost_paise bigint not null default 0 check (cost_paise >= 0),
  notes text check (notes is null or length(notes) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assets_centre_idx on public.assets(centre_id, category);
alter table public.assets enable row level security;
create policy assets_read on public.assets for select to authenticated using (is_centre_member(centre_id));
grant select on public.assets to authenticated;

-- Add or edit an asset. p_asset: {id?, name, category, qty, resource_id?, condition, bought_on?, cost_paise, notes?}
create or replace function public.save_asset(p_centre uuid, p_asset jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p_asset->>'id','')::uuid; v_res uuid := nullif(p_asset->>'resource_id','')::uuid; old assets;
begin
  perform require_perm(p_centre, 'inventory.manage');
  if nullif(trim(coalesce(p_asset->>'name','')),'') is null then raise exception 'Enter a name'; end if;
  if v_res is not null and not exists (select 1 from resources where id = v_res and centre_id = p_centre and status <> 'archived') then
    raise exception 'Table not found';
  end if;
  if v_id is null then
    insert into assets(centre_id, name, category, qty, resource_id, condition, bought_on, cost_paise, notes, created_by)
    values (p_centre, trim(p_asset->>'name'), coalesce(nullif(p_asset->>'category',''),'other'), coalesce((p_asset->>'qty')::int, 1), v_res,
      coalesce(nullif(p_asset->>'condition',''),'good'), nullif(p_asset->>'bought_on','')::date, coalesce((p_asset->>'cost_paise')::bigint, 0),
      nullif(trim(coalesce(p_asset->>'notes','')),''), auth.uid())
    returning id into v_id;
    perform log_audit(p_centre, 'create', 'asset', v_id, jsonb_build_object('name', trim(p_asset->>'name'), 'qty', coalesce((p_asset->>'qty')::int, 1)));
  else
    select * into old from assets where id = v_id and centre_id = p_centre for update;
    if not found then raise exception 'Asset not found'; end if;
    update assets set name = trim(p_asset->>'name'), category = coalesce(nullif(p_asset->>'category',''), old.category),
      qty = coalesce((p_asset->>'qty')::int, old.qty), resource_id = v_res, condition = coalesce(nullif(p_asset->>'condition',''), old.condition),
      bought_on = nullif(p_asset->>'bought_on','')::date, cost_paise = coalesce((p_asset->>'cost_paise')::bigint, old.cost_paise),
      notes = nullif(trim(coalesce(p_asset->>'notes','')),''), updated_at = now()
    where id = v_id;
    perform log_audit(p_centre, 'update', 'asset', v_id, jsonb_build_object('qty', jsonb_build_array(old.qty, coalesce((p_asset->>'qty')::int, old.qty)),
      'condition', jsonb_build_array(old.condition, coalesce(nullif(p_asset->>'condition',''), old.condition))));
  end if;
  return v_id;
end $$;

-- ───────────────────────── 3. Maintenance tickets ─────────────────────────
alter table public.centres add column ticket_seq integer not null default 0;

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  ticket_no integer not null,
  title text not null check (length(trim(title)) between 2 and 80),
  details text check (details is null or length(details) <= 1000),
  resource_id uuid references public.resources(id) on delete set null,
  asset_id uuid references public.assets(id) on delete set null,
  priority text not null default 'normal' check (priority in ('low','normal','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  took_out boolean not null default false,          -- this ticket put the table out of use
  raised_by uuid,
  raised_by_name text,
  raised_at timestamptz not null default now(),
  started_at timestamptz,
  resolution text check (resolution is null or length(resolution) <= 1000),
  fixed_at timestamptz,
  cost_paise bigint not null default 0 check (cost_paise >= 0),
  expense_id uuid references public.expenses(id),
  resolved_by uuid,
  resolved_by_name text,
  resolved_at timestamptz,
  unique (centre_id, ticket_no)
);
create index tickets_centre_status_idx on public.tickets(centre_id, status, raised_at desc);
create index tickets_resource_idx on public.tickets(resource_id) where status <> 'resolved';
alter table public.tickets enable row level security;
create policy tickets_read on public.tickets for select to authenticated using (is_centre_member(centre_id));
grant select on public.tickets to authenticated;

create or replace function public._staff_name(p_centre uuid)
returns text language sql stable security definer set search_path = public as $$
  select display_name from centre_staff where centre_id = p_centre and user_id = auth.uid() limit 1;
$$;

-- Any staff member can raise a ticket. p_take_out puts the table/console out of use until it's fixed.
create or replace function public.raise_ticket(p_centre uuid, p_title text, p_details text default null, p_resource uuid default null,
  p_asset uuid default null, p_priority text default 'normal', p_take_out boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r resources; v_no int; t tickets;
begin
  perform require_perm(p_centre, 'floor.operate');
  if length(trim(coalesce(p_title,''))) < 2 then raise exception 'Say what is wrong'; end if;
  if coalesce(p_priority,'normal') not in ('low','normal','urgent') then raise exception 'Invalid priority'; end if;
  if p_resource is not null then
    select * into r from resources where id = p_resource and centre_id = p_centre and status <> 'archived' for update;
    if not found then raise exception 'Table not found'; end if;
  end if;
  if p_asset is not null and not exists (select 1 from assets where id = p_asset and centre_id = p_centre) then raise exception 'Asset not found'; end if;
  if p_take_out then
    if p_resource is null then raise exception 'Pick the table or console to take out of use'; end if;
    if exists (select 1 from sessions where resource_id = p_resource and status in ('running','paused')) then
      raise exception 'End the game on % first, then take it out of use', r.name;
    end if;
  end if;

  update centres set ticket_seq = ticket_seq + 1 where id = p_centre returning ticket_seq into v_no;
  insert into tickets(centre_id, ticket_no, title, details, resource_id, asset_id, priority, took_out, raised_by, raised_by_name)
  values (p_centre, v_no, trim(p_title), nullif(trim(coalesce(p_details,'')),''), p_resource, p_asset, coalesce(p_priority,'normal'),
    coalesce(p_take_out,false), auth.uid(), _staff_name(p_centre))
  returning * into t;
  if p_take_out then update resources set status = 'out_of_service' where id = p_resource; end if;
  if p_asset is not null then update assets set condition = 'needs_repair', updated_at = now() where id = p_asset and condition in ('good','worn'); end if;
  perform log_audit(p_centre, 'raise', 'ticket', t.id, jsonb_build_object('no', v_no, 'title', t.title, 'resource', p_resource, 'took_out', t.took_out));
  return to_jsonb(t);
end $$;

create or replace function public.start_ticket(p_centre uuid, p_ticket uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm(p_centre, 'floor.operate');
  update tickets set status = 'in_progress', started_at = coalesce(started_at, now()) where id = p_ticket and centre_id = p_centre and status = 'open';
  if not found then raise exception 'Ticket not open'; end if;
  perform log_audit(p_centre, 'start', 'ticket', p_ticket, '{}'::jsonb);
end $$;

-- Close a ticket: what was done and when. Puts the table back in use (unless another open ticket still holds it),
-- marks the asset good again, and records a repair cost as an expense when the closer may add expenses.
create or replace function public.resolve_ticket(p_centre uuid, p_ticket uuid, p_resolution text, p_fixed_at timestamptz default null,
  p_cost_paise bigint default 0, p_back_in_use boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t tickets; v_exp uuid; v_fixed timestamptz := coalesce(p_fixed_at, now());
begin
  perform require_perm(p_centre, 'floor.operate');
  select * into t from tickets where id = p_ticket and centre_id = p_centre for update;
  if not found then raise exception 'Ticket not found'; end if;
  if t.status = 'resolved' then raise exception 'This ticket is already closed'; end if;
  if length(trim(coalesce(p_resolution,''))) < 3 then raise exception 'Write what was done to fix it'; end if;
  if v_fixed > now() + interval '5 minutes' then raise exception 'The fix time can''t be in the future'; end if;
  if v_fixed < t.raised_at - interval '1 minute' then raise exception 'The fix time is before the ticket was raised'; end if;
  if coalesce(p_cost_paise,0) < 0 then raise exception 'Cost can''t be negative'; end if;
  if coalesce(p_cost_paise,0) > 0 then
    perform require_perm(p_centre, 'expenses.manage');
    insert into expenses(centre_id, category, amount_paise, expense_date, method, paid_from, description, created_by)
    values (p_centre, 'Repairs', p_cost_paise, (v_fixed at time zone (select timezone from centres where id = p_centre))::date, 'cash', 'drawer',
      format('Ticket #%s: %s', t.ticket_no, t.title), auth.uid())
    returning id into v_exp;
  end if;
  update tickets set status = 'resolved', resolution = trim(p_resolution), fixed_at = v_fixed, cost_paise = coalesce(p_cost_paise,0),
    expense_id = v_exp, resolved_by = auth.uid(), resolved_by_name = _staff_name(p_centre), resolved_at = now(),
    started_at = coalesce(started_at, v_fixed)
  where id = t.id returning * into t;
  if p_back_in_use and t.resource_id is not null
     and not exists (select 1 from tickets x where x.resource_id = t.resource_id and x.status <> 'resolved' and x.took_out) then
    update resources set status = 'active' where id = t.resource_id and status = 'out_of_service';
  end if;
  if p_back_in_use and t.asset_id is not null then
    update assets set condition = 'good', updated_at = now() where id = t.asset_id and condition = 'needs_repair';
  end if;
  perform log_audit(p_centre, 'resolve', 'ticket', t.id, jsonb_build_object('no', t.ticket_no, 'fixed_at', v_fixed, 'cost_paise', t.cost_paise,
    'resolution', t.resolution));
  return to_jsonb(t);
end $$;

-- ───────────────────────── 4. Games on each console ─────────────────────────
alter table public.resources add column games text[] not null default '{}'
  check (cardinality(games) <= 60);
alter table public.bookings add column game text check (game is null or length(game) between 1 and 40);

create or replace function public.set_resource_games(p_centre uuid, p_resource uuid, p_games text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare v text[];
begin
  perform require_perm(p_centre, 'inventory.manage');
  select coalesce(array_agg(g order by lower(g)), '{}') into v
  from (select distinct on (lower(trim(x))) trim(x) g from unnest(coalesce(p_games, '{}')) x where length(trim(x)) between 1 and 40) s;
  if cardinality(v) > 60 then raise exception 'At most 60 games per console'; end if;
  update resources set games = v where id = p_resource and centre_id = p_centre and status <> 'archived';
  if not found then raise exception 'Console not found'; end if;
  perform log_audit(p_centre, 'games', 'resource', p_resource, jsonb_build_object('games', to_jsonb(v)));
  return v;
end $$;

-- Consoles of an activity that have a game (case-insensitive). Online = only those bookable online.
create or replace function public._game_capacity(p_activity uuid, p_game text, p_online boolean)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from resources r
  where r.activity_id = p_activity and r.status = 'active' and (not p_online or r.online_bookable)
    and exists (select 1 from unnest(r.games) g where lower(g) = lower(p_game));
$$;

-- Most consoles with this game needed at once: bookings for the game + games running on consoles that have it.
create or replace function public._game_load(p_activity uuid, p_game text, p_from timestamptz, p_to timestamptz, p_skip_booking uuid default null)
returns integer language sql stable security definer set search_path = public as $$
  with c as (select c.booking_hold_minutes hold from activities a join centres c on c.id = a.centre_id where a.id = p_activity),
  iv as (
    select b.starts_at s, b.ends_at e from bookings b, c
    where b.activity_id = p_activity and b.session_id is null and b.id is distinct from p_skip_booking and lower(b.game) = lower(p_game)
      and (b.status = 'arrived' or (b.status = 'confirmed' and now() < b.starts_at + make_interval(mins => c.hold)))
      and b.starts_at < p_to and b.ends_at > p_from
    union all
    select now(), _session_expected_end(s.id) from sessions s join resources r on r.id = s.resource_id
    where s.activity_id = p_activity and s.status in ('running','paused')
      and exists (select 1 from unnest(r.games) g where lower(g) = lower(p_game))
  ),
  pts as (select greatest(s, p_from) p from iv where s < p_to and e > p_from union select p_from)
  select coalesce(max((select count(*) from iv where iv.s <= pts.p and iv.e > pts.p)), 0)::int from pts where pts.p < p_to;
$$;

create or replace function public._can_fit_game(p_activity uuid, p_game text, p_from timestamptz, p_to timestamptz, p_online boolean,
  p_skip_booking uuid default null)
returns boolean language sql stable security definer set search_path = public as $$
  select _can_fit(p_activity, p_from, p_to, p_online, p_skip_booking)
     and (p_game is null or _game_load(p_activity, p_game, p_from, p_to, p_skip_booking) + 1 <= _game_capacity(p_activity, p_game, p_online));
$$;

-- The exact game name as stored on the consoles (so "gta 6" books "GTA 6"); error if no console has it.
create or replace function public._resolve_game(p_activity uuid, p_game text)
returns text language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if nullif(trim(coalesce(p_game,'')),'') is null then return null; end if;
  select g into v from resources r, unnest(r.games) g
  where r.activity_id = p_activity and r.status = 'active' and lower(g) = lower(trim(p_game)) limit 1;
  if v is null then raise exception 'No console here has %', trim(p_game); end if;
  return v;
end $$;

create or replace function public._floor_resources(p_centre uuid, p_private boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'floor_id', r.floor_id, 'activity_id', r.activity_id, 'name', r.name, 'shape', r.shape,
    'x', r.x, 'y', r.y, 'w', r.w, 'h', r.h, 'rotation', r.rotation, 'points', r.points, 'capacity', r.capacity,
    'online_bookable', r.online_bookable, 'status', r.status, 'games', to_jsonb(r.games),
    'open_tickets', case when p_private then (select count(*) from tickets t where t.resource_id = r.id and t.status <> 'resolved') end,
    'session', (select jsonb_build_object('id', s.id, 'status', s.status, 'started_at', s.started_at, 'players', s.players,
        'planned_minutes', s.planned_minutes, 'frames', s.frames,
        'tab_id', case when p_private then s.tab_id end,
        'billable_seconds', _session_seconds(s.id, now()),
        'running_since', case when s.status = 'running' then (select max(at) from session_events e where e.session_id = s.id and e.kind in ('start','resume')) end,
        'cost_paise', case when p_private then (_price_session(s.id, now())->>'amount_paise')::bigint end,
        'customer', case when p_private then (select jsonb_build_object('id', c.id, 'name', c.full_name, 'phone', c.phone) from customers c where c.id = s.customer_id) end)
      from sessions s where s.resource_id = r.id and s.status in ('running','paused')))
    order by r.sort), '[]') from resources r where r.centre_id = p_centre and r.status <> 'archived';
$$;

create or replace function public._booking_json(b bookings, p_private boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'activity_id', b.activity_id, 'activity', a.name, 'color', a.color,
    'name', b.name, 'phone', case when p_private then b.phone else overlay(b.phone placing '••••' from greatest(length(b.phone) - 5, 1) for 4) end,
    'party_size', b.party_size, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'minutes', b.minutes,
    'status', case when b.status = 'confirmed' and now() > b.starts_at + make_interval(mins => c.booking_hold_minutes) then 'late' else b.status end,
    'source', b.source, 'estimate_paise', b.estimate_paise, 'advance_paise', b.advance_paise, 'paid_paise', b.paid_paise,
    'payment_status', b.payment_status, 'code', b.code, 'resource_id', b.resource_id,
    'resource', (select name from resources where id = b.resource_id), 'session_id', b.session_id,
    'session_status', (select status from sessions where id = b.session_id), 'note', b.note, 'game', b.game,
    'created_at', b.created_at, 'arrived_at', b.arrived_at, 'seated_at', b.seated_at)
  from activities a, centres c where a.id = b.activity_id and c.id = b.centre_id;
$$;

-- Same as before, plus the game the customer wants (optional; only consoles that have it count).
drop function public._create_booking(centres, uuid, timestamptz, int, int, text, text, text, text);
create or replace function public._create_booking(c centres, p_activity uuid, p_start timestamptz, p_minutes int, p_party int,
  p_name text, p_phone text, p_note text, p_source text, p_game text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare a activities; v_phone text := normalize_phone(p_phone); v_token text; v_est bigint; b bookings; v_customer uuid; v_cap int; v_game text;
begin
  select * into a from activities where id = p_activity and centre_id = c.id and active;
  if not found then raise exception 'Choose a game'; end if;
  if p_source = 'online' and not a.online_bookable then raise exception '% can''t be booked online. Walk in or call us.', a.name; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Enter your name'; end if;
  if v_phone is null or v_phone !~ '^\+?[0-9]{8,15}$' then raise exception 'Enter a valid phone number'; end if;
  select max(capacity) into v_cap from resources where activity_id = a.id and status = 'active';
  if coalesce(p_party, 1) < 1 or coalesce(p_party, 1) > coalesce(v_cap, 1) then raise exception 'At most % players for %', coalesce(v_cap,1), a.name; end if;
  perform _check_booking_time(c, p_start, p_minutes, p_source = 'staff');
  v_game := _resolve_game(a.id, p_game);

  if p_source = 'online' then
    if (select count(*) from bookings where centre_id = c.id and phone = v_phone and status in ('confirmed','arrived') and ends_at > now()) >= 3 then
      raise exception 'You already have 3 bookings coming up. Call us to book more.';
    end if;
    if (select count(*) from bookings where centre_id = c.id and phone = v_phone and created_at > now() - interval '10 minutes') >= 5 then
      raise exception 'Too many tries. Please wait a few minutes.';
    end if;
  end if;

  perform 1 from activities where id = a.id for update;
  if not _can_fit_game(a.id, v_game, p_start, p_start + make_interval(mins => p_minutes), p_source = 'online') then
    raise exception 'Sorry, that time was just taken. Please pick another.';
  end if;

  v_customer := _customer_by_phone(c.id, p_name, v_phone, case when p_source = 'online' then 'online' else 'phone' end);
  v_est := _booking_estimate(a.id, p_start, p_minutes, coalesce(p_party,1));
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into bookings(centre_id, activity_id, customer_id, name, phone, party_size, starts_at, ends_at, minutes, source,
    estimate_paise, advance_paise, code, token_hash, note, created_by, game)
  values (c.id, a.id, v_customer, trim(p_name), v_phone, coalesce(p_party,1), p_start, p_start + make_interval(mins => p_minutes), p_minutes,
    p_source, v_est, case when p_source = 'online' then (ceil(v_est * c.booking_advance_bp / 10000.0 / 100) * 100)::bigint else 0 end,
    _booking_code(c.id), encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), nullif(trim(coalesce(p_note,'')),''), auth.uid(), v_game)
  returning * into b;
  return jsonb_build_object('token', v_token, 'booking', _booking_json(b, false));
end $$;

create or replace function public.booking_page(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c centres := _public_centre(p_slug);
begin
  return jsonb_build_object('server_time', now(),
    'centre', jsonb_build_object('name', c.name, 'slug', c.slug, 'address', c.address, 'city', c.city, 'phone', c.phone,
      'timezone', c.timezone, 'open_time', c.open_time, 'close_time', c.close_time, 'slot_minutes', c.slot_minutes,
      'note', c.booking_note, 'advance_bp', c.booking_advance_bp, 'hold_minutes', c.booking_hold_minutes,
      'days_ahead', c.booking_days_ahead, 'durations', c.booking_durations, 'lead_minutes', c.booking_lead_minutes),
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'color', a.color, 'icon', a.icon,
        'online_tables', _activity_capacity(a.id, true), 'tables', _activity_capacity(a.id, false),
        'max_players', (select max(capacity) from resources r where r.activity_id = a.id and r.status = 'active'),
        'free_now', (select count(*) from resources r where r.activity_id = a.id and r.status = 'active'
            and not exists (select 1 from sessions s where s.resource_id = r.id and s.status in ('running','paused'))),
        -- games on the consoles bookable online, with how many consoles have each
        'games', (select coalesce(jsonb_agg(jsonb_build_object('name', g.name, 'consoles', g.n) order by lower(g.name)), '[]')
            from (select min(gx) name, count(distinct r.id) n from resources r, unnest(r.games) gx
                  where r.activity_id = a.id and r.status = 'active' and r.online_bookable group by lower(gx)) g),
        'price', (select jsonb_build_object('mode', rc.billing_mode, 'price_paise', rc.price_paise, 'slot_minutes', rc.slot_minutes,
            'per_player', rc.per_player) from rate_cards rc where rc.activity_id = a.id and rc.active))
        order by a.sort), '[]')
      from activities a where a.centre_id = c.id and a.active and a.online_bookable and _activity_capacity(a.id, true) > 0),
    'floors', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'width', f.width, 'height', f.height,
        'outline', f.outline, 'fixtures', f.fixtures) order by f.sort, f.created_at), '[]') from floors f where f.centre_id = c.id),
    'resources', (select coalesce(jsonb_agg(x - 'session' - 'open_tickets' || jsonb_build_object('busy', x->'session' <> 'null'::jsonb)), '[]')
        from jsonb_array_elements(_floor_resources(c.id, false)) x));
end $$;

drop function public.booking_slots(text, uuid, date, int, int);
create or replace function public.booking_slots(p_slug text, p_activity uuid, p_date date, p_minutes int, p_party int default 1, p_game text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c centres := _public_centre(p_slug); v_open timestamp; v_close timestamp; t timestamp; v_at timestamptz; v_out jsonb := '[]'; v_ok boolean;
  v_game text;
begin
  if not exists (select 1 from activities where id = p_activity and centre_id = c.id and active and online_bookable) then raise exception 'Choose a game'; end if;
  if coalesce(p_minutes,0) < 5 or p_minutes > 720 then raise exception 'Choose how long you want to play'; end if;
  v_game := _resolve_game(p_activity, p_game);
  v_open := p_date + c.open_time;
  v_close := p_date + c.close_time + case when c.close_time <= c.open_time then interval '1 day' else interval '0' end;
  t := v_open;
  while t + make_interval(mins => p_minutes) <= v_close loop
    v_at := t at time zone c.timezone;
    if v_at >= now() + make_interval(mins => c.booking_lead_minutes) and v_at <= now() + make_interval(days => c.booking_days_ahead + 1) then
      v_ok := _can_fit_game(p_activity, v_game, v_at, v_at + make_interval(mins => p_minutes), true);
      v_out := v_out || jsonb_build_object('at', v_at, 'local', to_char(t, 'HH24:MI'), 'free', v_ok);
    end if;
    t := t + make_interval(mins => c.slot_minutes);
  end loop;
  return jsonb_build_object('slots', v_out, 'estimate_paise', _booking_estimate(p_activity, coalesce((v_out->0->>'at')::timestamptz, now()), p_minutes, coalesce(p_party,1)),
    'advance_bp', c.booking_advance_bp);
end $$;

drop function public.create_booking(text, uuid, timestamptz, int, int, text, text, text);
create or replace function public.create_booking(p_slug text, p_activity uuid, p_starts_at timestamptz, p_minutes int,
  p_party int, p_name text, p_phone text, p_note text default null, p_game text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare c centres := _public_centre(p_slug);
begin
  if not (p_minutes = any (c.booking_durations)) then raise exception 'Choose one of the times shown'; end if;
  return _create_booking(c, p_activity, p_starts_at, p_minutes, p_party, p_name, p_phone, p_note, 'online', p_game);
end $$;

drop function public.staff_create_booking(uuid, uuid, timestamptz, int, int, text, text, text);
create or replace function public.staff_create_booking(p_centre uuid, p_activity uuid, p_starts_at timestamptz, p_minutes int,
  p_party int, p_name text, p_phone text, p_note text default null, p_game text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare c centres; v jsonb;
begin
  perform require_perm(p_centre, 'floor.operate');
  perform require_perm(p_centre, 'customers.manage');
  select * into c from centres where id = p_centre;
  v := _create_booking(c, p_activity, p_starts_at, p_minutes, p_party, p_name, p_phone, p_note, 'staff', p_game);
  perform log_audit(p_centre, 'create', 'booking', (v->'booking'->>'id')::uuid, jsonb_build_object('at', p_starts_at, 'minutes', p_minutes, 'game', v->'booking'->>'game'));
  return jsonb_build_object('token', v->>'token', 'booking', _booking_json((select b from bookings b where id = (v->'booking'->>'id')::uuid), true));
end $$;

-- Check-in: free tables now say which have the booked game; those come first.
create or replace function public.check_in_booking(p_centre uuid, p_code_or_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare b bookings; v text := trim(coalesce(p_code_or_token,'')); v_res jsonb;
begin
  perform require_perm(p_centre, 'floor.operate');
  if v ~ '/t/' then v := regexp_replace(v, '^.*/t/([A-Za-z0-9]+).*$', '\1'); end if;
  if length(v) <= 8 then
    select * into b from bookings where centre_id = p_centre and code = upper(v) and status in ('confirmed','arrived') for update;
  else
    select * into b from bookings where centre_id = p_centre and token_hash = encode(sha256(convert_to(v, 'UTF8')), 'hex') for update;
  end if;
  if not found then raise exception 'No booking found for that code'; end if;
  if b.status in ('cancelled','no_show') then raise exception 'This booking was %', replace(b.status, '_', '-'); end if;
  if b.status = 'confirmed' then
    if b.starts_at > now() + interval '3 hours' then
      raise exception 'This booking is for %', to_char(b.starts_at at time zone (select timezone from centres where id = p_centre), 'FMDD Mon, FMHH12:MI AM');
    end if;
    update bookings set status = 'arrived', arrived_at = now() where id = b.id returning * into b;
  end if;
  select jsonb_agg(x.j order by x.has_game desc, x.sort) into v_res from (
    select jsonb_build_object('id', r.id, 'name', r.name, 'capacity', r.capacity, 'games', to_jsonb(r.games),
        'has_game', b.game is not null and exists (select 1 from unnest(r.games) g where lower(g) = lower(b.game))) j,
      (b.game is not null and exists (select 1 from unnest(r.games) g where lower(g) = lower(b.game))) has_game, r.sort
    from resources r where r.activity_id = b.activity_id and r.status = 'active'
      and not exists (select 1 from sessions s where s.resource_id = r.id and s.status in ('running','paused'))) x;
  return jsonb_build_object('booking', _booking_json(b, true), 'free_tables', coalesce(v_res, '[]'::jsonb),
    'balance_paise', greatest(b.estimate_paise - b.paid_paise, 0));
end $$;

-- ───────────────────────── Grants ─────────────────────────
revoke execute on all functions in schema public from public, anon;
revoke execute on function public.set_centre_addon(uuid, text, boolean) from authenticated;
grant execute on function public.set_centre_addon(uuid, text, boolean) to service_role;
grant execute on function public.save_asset(uuid, jsonb), public.raise_ticket(uuid, text, text, uuid, uuid, text, boolean),
  public.start_ticket(uuid, uuid), public.resolve_ticket(uuid, uuid, text, timestamptz, bigint, boolean),
  public.set_resource_games(uuid, uuid, text[]), public.staff_create_booking(uuid, uuid, timestamptz, int, int, text, text, text, text),
  public.check_in_booking(uuid, text), public.centre_context(text), public.has_feature(uuid, text), public.mark_guide_seen(uuid) to authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int,text),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
