-- XS Arena — Phase 2: online booking, availability engine, QR check-in, smart extensions.
--
-- Booking model: a customer books an ACTIVITY + time ("any pool table, 6:30, 1 hr"), never a specific table.
-- The table is chosen when staff seat them (hotel-room model), so an extension on one table never breaks a booking.
--
-- Availability rule (one engine for booking, extending and "free until"):
--   At every moment of a time window, live games + held bookings + 1 must fit in the activity's tables.
--   Online bookings also must fit in (online tables − walk-in reserve), so some tables always stay for walk-ins.
--   Paid / confirmed bookings always win over extensions.

-- ───────────────────────── Settings ─────────────────────────
alter table public.centres
  add column booking_advance_bp integer not null default 2000 check (booking_advance_bp between 0 and 10000),
  add column booking_hold_minutes integer not null default 15 check (booking_hold_minutes between 0 and 120),
  add column booking_days_ahead integer not null default 7 check (booking_days_ahead between 0 and 60),
  add column booking_durations integer[] not null default '{30,60,90,120}',
  add column booking_lead_minutes integer not null default 15 check (booking_lead_minutes between 0 and 1440),
  add column open_timer_assume_minutes integer not null default 60 check (open_timer_assume_minutes between 15 and 480);

-- Tables of this activity kept for walk-ins only (never given to online bookings).
alter table public.activities
  add column walkin_reserve integer not null default 0 check (walkin_reserve between 0 and 100),
  add column online_bookable boolean not null default true;

-- ───────────────────────── Bookings ─────────────────────────
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  activity_id uuid not null references public.activities(id),
  customer_id uuid references public.customers(id),
  name text not null check (length(trim(name)) between 1 and 80),
  phone text not null,
  party_size integer not null default 1 check (party_size between 1 and 50),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  minutes integer not null check (minutes between 5 and 720),
  status text not null default 'confirmed'
    check (status in ('confirmed','arrived','seated','cancelled','no_show')),
  source text not null default 'online' check (source in ('online','staff')),
  estimate_paise bigint not null default 0 check (estimate_paise >= 0),
  advance_paise bigint not null default 0 check (advance_paise >= 0),
  paid_paise bigint not null default 0 check (paid_paise >= 0),
  payment_status text not null default 'pay_at_counter' check (payment_status in ('pay_at_counter','pending','paid','refunded')),
  code text not null,                     -- 6 characters, read out or typed at the counter
  token_hash text not null unique,        -- sha256 of the secret in the ticket link / QR
  resource_id uuid references public.resources(id),
  session_id uuid references public.sessions(id),
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  arrived_at timestamptz,
  seated_at timestamptz,
  cancelled_at timestamptz,
  check (ends_at > starts_at)
);
create index bookings_centre_time_idx on public.bookings(centre_id, starts_at);
create index bookings_activity_live_idx on public.bookings(activity_id, starts_at) where status in ('confirmed','arrived');
create unique index bookings_code_live_uq on public.bookings(centre_id, code) where status in ('confirmed','arrived');
create index bookings_phone_idx on public.bookings(centre_id, phone, created_at desc);

alter table public.bookings enable row level security;
create policy bookings_read on public.bookings for select to authenticated using (is_centre_member(centre_id));
grant select on public.bookings to authenticated;

-- ───────────────────────── Availability engine ─────────────────────────
-- Tables an activity has. Online: only tables marked bookable online, minus the walk-in reserve.
create or replace function public._activity_capacity(p_activity uuid, p_online boolean)
returns integer language sql stable security definer set search_path = public as $$
  select case when p_online then
      case when a.online_bookable then greatest(0,
        (select count(*) from resources r where r.activity_id = a.id and r.status = 'active' and r.online_bookable)::int - a.walkin_reserve)
      else 0 end
    else (select count(*) from resources r where r.activity_id = a.id and r.status = 'active')::int end
  from activities a where a.id = p_activity;
$$;

