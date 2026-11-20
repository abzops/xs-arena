-- XS Arena — Day 2a: activities, floors, bookable resources (tables / consoles / tracks) and versioned rate cards.
-- The floor designer (Day 3) writes through save_floor(); the live floor (Day 4) reads floor_state().

-- ───────────────────────── Activities ─────────────────────────
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  kind text not null default 'table' check (kind in ('table','console','track','other')),
  icon text not null default 'circle',
  color text not null default '#2A78D6',
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (centre_id, name)
);
create index activities_centre_idx on public.activities(centre_id, sort);

-- ───────────────────────── Floors ─────────────────────────
-- Geometry is in floor units (1 unit ≈ 1 cm by convention). outline = polygon [[x,y],...];
-- fixtures = non-bookable things (counter, entrance, café, toilet, wall): [{id,type,label,x,y,w,h,rotation}].
create table public.floors (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  name text not null default 'Main hall' check (length(trim(name)) between 1 and 40),
  width integer not null default 2000 check (width between 200 and 20000),
  height integer not null default 1200 check (height between 200 and 20000),
  outline jsonb not null default '[]' check (jsonb_typeof(outline) = 'array'),
  fixtures jsonb not null default '[]' check (jsonb_typeof(fixtures) = 'array'),
  sort integer not null default 0,
  version integer not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index floors_centre_idx on public.floors(centre_id, sort);

-- A bookable thing placed on a floor.
create table public.resources (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  floor_id uuid not null references public.floors(id) on delete restrict,
  activity_id uuid not null references public.activities(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 40),
  shape text not null default 'rect' check (shape in ('rect','round','polygon')),
  x numeric(9,1) not null default 0,
  y numeric(9,1) not null default 0,
  w numeric(9,1) not null default 200 check (w > 0),
  h numeric(9,1) not null default 100 check (h > 0),
  rotation numeric(5,1) not null default 0,
  points jsonb check (points is null or jsonb_typeof(points) = 'array'),
  capacity integer not null default 4 check (capacity between 1 and 50),
  online_bookable boolean not null default true,
  status text not null default 'active' check (status in ('active','out_of_service','archived')),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index resources_centre_idx on public.resources(centre_id, status);
create index resources_floor_idx on public.resources(floor_id);
create unique index resources_name_uq on public.resources(centre_id, lower(name)) where status <> 'archived';

-- ───────────────────────── Rate cards (versioned) ─────────────────────────
-- Never edited: saving prices inserts a new version and retires the old one, so old bills keep their prices.
-- price_paise meaning by mode: per_minute / hourly_block = price per hour; per_frame = per frame; per_slot = per slot.
-- time_rules: [{"label":"Peak","days":[5,6,0],"start":"18:00","end":"23:00","price_paise":30000}] (0 = Sunday)
-- addons:     [{"code":"controller","name":"Extra controller","price_paise":3000,"per":"hour"|"session"}]
create table public.rate_cards (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  version integer not null,
  billing_mode text not null default 'per_minute' check (billing_mode in ('per_minute','hourly_block','per_frame','per_slot')),
  price_paise bigint not null check (price_paise >= 0),
  block_minutes integer not null default 30 check (block_minutes between 5 and 240),
  slot_minutes integer not null default 15 check (slot_minutes between 5 and 240),
  min_minutes integer not null default 0 check (min_minutes between 0 and 240),
  grace_minutes integer not null default 0 check (grace_minutes between 0 and 60),
  overtime_price_paise bigint check (overtime_price_paise is null or overtime_price_paise >= 0),
  per_player boolean not null default false,
  included_players integer not null default 1 check (included_players between 1 and 50),
  extra_player_paise bigint not null default 0 check (extra_player_paise >= 0),
  time_rules jsonb not null default '[]' check (jsonb_typeof(time_rules) = 'array'),
  addons jsonb not null default '[]' check (jsonb_typeof(addons) = 'array'),
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (activity_id, version)
);
create unique index rate_cards_active_uq on public.rate_cards(activity_id) where active;
create index rate_cards_centre_idx on public.rate_cards(centre_id);

-- ───────────────────────── RLS ─────────────────────────
alter table public.activities enable row level security;
alter table public.floors enable row level security;
alter table public.resources enable row level security;
alter table public.rate_cards enable row level security;
create policy activities_read on public.activities for select to authenticated using (is_centre_member(centre_id));
create policy floors_read on public.floors for select to authenticated using (is_centre_member(centre_id));
create policy resources_read on public.resources for select to authenticated using (is_centre_member(centre_id));
create policy rate_cards_read on public.rate_cards for select to authenticated using (is_centre_member(centre_id));
grant select on public.activities, public.floors, public.resources, public.rate_cards to authenticated;

-- ───────────────────────── Defaults ─────────────────────────
-- Five starter activities with sensible Kerala prices; owners edit them later.
create or replace function public._seed_activities(p_centre uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  if exists (select 1 from activities where centre_id = p_centre) then return; end if;
  insert into activities(centre_id, name, kind, icon, color, sort) values (p_centre, 'Snooker', 'table', 'snooker', '#1BAF7A', 1) returning id into a;
  insert into rate_cards(centre_id, activity_id, version, billing_mode, price_paise, min_minutes, grace_minutes, per_player, included_players)
    values (p_centre, a, 1, 'per_minute', 20000, 30, 5, false, 4);
  insert into activities(centre_id, name, kind, icon, color, sort) values (p_centre, 'Pool', 'table', 'pool', '#2A78D6', 2) returning id into a;
  insert into rate_cards(centre_id, activity_id, version, billing_mode, price_paise, min_minutes, grace_minutes, per_player, included_players)
    values (p_centre, a, 1, 'per_minute', 15000, 30, 5, false, 4);
  insert into activities(centre_id, name, kind, icon, color, sort) values (p_centre, 'PS5', 'console', 'gamepad', '#9B5DE5', 3) returning id into a;
  insert into rate_cards(centre_id, activity_id, version, billing_mode, price_paise, min_minutes, grace_minutes, per_player, included_players, extra_player_paise, addons)
    values (p_centre, a, 1, 'per_minute', 12000, 30, 5, false, 2, 3000,
      '[{"code":"controller","name":"Extra controller","price_paise":3000,"per":"hour"}]');
  insert into activities(centre_id, name, kind, icon, color, sort) values (p_centre, 'RC Drift', 'track', 'car', '#EB6834', 4) returning id into a;
  insert into rate_cards(centre_id, activity_id, version, billing_mode, price_paise, slot_minutes, per_player, included_players)
    values (p_centre, a, 1, 'per_slot', 15000, 15, true, 1);
  insert into activities(centre_id, name, kind, icon, color, sort) values (p_centre, 'RC Offroad', 'track', 'mountain', '#EDA100', 5) returning id into a;
  insert into rate_cards(centre_id, activity_id, version, billing_mode, price_paise, slot_minutes, per_player, included_players)
    values (p_centre, a, 1, 'per_slot', 15000, 15, true, 1);
  insert into floors(centre_id, name, width, height, outline)
    values (p_centre, 'Main hall', 2000, 1200, '[[0,0],[2000,0],[2000,1200],[0,1200]]');
end $$;
revoke execute on function public._seed_activities(uuid) from public, anon, authenticated;

-- New centres get the starter activities, prices and an empty main hall.
create or replace function public._centre_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform _seed_activities(new.id); return new; end $$;
create trigger centres_defaults after insert on public.centres for each row execute function public._centre_defaults();

-- Existing centres (e.g. the demo centre) get them too.
do $$ declare c uuid; begin for c in select id from public.centres loop perform public._seed_activities(c); end loop; end $$;

-- ───────────────────────── Prices (versioned save) ─────────────────────────
create or replace function public.save_rate_card(p_centre uuid, p_activity uuid, p_card jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_ver int; r jsonb;
begin
  perform require_perm(p_centre, 'pricing.manage');
  if not exists (select 1 from activities where id = p_activity and centre_id = p_centre) then raise exception 'Activity not found'; end if;
  -- validate time rules
  for r in select * from jsonb_array_elements(coalesce(p_card->'time_rules','[]')) loop
    if (r->>'start') !~ '^\d{2}:\d{2}$' or (r->>'end') !~ '^\d{2}:\d{2}$' or coalesce((r->>'price_paise')::bigint,-1) < 0
       or jsonb_typeof(r->'days') <> 'array' then
      raise exception 'Each special price needs days, a start, an end and a price';
    end if;
  end loop;
  select coalesce(max(version),0) + 1 into v_ver from rate_cards where activity_id = p_activity;
  update rate_cards set active = false where activity_id = p_activity and active;
  insert into rate_cards(centre_id, activity_id, version, billing_mode, price_paise, block_minutes, slot_minutes, min_minutes, grace_minutes,
    overtime_price_paise, per_player, included_players, extra_player_paise, time_rules, addons, created_by)
  values (p_centre, p_activity, v_ver,
    coalesce(p_card->>'billing_mode','per_minute'), coalesce((p_card->>'price_paise')::bigint, 0),
    coalesce((p_card->>'block_minutes')::int, 30), coalesce((p_card->>'slot_minutes')::int, 15),
    coalesce((p_card->>'min_minutes')::int, 0), coalesce((p_card->>'grace_minutes')::int, 0),
    nullif(p_card->>'overtime_price_paise','')::bigint, coalesce((p_card->>'per_player')::boolean, false),
    coalesce((p_card->>'included_players')::int, 1), coalesce((p_card->>'extra_player_paise')::bigint, 0),
    coalesce(p_card->'time_rules','[]'), coalesce(p_card->'addons','[]'), auth.uid())
  returning id into v_id;
  perform log_audit(p_centre, 'price_change', 'rate_card', v_id, jsonb_build_object('activity', p_activity, 'version', v_ver, 'card', p_card));
  return v_id;
end $$;

create or replace function public.save_activity(p_centre uuid, p_activity uuid, p_name text, p_kind text,
  p_icon text default 'circle', p_color text default '#2A78D6', p_active boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform require_perm(p_centre, 'pricing.manage');
  if p_activity is null then
    insert into activities(centre_id, name, kind, icon, color, active, sort)
    values (p_centre, trim(p_name), p_kind, coalesce(p_icon,'circle'), coalesce(p_color,'#2A78D6'), coalesce(p_active,true),
      (select coalesce(max(sort),0)+1 from activities where centre_id = p_centre))
    returning id into v_id;
    insert into rate_cards(centre_id, activity_id, version, price_paise, created_by) values (p_centre, v_id, 1, 0, auth.uid());
  else
    update activities set name = trim(p_name), kind = p_kind, icon = coalesce(p_icon, icon), color = coalesce(p_color, color),
      active = coalesce(p_active, active)
    where id = p_activity and centre_id = p_centre returning id into v_id;
    if v_id is null then raise exception 'Activity not found'; end if;
  end if;
  perform log_audit(p_centre, case when p_activity is null then 'create' else 'update' end, 'activity', v_id, jsonb_build_object('name', p_name));
  return v_id;
end $$;

-- ───────────────────────── Floor designer save ─────────────────────────
-- p_floor: {id?, name, width, height, outline, fixtures, sort, version?,
--           resources: [{id?, activity_id, name, shape, x, y, w, h, rotation, points, capacity, online_bookable, status}]}
-- Resources missing from the list are archived (never deleted), unless a session is running on them.
-- If version is given and doesn't match, someone else saved first → error instead of overwriting.
create or replace function public.save_floor(p_centre uuid, p_floor jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_floor uuid := nullif(p_floor->>'id','')::uuid; v_old floors; r jsonb; v_keep uuid[] := '{}'; v_rid uuid; v_ver int;
begin
  perform require_perm(p_centre, 'floor.design');
  if v_floor is null then
    insert into floors(centre_id, name, width, height, outline, fixtures, sort, updated_by)
    values (p_centre, coalesce(nullif(trim(p_floor->>'name'),''),'Main hall'), coalesce((p_floor->>'width')::int,2000),
      coalesce((p_floor->>'height')::int,1200), coalesce(p_floor->'outline','[]'), coalesce(p_floor->'fixtures','[]'),
      coalesce((p_floor->>'sort')::int, (select coalesce(max(sort),0)+1 from floors where centre_id = p_centre)), auth.uid())
    returning id, version into v_floor, v_ver;
  else
    select * into v_old from floors where id = v_floor and centre_id = p_centre for update;
    if not found then raise exception 'Floor not found'; end if;
    if p_floor ? 'version' and (p_floor->>'version')::int <> v_old.version then
      raise exception 'This floor was changed by someone else. Reload to see the latest layout.';
    end if;
    update floors set name = coalesce(nullif(trim(p_floor->>'name'),''), name), width = coalesce((p_floor->>'width')::int, width),
      height = coalesce((p_floor->>'height')::int, height), outline = coalesce(p_floor->'outline', outline),
      fixtures = coalesce(p_floor->'fixtures', fixtures), sort = coalesce((p_floor->>'sort')::int, sort),
      version = version + 1, updated_by = auth.uid(), updated_at = now()
    where id = v_floor returning version into v_ver;
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_floor->'resources','[]')) loop
    if not exists (select 1 from activities where id = (r->>'activity_id')::uuid and centre_id = p_centre) then
      raise exception 'Unknown activity for %', coalesce(r->>'name','an item');
    end if;
    v_rid := nullif(r->>'id','')::uuid;
    if v_rid is not null and exists (select 1 from resources where id = v_rid and centre_id = p_centre) then
      update resources set floor_id = v_floor, activity_id = (r->>'activity_id')::uuid, name = trim(r->>'name'),
        shape = coalesce(r->>'shape', shape), x = coalesce((r->>'x')::numeric, x), y = coalesce((r->>'y')::numeric, y),
        w = coalesce((r->>'w')::numeric, w), h = coalesce((r->>'h')::numeric, h), rotation = coalesce((r->>'rotation')::numeric, rotation),
        points = case when r ? 'points' then r->'points' else points end, capacity = coalesce((r->>'capacity')::int, capacity),
        online_bookable = coalesce((r->>'online_bookable')::boolean, online_bookable),
        status = case when coalesce(r->>'status','active') = 'out_of_service' then 'out_of_service' else 'active' end
      where id = v_rid;
    else
      insert into resources(id, centre_id, floor_id, activity_id, name, shape, x, y, w, h, rotation, points, capacity, online_bookable, sort)
      values (coalesce(v_rid, gen_random_uuid()), p_centre, v_floor, (r->>'activity_id')::uuid, trim(r->>'name'), coalesce(r->>'shape','rect'),
        coalesce((r->>'x')::numeric,0), coalesce((r->>'y')::numeric,0), coalesce((r->>'w')::numeric,200), coalesce((r->>'h')::numeric,100),
        coalesce((r->>'rotation')::numeric,0), r->'points', coalesce((r->>'capacity')::int,4), coalesce((r->>'online_bookable')::boolean,true),
        (select coalesce(max(sort),0)+1 from resources where centre_id = p_centre))
      returning id into v_rid;
    end if;
    v_keep := v_keep || v_rid;
  end loop;

  -- archive what the designer removed from this floor
  if p_floor ? 'resources' then
    if exists (select 1 from resources r join sessions s on s.resource_id = r.id and s.status in ('running','paused')
               where r.floor_id = v_floor and r.status <> 'archived' and not (r.id = any(v_keep))) then
      raise exception 'A table you removed has a game running. End it first.';
    end if;
    update resources set status = 'archived' where floor_id = v_floor and status <> 'archived' and not (id = any(v_keep));
  end if;
  perform log_audit(p_centre, 'save', 'floor', v_floor, jsonb_build_object('version', v_ver, 'resources', array_length(v_keep,1)));
  return jsonb_build_object('floor_id', v_floor, 'version', v_ver);
end $$;