-- Expected end of a live game: planned time left, or an assumed hour for open timers. Never before now.
create or replace function public._session_expected_end(p_session uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select now() + make_interval(secs => greatest(60,
      case when s.planned_minutes is null then c.open_timer_assume_minutes * 60
           else s.planned_minutes * 60 - _session_seconds(s.id, now()) end))
  from sessions s join centres c on c.id = s.centre_id where s.id = p_session;
$$;

-- Most tables needed at any one moment in [p_from, p_to).
-- p_bookings_only = count online-held bookings only (for the walk-in reserve rule).
create or replace function public._activity_load(p_activity uuid, p_from timestamptz, p_to timestamptz,
  p_skip_booking uuid default null, p_skip_session uuid default null, p_bookings_only boolean default false)
returns integer language sql stable security definer set search_path = public as $$
  with c as (select c.booking_hold_minutes hold from activities a join centres c on c.id = a.centre_id where a.id = p_activity),
  iv as (
    -- bookings still holding a table: arrived, or confirmed and not past the hold time
    select b.starts_at s, b.ends_at e from bookings b, c
    where b.activity_id = p_activity and b.session_id is null and b.id is distinct from p_skip_booking
      and (b.status = 'arrived' or (b.status = 'confirmed' and now() < b.starts_at + make_interval(mins => c.hold)))
      and b.starts_at < p_to and b.ends_at > p_from
    union all
    select now(), _session_expected_end(s.id) from sessions s
    where not p_bookings_only and s.activity_id = p_activity and s.status in ('running','paused') and s.id is distinct from p_skip_session
  ),
  pts as (select greatest(s, p_from) p from iv where s < p_to and e > p_from union select p_from)
  select coalesce(max((select count(*) from iv where iv.s <= pts.p and iv.e > pts.p)), 0)::int from pts where pts.p < p_to;
$$;

-- Can one more party use this activity for the whole window?
create or replace function public._can_fit(p_activity uuid, p_from timestamptz, p_to timestamptz, p_online boolean,
  p_skip_booking uuid default null, p_skip_session uuid default null)
returns boolean language sql stable security definer set search_path = public as $$
  select _activity_load(p_activity, p_from, p_to, p_skip_booking, p_skip_session, false) + 1 <= _activity_capacity(p_activity, false)
     and (not p_online or _activity_load(p_activity, p_from, p_to, p_skip_booking, p_skip_session, true) + 1 <= _activity_capacity(p_activity, true));
$$;

-- When must a table that is free now be given up for bookings? null = free for the next 24 h.
create or replace function public._free_until(p_activity uuid)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare t timestamptz; v_cap int := _activity_capacity(p_activity, false);
begin
  for t in select distinct b.starts_at from bookings b
           where b.activity_id = p_activity and b.session_id is null and b.status in ('confirmed','arrived')
             and b.ends_at > now() and b.starts_at < now() + interval '24 hours' order by 1 loop
    if _activity_load(p_activity, greatest(t, now()), greatest(t, now()) + interval '1 second') >= v_cap then return greatest(t, now()); end if;
  end loop;
  return null;
end $$;

-- Rough price for a booking (shown to the customer and used for the advance). Final price comes from the timer.
create or replace function public._booking_estimate(p_activity uuid, p_at timestamptz, p_minutes int, p_party int)
returns bigint language plpgsql stable security definer set search_path = public as $$
declare rc rate_cards; v_tz text; v_price bigint; v_amount numeric;
begin
  select * into rc from rate_cards where activity_id = p_activity and active;
  if not found then return 0; end if;
  select c.timezone into v_tz from centres c where c.id = rc.centre_id;
  v_price := (_rate_at(rc, v_tz, p_at)).price;
  v_amount := case rc.billing_mode
    when 'per_slot' then v_price * ceil(p_minutes::numeric / rc.slot_minutes)
    when 'per_frame' then v_price
    else v_price * p_minutes / 60.0 end;
  if rc.per_player then
    v_amount := v_amount * greatest(p_party, 1);
  elsif p_party > rc.included_players then
    v_amount := v_amount + rc.extra_player_paise * (p_party - rc.included_players) *
      case when rc.billing_mode in ('per_minute','hourly_block') then p_minutes / 60.0 else 1 end;
  end if;
  return (round(v_amount / 100) * 100)::bigint;
end $$;

-- ───────────────────────── Helpers ─────────────────────────
create or replace function public._booking_code(p_centre uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare a text := 'ACDEFGHJKMNPQRTUVWXY3479'; v text; i int; n int := 0;
begin
  loop
    v := ''; for i in 1..6 loop v := v || substr(a, 1 + floor(random() * length(a))::int, 1); end loop;
    exit when not exists (select 1 from bookings where centre_id = p_centre and code = v and status in ('confirmed','arrived'));
    n := n + 1; if n > 30 then raise exception 'Try again'; end if;
  end loop;
  return v;
end $$;

create or replace function public._booking_json(b bookings, p_private boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'activity_id', b.activity_id, 'activity', a.name, 'color', a.color,
    'name', b.name, 'phone', case when p_private then b.phone else overlay(b.phone placing '••••' from greatest(length(b.phone) - 5, 1) for 4) end,
    'party_size', b.party_size, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'minutes', b.minutes,
    'status', case when b.status = 'confirmed' and now() > b.starts_at + make_interval(mins => c.booking_hold_minutes) then 'late' else b.status end,
    'source', b.source, 'estimate_paise', b.estimate_paise, 'advance_paise', b.advance_paise, 'paid_paise', b.paid_paise,
    'payment_status', b.payment_status, 'code', b.code, 'resource_id', b.resource_id,
    'resource', (select name from resources where id = b.resource_id), 'session_id', b.session_id,
    'session_status', (select status from sessions where id = b.session_id), 'note', b.note,
    'created_at', b.created_at, 'arrived_at', b.arrived_at, 'seated_at', b.seated_at)
  from activities a, centres c where a.id = b.activity_id and c.id = b.centre_id;
$$;

-- Check a requested time against opening hours, notice and how far ahead booking is open.
create or replace function public._check_booking_time(c centres, p_start timestamptz, p_minutes int, p_staff boolean)
returns void language plpgsql stable set search_path = public as $$
declare v_local timestamp := p_start at time zone c.timezone; v_day date := v_local::date; v_open timestamp; v_close timestamp;
begin
  if coalesce(p_minutes, 0) < 5 or p_minutes > 720 then raise exception 'Choose how long you want to play'; end if;
  if p_start < now() - interval '5 minutes' then raise exception 'That time has passed'; end if;
  if not p_staff then
    if p_start < now() + make_interval(mins => c.booking_lead_minutes) then
      raise exception 'Book at least % minutes ahead', c.booking_lead_minutes;
    end if;
    if p_start > now() + make_interval(days => c.booking_days_ahead + 1) then
      raise exception 'Bookings open % days ahead', c.booking_days_ahead;
    end if;
  end if;
  -- opening hours; a close time at or before the open time means "after midnight"
  if v_local::time < c.open_time and c.close_time <= c.open_time then v_day := v_day - 1; end if;
  v_open := v_day + c.open_time;
  v_close := v_day + c.close_time + case when c.close_time <= c.open_time then interval '1 day' else interval '0' end;
  if v_local < v_open or v_local + make_interval(mins => p_minutes) > v_close then
    raise exception 'We are open % to %', to_char(c.open_time, 'FMHH12:MI AM'), to_char(c.close_time, 'FMHH12:MI AM');
  end if;
end $$;

-- Creates the booking after every check. Returns the booking and the secret ticket token.
create or replace function public._create_booking(c centres, p_activity uuid, p_start timestamptz, p_minutes int, p_party int,
  p_name text, p_phone text, p_note text, p_source text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare a activities; v_phone text := normalize_phone(p_phone); v_token text; v_est bigint; b bookings; v_customer uuid; v_cap int;
begin
  select * into a from activities where id = p_activity and centre_id = c.id and active;
  if not found then raise exception 'Choose a game'; end if;
  if p_source = 'online' and not a.online_bookable then raise exception '% can''t be booked online. Walk in or call us.', a.name; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Enter your name'; end if;
  if v_phone is null or v_phone !~ '^\+?[0-9]{8,15}$' then raise exception 'Enter a valid phone number'; end if;
  select max(capacity) into v_cap from resources where activity_id = a.id and status = 'active';
  if coalesce(p_party, 1) < 1 or coalesce(p_party, 1) > coalesce(v_cap, 1) then raise exception 'At most % players for %', coalesce(v_cap,1), a.name; end if;
  perform _check_booking_time(c, p_start, p_minutes, p_source = 'staff');

  -- stop one phone from filling the floor
  if p_source = 'online' then
    if (select count(*) from bookings where centre_id = c.id and phone = v_phone and status in ('confirmed','arrived') and ends_at > now()) >= 3 then
      raise exception 'You already have 3 bookings coming up. Call us to book more.';
    end if;
    if (select count(*) from bookings where centre_id = c.id and phone = v_phone and created_at > now() - interval '10 minutes') >= 5 then
      raise exception 'Too many tries. Please wait a few minutes.';
    end if;
  end if;

  -- serialise bookings per activity so two people can't take the last table at once
  perform 1 from activities where id = a.id for update;
  if not _can_fit(a.id, p_start, p_start + make_interval(mins => p_minutes), p_source = 'online') then
    raise exception 'Sorry, that time was just taken. Please pick another.';
  end if;

  v_customer := _customer_by_phone(c.id, p_name, v_phone, case when p_source = 'online' then 'online' else 'phone' end);
  v_est := _booking_estimate(a.id, p_start, p_minutes, coalesce(p_party,1));
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into bookings(centre_id, activity_id, customer_id, name, phone, party_size, starts_at, ends_at, minutes, source,
    estimate_paise, advance_paise, code, token_hash, note, created_by)
  values (c.id, a.id, v_customer, trim(p_name), v_phone, coalesce(p_party,1), p_start, p_start + make_interval(mins => p_minutes), p_minutes,
    p_source, v_est, case when p_source = 'online' then (ceil(v_est * c.booking_advance_bp / 10000.0 / 100) * 100)::bigint else 0 end,
    _booking_code(c.id), encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), nullif(trim(coalesce(p_note,'')),''), auth.uid())
  returning * into b;
  return jsonb_build_object('token', v_token, 'booking', _booking_json(b, false));
end $$;

-- ───────────────────────── Public (no sign-in) ─────────────────────────
create or replace function public._public_centre(p_slug text)
returns centres language plpgsql stable security definer set search_path = public as $$
declare c centres;
begin
  select * into c from centres where slug = lower(trim(p_slug)) and status = 'active';
  if not found or not c.booking_enabled or not has_feature(c.id, 'online_booking') then
    raise exception 'Online booking is not open for this centre';
  end if;
  return c;
end $$;

-- Everything the booking page needs: centre, games with prices and online tables, live floor (no names).
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
        'price', (select jsonb_build_object('mode', rc.billing_mode, 'price_paise', rc.price_paise, 'slot_minutes', rc.slot_minutes,
            'per_player', rc.per_player) from rate_cards rc where rc.activity_id = a.id and rc.active))
        order by a.sort), '[]')
      from activities a where a.centre_id = c.id and a.active and a.online_bookable and _activity_capacity(a.id, true) > 0),
    'floors', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'width', f.width, 'height', f.height,
        'outline', f.outline, 'fixtures', f.fixtures) order by f.sort, f.created_at), '[]') from floors f where f.centre_id = c.id),
    'resources', (select coalesce(jsonb_agg(x - 'session' || jsonb_build_object('busy', x->'session' <> 'null'::jsonb)), '[]')
        from jsonb_array_elements(_floor_resources(c.id, false)) x));
end $$;

-- Start times for one game on one day, each marked free or full.
create or replace function public.booking_slots(p_slug text, p_activity uuid, p_date date, p_minutes int, p_party int default 1)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c centres := _public_centre(p_slug); v_open timestamp; v_close timestamp; t timestamp; v_at timestamptz; v_out jsonb := '[]'; v_ok boolean;
begin
  if not exists (select 1 from activities where id = p_activity and centre_id = c.id and active and online_bookable) then raise exception 'Choose a game'; end if;
  if coalesce(p_minutes,0) < 5 or p_minutes > 720 then raise exception 'Choose how long you want to play'; end if;
  v_open := p_date + c.open_time;
  v_close := p_date + c.close_time + case when c.close_time <= c.open_time then interval '1 day' else interval '0' end;
  t := v_open;
  while t + make_interval(mins => p_minutes) <= v_close loop
    v_at := t at time zone c.timezone;
    if v_at >= now() + make_interval(mins => c.booking_lead_minutes) and v_at <= now() + make_interval(days => c.booking_days_ahead + 1) then
      v_ok := _can_fit(p_activity, v_at, v_at + make_interval(mins => p_minutes), true);
      v_out := v_out || jsonb_build_object('at', v_at, 'local', to_char(t, 'HH24:MI'), 'free', v_ok);
    end if;
    t := t + make_interval(mins => c.slot_minutes);
  end loop;
  return jsonb_build_object('slots', v_out, 'estimate_paise', _booking_estimate(p_activity, coalesce((v_out->0->>'at')::timestamptz, now()), p_minutes, coalesce(p_party,1)),
    'advance_bp', c.booking_advance_bp);
end $$;

create or replace function public.create_booking(p_slug text, p_activity uuid, p_starts_at timestamptz, p_minutes int,
  p_party int, p_name text, p_phone text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare c centres := _public_centre(p_slug);
begin
  if not (p_minutes = any (c.booking_durations)) then raise exception 'Choose one of the times shown'; end if;
  return _create_booking(c, p_activity, p_starts_at, p_minutes, p_party, p_name, p_phone, p_note, 'online');
end $$;

-- The ticket page (/t/<token>): only someone with the link can see it.
create or replace function public.booking_ticket(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b bookings; c centres;
begin
  select * into b from bookings where token_hash = encode(sha256(convert_to(coalesce(p_token,''), 'UTF8')), 'hex');
  if not found then raise exception 'Booking not found'; end if;
  select * into c from centres where id = b.centre_id;
  return jsonb_build_object('booking', _booking_json(b, false),
    'centre', jsonb_build_object('name', c.name, 'slug', c.slug, 'address', c.address, 'city', c.city, 'phone', c.phone,
      'timezone', c.timezone, 'hold_minutes', c.booking_hold_minutes, 'upi_id', c.upi_id),
    'can_cancel', b.status = 'confirmed' and b.starts_at > now() + interval '1 hour');
end $$;

create or replace function public.cancel_booking_by_token(p_token text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare b bookings;
begin
  select * into b from bookings where token_hash = encode(sha256(convert_to(coalesce(p_token,''), 'UTF8')), 'hex') for update;
  if not found then raise exception 'Booking not found'; end if;
  if b.status <> 'confirmed' then raise exception 'This booking can''t be cancelled now'; end if;
  if b.starts_at <= now() + interval '1 hour' then raise exception 'Call the centre to cancel within 1 hour of your time'; end if;
  update bookings set status = 'cancelled', cancelled_at = now() where id = b.id;
  perform log_audit(b.centre_id, 'cancel', 'booking', b.id, jsonb_build_object('by', 'customer'));
end $$;

-- ───────────────────────── Staff ─────────────────────────
create or replace function public.bookings_for_day(p_centre uuid, p_date date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c centres; v_from timestamptz; v_to timestamptz;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  select * into c from centres where id = p_centre;
  v_from := p_date::timestamp at time zone c.timezone; v_to := v_from + interval '1 day';
  return (select coalesce(jsonb_agg(_booking_json(b, true) order by b.starts_at, b.created_at), '[]')
    from bookings b where b.centre_id = p_centre and b.starts_at >= v_from and b.starts_at < v_to);
end $$;

-- Phone bookings taken at the counter: no advance, may use walk-in tables.
create or replace function public.staff_create_booking(p_centre uuid, p_activity uuid, p_starts_at timestamptz, p_minutes int,
  p_party int, p_name text, p_phone text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare c centres; v jsonb;
begin
  perform require_perm(p_centre, 'floor.operate');
  perform require_perm(p_centre, 'customers.manage');
  select * into c from centres where id = p_centre;
  v := _create_booking(c, p_activity, p_starts_at, p_minutes, p_party, p_name, p_phone, p_note, 'staff');
  perform log_audit(p_centre, 'create', 'booking', (v->'booking'->>'id')::uuid, jsonb_build_object('at', p_starts_at, 'minutes', p_minutes));
  return jsonb_build_object('token', v->>'token', 'booking', _booking_json((select b from bookings b where id = (v->'booking'->>'id')::uuid), true));
end $$;

-- Find a booking from the QR (ticket link token) or the 6-character code, mark it arrived, suggest a free table.
create or replace function public.check_in_booking(p_centre uuid, p_code_or_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare b bookings; v text := trim(coalesce(p_code_or_token,'')); v_res jsonb;
begin
  perform require_perm(p_centre, 'floor.operate');
  -- accept a scanned ticket URL, a bare token or the short code
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
  select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'capacity', r.capacity) order by r.sort) into v_res
  from resources r where r.activity_id = b.activity_id and r.status = 'active'
    and not exists (select 1 from sessions s where s.resource_id = r.id and s.status in ('running','paused'));
  return jsonb_build_object('booking', _booking_json(b, true), 'free_tables', coalesce(v_res, '[]'::jsonb),
    'balance_paise', greatest(b.estimate_paise - b.paid_paise, 0));
end $$;

-- Seat an arrived booking at a table: starts the timer with the booked minutes.
create or replace function public.seat_booking(p_centre uuid, p_booking uuid, p_resource uuid, p_session uuid, p_client_at timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare b bookings; r resources; v jsonb;
begin
  perform require_perm(p_centre, 'floor.operate');
  select * into b from bookings where id = p_booking and centre_id = p_centre for update;
  if not found then raise exception 'Booking not found'; end if;
  if b.status = 'seated' and b.session_id = p_session then
    return jsonb_build_object('session_id', b.session_id, 'replayed', true);
  end if;
  if b.status not in ('confirmed','arrived') then raise exception 'This booking is %', b.status; end if;
  select * into r from resources where id = p_resource and centre_id = p_centre;
  if not found or r.activity_id <> b.activity_id then raise exception 'Pick a % table', (select name from activities where id = b.activity_id); end if;
  v := start_session(p_centre, p_session, p_resource, least(b.party_size, r.capacity), b.minutes, b.phone, b.name, null, p_client_at, 'booking', null);
  update bookings set status = 'seated', seated_at = now(), arrived_at = coalesce(arrived_at, now()), resource_id = p_resource, session_id = p_session
  where id = b.id;
  return v;
end $$;

create or replace function public.set_booking_status(p_centre uuid, p_booking uuid, p_status text, p_reason text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare b bookings;
begin
  perform require_perm(p_centre, 'floor.operate');
  if p_status not in ('confirmed','arrived','cancelled','no_show') then raise exception 'Invalid status'; end if;
  select * into b from bookings where id = p_booking and centre_id = p_centre for update;
  if not found then raise exception 'Booking not found'; end if;
  if b.status = 'seated' then raise exception 'This booking is already playing'; end if;
  if p_status in ('confirmed','arrived') and b.status in ('cancelled','no_show') then
    perform 1 from activities where id = b.activity_id for update;
    if not _can_fit(b.activity_id, greatest(b.starts_at, now()), b.ends_at, false, b.id) then raise exception 'No table is free for that time any more'; end if;
  end if;
  update bookings set status = p_status,
    cancelled_at = case when p_status in ('cancelled','no_show') then now() end,
    arrived_at = case when p_status = 'arrived' then coalesce(arrived_at, now()) else arrived_at end
  where id = b.id;
  perform log_audit(p_centre, p_status, 'booking', b.id, null, nullif(trim(coalesce(p_reason,'')),''));
end $$;

-- ───────────────────────── Smart extensions ─────────────────────────
-- Can this game get p_minutes more without pushing out a booking? If not: how much fits, when the booking is,
-- and which other games are free right now.
create or replace function public.extension_check(p_centre uuid, p_session uuid, p_minutes int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s sessions; v_end timestamptz; v_max int := 0; m int; v_next timestamptz; v_cap int;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  select * into s from sessions where id = p_session and centre_id = p_centre;
  if not found or s.status not in ('running','paused') then raise exception 'This game has ended'; end if;
  v_end := case when s.planned_minutes is null then now()
    else now() + make_interval(secs => greatest(0, s.planned_minutes * 60 - _session_seconds(s.id, now()))) end;
  v_cap := _activity_capacity(s.activity_id, false);
  if _activity_load(s.activity_id, v_end, v_end + make_interval(mins => p_minutes), null, s.id) + 1 <= v_cap then
    return jsonb_build_object('ok', true, 'minutes', p_minutes);
  end if;
  m := 5;
  while m < p_minutes loop
    exit when _activity_load(s.activity_id, v_end, v_end + make_interval(mins => m), null, s.id) + 1 > v_cap;
    v_max := m; m := m + 5;
  end loop;
  select min(b.starts_at) into v_next from bookings b
  where b.activity_id = s.activity_id and b.session_id is null and b.status in ('confirmed','arrived') and b.ends_at > v_end;
  return jsonb_build_object('ok', false, 'max_minutes', v_max, 'booked_at', v_next,
    'alternatives', (select coalesce(jsonb_agg(jsonb_build_object('activity_id', a.id, 'name', a.name, 'free', f.n) order by a.sort), '[]')
      from activities a, lateral (select count(*) n from resources r where r.activity_id = a.id and r.status = 'active'
          and not exists (select 1 from sessions x where x.resource_id = r.id and x.status in ('running','paused'))) f
      where a.centre_id = p_centre and a.active and a.id <> s.activity_id and f.n > 0
        and _can_fit(a.id, now(), now() + make_interval(mins => p_minutes), false)));
end $$;

-- extend_session now refuses to eat into a booked table (replays of an already-applied extend still pass).
create or replace function public.extend_session(p_centre uuid, p_session uuid, p_minutes int, p_client_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s sessions; v_planned int; v_check jsonb; v_tz text;
begin
  perform require_perm(p_centre, 'floor.operate');
  if coalesce(p_minutes,0) <= 0 or p_minutes > 720 then raise exception 'Choose how many minutes to add'; end if;
  s := _session_for_update(p_centre, p_session);
  if s.status not in ('running','paused') then raise exception 'This game has ended'; end if;
  if p_client_at is null or not exists (select 1 from session_events where session_id = p_session and kind = 'extend' and client_at = p_client_at) then
    perform 1 from activities where id = s.activity_id for update;
    v_check := extension_check(p_centre, p_session, p_minutes);
    if not (v_check->>'ok')::boolean then
      select timezone into v_tz from centres where id = p_centre;
      raise exception 'Booked from %. You can add up to % min.',
        to_char((v_check->>'booked_at')::timestamptz at time zone v_tz, 'FMHH12:MI AM'), v_check->>'max_minutes';
    end if;
  end if;
  v_planned := coalesce(s.planned_minutes, ceil(session_billable_seconds(p_session) / 60.0)::int) + p_minutes;
  if _add_event(p_session, p_centre, 'extend', p_client_at, jsonb_build_object('minutes', p_minutes, 'planned_minutes', v_planned)) is not null then
    update sessions set planned_minutes = v_planned where id = p_session;
  else
    select planned_minutes into v_planned from sessions where id = p_session;
  end if;
  return jsonb_build_object('planned_minutes', v_planned);
end $$;

-- ───────────────────────── Booking settings ─────────────────────────
-- p_settings: {enabled, advance_bp, hold_minutes, days_ahead, lead_minutes, durations[], note,
--              activities: [{id, online_bookable, walkin_reserve}]}
create or replace function public.save_booking_settings(p_centre uuid, p_settings jsonb)
returns void language plpgsql volatile security definer set search_path = public as $$
declare x jsonb; v_durations int[];
begin
  perform require_perm(p_centre, 'settings.manage');
  if coalesce((p_settings->>'enabled')::boolean, false) then perform require_feature(p_centre, 'online_booking'); end if;
  if p_settings ? 'durations' then
    select array_agg(distinct d::int order by d::int) into v_durations from jsonb_array_elements_text(p_settings->'durations') d;
    if v_durations is null or exists (select 1 from unnest(v_durations) d where d < 5 or d > 720) then raise exception 'Durations must be 5 to 720 minutes'; end if;
  end if;
  update centres set
    booking_enabled = coalesce((p_settings->>'enabled')::boolean, booking_enabled),
    booking_advance_bp = coalesce((p_settings->>'advance_bp')::int, booking_advance_bp),
    booking_hold_minutes = coalesce((p_settings->>'hold_minutes')::int, booking_hold_minutes),
    booking_days_ahead = coalesce((p_settings->>'days_ahead')::int, booking_days_ahead),
    booking_lead_minutes = coalesce((p_settings->>'lead_minutes')::int, booking_lead_minutes),
    booking_durations = coalesce(v_durations, booking_durations),
    booking_note = case when p_settings ? 'note' then nullif(trim(p_settings->>'note'),'') else booking_note end
  where id = p_centre;
  for x in select * from jsonb_array_elements(coalesce(p_settings->'activities','[]')) loop
    update activities set
      online_bookable = coalesce((x->>'online_bookable')::boolean, online_bookable),
      walkin_reserve = coalesce((x->>'walkin_reserve')::int, walkin_reserve)
    where id = (x->>'id')::uuid and centre_id = p_centre;
  end loop;
  perform log_audit(p_centre, 'update', 'booking_settings', p_centre, p_settings);
end $$;

-- ───────────────────────── Live floor: bookings + "free until" ─────────────────────────
create or replace function public.floor_state(p_centre uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c centres;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  select * into c from centres where id = p_centre;
  return jsonb_build_object(
    'server_time', now(),
    'floors', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'width', f.width, 'height', f.height,
        'outline', f.outline, 'fixtures', f.fixtures, 'version', f.version) order by f.sort, f.created_at), '[]') from floors f where f.centre_id = p_centre),
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'icon', a.icon, 'color', a.color,
        'active', a.active, 'free_until', _free_until(a.id),
        'rate_card', (select to_jsonb(rc) - 'centre_id' - 'created_by' from rate_cards rc where rc.activity_id = a.id and rc.active))
        order by a.sort), '[]') from activities a where a.centre_id = p_centre),
    'resources', _floor_resources(p_centre, true),
    'waitlist', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'activity_id', w.activity_id, 'name', w.name, 'phone', w.phone,
        'party_size', w.party_size, 'note', w.note, 'status', w.status, 'created_at', w.created_at) order by w.created_at), '[]')
        from waitlist w where w.centre_id = p_centre and w.status in ('waiting','notified')),
    'open_tabs', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'opened_at', t.opened_at,
        'customer', (select full_name from customers where id = t.customer_id),
        'live', exists (select 1 from sessions s where s.tab_id = t.id and s.status in ('running','paused')))
        order by t.opened_at), '[]') from tabs t where t.centre_id = p_centre and t.status = 'open'),
    -- bookings from an hour ago to 12 hours ahead that still need a table
    'bookings', (select coalesce(jsonb_agg(_booking_json(b, true) order by b.starts_at), '[]') from bookings b
        where b.centre_id = p_centre and b.status in ('confirmed','arrived')
          and b.starts_at < now() + interval '12 hours' and b.ends_at > now() - interval '1 hour')
  );
end $$;

-- ───────────────────────── Grants ─────────────────────────
revoke execute on function public._activity_capacity(uuid,boolean), public._session_expected_end(uuid),
  public._activity_load(uuid,timestamptz,timestamptz,uuid,uuid,boolean), public._can_fit(uuid,timestamptz,timestamptz,boolean,uuid,uuid),
  public._free_until(uuid), public._booking_estimate(uuid,timestamptz,int,int), public._booking_code(uuid),
  public._booking_json(bookings,boolean), public._check_booking_time(centres,timestamptz,int,boolean),
  public._create_booking(centres,uuid,timestamptz,int,int,text,text,text,text), public._public_centre(text)
  from public, anon, authenticated;
-- Lock everything down again (new functions get PUBLIC execute), then open only what signed-out pages need.
revoke execute on all functions in schema public from public, anon;
grant execute on function public.tv_begin(), public.tv_poll(text) to anon, authenticated;
grant execute on function public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text),
  public.cancel_booking_by_token(text)
  to anon, authenticated;
grant execute on function public.bookings_for_day(uuid,date), public.staff_create_booking(uuid,uuid,timestamptz,int,int,text,text,text),
  public.check_in_booking(uuid,text), public.seat_booking(uuid,uuid,uuid,uuid,timestamptz), public.set_booking_status(uuid,uuid,text,text),
  public.extension_check(uuid,uuid,int), public.extend_session(uuid,uuid,int,timestamptz),
  public.save_booking_settings(uuid,jsonb), public.floor_state(uuid)
  to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.bookings;
  end if;
end $$;
