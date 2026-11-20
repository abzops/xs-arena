-- XS Arena — Day 3-6 database: pricing engine, snacks on the tab, bills & payments, shifts, TV screens, real dashboard.
--
-- Pricing rules (shown to owners in the Prices screen):
--  * Started minutes count (61 s = 2 min).
--  * per_minute:   hourly rate charged per minute. Special prices (peak / happy hour) apply minute by minute
--                  by the centre's local clock. Minimum charge tops up at the normal rate.
--                  Fixed-time games: minutes over the booked time within the grace period are free;
--                  beyond that, overtime is charged (overtime rate if set, otherwise the normal rate).
--  * hourly_block: every started block (e.g. 30 min) is charged at the rate in force when the game started;
--                  minutes within the grace period don't open a new block.
--  * per_slot:     price per slot (e.g. 15 min); overtime beyond slot + grace is charged per minute.
--  * per_frame:    price per frame played.
--  * per_player:   price is per player (RC: per car). Otherwise players above "included" pay the extra-player rate
--                  (per hour for time modes, per slot / frame otherwise).
--  * Each line is rounded to the nearest rupee.

alter table public.sessions add column if not exists frames integer not null default 0 check (frames between 0 and 500);

-- ───────────────────────── Internal time helpers ─────────────────────────
create or replace function public._session_seconds(p_session uuid, p_until timestamptz)
returns integer language plpgsql stable security definer set search_path = public as $$
declare e record; v_since timestamptz; v_total numeric := 0;
begin
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

create or replace function public.session_billable_seconds(p_session uuid, p_until timestamptz default now())
returns integer language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from sessions s where s.id = p_session and is_centre_member(s.centre_id)) then return null; end if;
  return _session_seconds(p_session, p_until);
end $$;

-- Running intervals of a session.
create or replace function public._session_intervals(p_session uuid, p_until timestamptz)
returns table(s timestamptz, e timestamptz) language plpgsql stable security definer set search_path = public as $$
declare ev record; v_since timestamptz;
begin
  for ev in select kind, at from session_events where session_id = p_session order by at, id loop
    if ev.kind in ('start','resume') then
      if v_since is null then v_since := ev.at; end if;
    elsif ev.kind in ('pause','end','void') then
      if v_since is not null then s := v_since; e := ev.at; return next; v_since := null; end if;
      exit when ev.kind in ('end','void');
    end if;
  end loop;
  if v_since is not null then s := v_since; e := p_until; return next; end if;
end $$;

-- Which hourly price applies at a moment: first matching special price, else the normal price.
create or replace function public._rate_at(p_rc rate_cards, p_tz text, p_at timestamptz, out label text, out price bigint)
language plpgsql stable set search_path = public as $$
declare r jsonb; v_local timestamp := p_at at time zone p_tz; v_dow int := extract(dow from v_local)::int; v_t time := v_local::time;
  v_s time; v_e time;
begin
  label := 'Standard'; price := p_rc.price_paise;
  for r in select * from jsonb_array_elements(p_rc.time_rules) loop
    if r->'days' @> to_jsonb(v_dow) then
      v_s := (r->>'start')::time; v_e := (r->>'end')::time;
      if (v_s < v_e and v_t >= v_s and v_t < v_e) or (v_s >= v_e and (v_t >= v_s or v_t < v_e)) then
        label := coalesce(nullif(r->>'label',''), 'Special'); price := (r->>'price_paise')::bigint; return;
      end if;
    end if;
  end loop;
end $$;

create or replace function public._fmt_minutes(p int) returns text language sql immutable as $$
  select case when p >= 60 then (p / 60) || 'h' || case when p % 60 > 0 then ' ' || (p % 60) || 'm' else '' end else p || 'm' end;
$$;

-- ───────────────────────── Pricing engine ─────────────────────────
-- Price one game. Internal (no permission check): callers check.
create or replace function public._price_session(p_session uuid, p_until timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s sessions; rc rate_cards; c centres; r resources; a activities;
  v_until timestamptz; v_secs int; v_min int; v_planned int; v_mult int; v_extra int;
  v_lines jsonb := '[]'; v_total bigint := 0; v_amt numeric; v_detail text;
  iv record; t timestamptz; v_i int := 0; v_base int; v_over int; v_lbl text; v_price bigint;
  v_buckets jsonb := '{}'; k text; v_slots int; v_blocks int; v_rate record; v_bill_min int;
begin
  select * into s from sessions where id = p_session;
  if not found then return null; end if;
  select * into rc from rate_cards where id = s.rate_card_id;
  select * into c from centres where id = s.centre_id;
  select * into r from resources where id = s.resource_id;
  select * into a from activities where id = s.activity_id;
  v_until := coalesce(s.ended_at, p_until);
  v_secs := case when s.status = 'void' then 0 else _session_seconds(p_session, v_until) end;
  v_min := ceil(v_secs / 60.0)::int;
  v_planned := s.planned_minutes;
  v_mult := case when rc.per_player then s.players else 1 end;
  v_extra := case when rc.per_player then 0 else greatest(s.players - rc.included_players, 0) end;

  if s.status = 'void' then
    return jsonb_build_object('session_id', s.id, 'resource', r.name, 'activity', a.name, 'minutes', 0, 'billable_seconds', 0,
      'started_at', s.started_at, 'ended_at', s.ended_at, 'status', s.status, 'lines', '[]'::jsonb, 'amount_paise', 0);
  end if;

  if rc.billing_mode = 'per_frame' then
    v_amt := round(s.frames * rc.price_paise * v_mult / 100.0) * 100;
    v_lines := v_lines || jsonb_build_object('label', s.frames || ' frame' || case when s.frames = 1 then '' else 's' end ||
      case when v_mult > 1 then ' × ' || v_mult || ' players' else '' end, 'amount_paise', v_amt);
    v_total := v_total + v_amt;
    if v_extra > 0 and rc.extra_player_paise > 0 then
      v_amt := round(s.frames * v_extra * rc.extra_player_paise / 100.0) * 100;
      v_lines := v_lines || jsonb_build_object('label', v_extra || ' extra player' || case when v_extra = 1 then '' else 's' end, 'amount_paise', v_amt);
      v_total := v_total + v_amt;
    end if;

  elsif rc.billing_mode = 'per_slot' then
    v_planned := coalesce(v_planned, rc.slot_minutes);
    v_slots := greatest(1, ceil(v_planned::numeric / rc.slot_minutes)::int);
    v_amt := round(v_slots * rc.price_paise * v_mult / 100.0) * 100;
    v_lines := v_lines || jsonb_build_object('label', v_slots || ' × ' || rc.slot_minutes || ' min slot' ||
      case when v_mult > 1 then ' × ' || v_mult || case when a.kind = 'track' then ' cars' else ' players' end else '' end, 'amount_paise', v_amt);
    v_total := v_total + v_amt;
    if v_extra > 0 and rc.extra_player_paise > 0 then
      v_amt := round(v_slots * v_extra * rc.extra_player_paise / 100.0) * 100;
      v_lines := v_lines || jsonb_build_object('label', v_extra || ' extra player' || case when v_extra = 1 then '' else 's' end, 'amount_paise', v_amt);
      v_total := v_total + v_amt;
    end if;
    v_over := greatest(v_min - v_planned - rc.grace_minutes, 0);
    if v_over > 0 then
      v_price := coalesce(rc.overtime_price_paise, round(rc.price_paise * 60.0 / rc.slot_minutes));
      v_amt := round(v_over * v_price * v_mult / 60.0 / 100.0) * 100;
      v_lines := v_lines || jsonb_build_object('label', 'Overtime ' || _fmt_minutes(v_over), 'amount_paise', v_amt, 'overtime', true);
      v_total := v_total + v_amt;
    end if;

  elsif rc.billing_mode = 'hourly_block' then
    v_bill_min := greatest(v_min - rc.grace_minutes, 1);
    v_blocks := greatest(ceil(v_bill_min::numeric / rc.block_minutes)::int, ceil(greatest(rc.min_minutes,1)::numeric / rc.block_minutes)::int, 1);
    select * into v_rate from _rate_at(rc, c.timezone, s.started_at);
    v_amt := round(v_blocks * rc.block_minutes * v_rate.price * v_mult / 60.0 / 100.0) * 100;
    v_lines := v_lines || jsonb_build_object('label', v_blocks || ' × ' || rc.block_minutes || ' min' ||
      case when v_rate.label <> 'Standard' then ' (' || v_rate.label || ')' else '' end ||
      case when v_mult > 1 then ' × ' || v_mult || ' players' else '' end, 'amount_paise', v_amt);
    v_total := v_total + v_amt;
    if v_extra > 0 and rc.extra_player_paise > 0 then
      v_amt := round(v_blocks * rc.block_minutes * v_extra * rc.extra_player_paise / 60.0 / 100.0) * 100;
      v_lines := v_lines || jsonb_build_object('label', v_extra || ' extra player' || case when v_extra = 1 then '' else 's' end, 'amount_paise', v_amt);
      v_total := v_total + v_amt;
    end if;

  else -- per_minute
    -- minutes inside the booked time (+ grace) are base; beyond is overtime
    if v_planned is not null and v_min > v_planned then
      if v_min <= v_planned + rc.grace_minutes then v_base := v_planned; v_over := 0;
      else v_base := v_planned; v_over := v_min - v_planned; end if;
    else
      v_base := v_min; v_over := 0;
    end if;
    -- walk the running minutes and bucket them by price
    <<walk>>
    for iv in select * from _session_intervals(p_session, v_until) loop
      t := iv.s;
      while t < iv.e loop
        exit walk when v_i >= v_base + v_over;
        if v_i < v_base then
          select * into v_rate from _rate_at(rc, c.timezone, t);
          v_lbl := v_rate.label; v_price := v_rate.price;
        else
          v_lbl := 'Overtime'; v_price := coalesce(rc.overtime_price_paise, (select price from _rate_at(rc, c.timezone, t)));
        end if;
        k := v_lbl || '|' || v_price;
        v_buckets := jsonb_set(v_buckets, array[k], to_jsonb(coalesce((v_buckets->>k)::int, 0) + 1));
        v_i := v_i + 1;
        t := t + interval '1 minute';
      end loop;
    end loop;
    -- minimum charge tops up at the normal price
    if v_i < rc.min_minutes then
      k := 'Minimum charge|' || rc.price_paise;
      v_buckets := jsonb_set(v_buckets, array[k], to_jsonb(rc.min_minutes - v_i));
    end if;
    for k in select key from jsonb_each(v_buckets) order by key loop
      v_lbl := split_part(k, '|', 1); v_price := split_part(k, '|', 2)::bigint;
      v_amt := round((v_buckets->>k)::int * v_price * v_mult / 60.0 / 100.0) * 100;
      v_lines := v_lines || jsonb_build_object('label',
        case when v_lbl = 'Standard' and jsonb_array_length(rc.time_rules) = 0 then _fmt_minutes((v_buckets->>k)::int)
             else v_lbl || ' ' || _fmt_minutes((v_buckets->>k)::int) end ||
        ' @ ₹' || (v_price / 100) || '/hr' || case when v_mult > 1 then ' × ' || v_mult || ' players' else '' end,
        'amount_paise', v_amt, 'overtime', v_lbl = 'Overtime');
      v_total := v_total + v_amt;
    end loop;
    if v_extra > 0 and rc.extra_player_paise > 0 then
      v_amt := round(greatest(v_i, rc.min_minutes) * v_extra * rc.extra_player_paise / 60.0 / 100.0) * 100;
      v_lines := v_lines || jsonb_build_object('label', v_extra || ' extra player' || case when v_extra = 1 then '' else 's' end ||
        ' @ ₹' || (rc.extra_player_paise / 100) || '/hr', 'amount_paise', v_amt);
      v_total := v_total + v_amt;
    end if;
  end if;

  return jsonb_build_object('session_id', s.id, 'resource', r.name, 'activity', a.name, 'activity_id', a.id, 'mode', rc.billing_mode,
    'minutes', v_min, 'billable_seconds', v_secs, 'planned_minutes', s.planned_minutes, 'players', s.players, 'frames', s.frames,
    'started_at', s.started_at, 'ended_at', s.ended_at, 'status', s.status, 'lines', v_lines, 'amount_paise', v_total);
end $$;

create or replace function public.price_session(p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from sessions s where s.id = p_session and is_centre_member(s.centre_id)) then raise exception 'Not allowed'; end if;
  return _price_session(p_session, now());
end $$;

create or replace function public.set_session_frames(p_centre uuid, p_session uuid, p_frames int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm(p_centre, 'floor.operate');
  if coalesce(p_frames, -1) < 0 or p_frames > 500 then raise exception 'Invalid number of frames'; end if;
  update sessions set frames = p_frames where id = p_session and centre_id = p_centre and status in ('running','paused','ended');
  if not found then raise exception 'Game not found'; end if;
end $$;

-- ───────────────────────── Tab items (snacks, add-ons) ─────────────────────────
create table public.tab_items (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  tab_id uuid not null references public.tabs(id) on delete cascade,
  product_id uuid references public.products(id),
  name text not null check (length(trim(name)) between 1 and 80),
  qty numeric(10,2) not null check (qty > 0),
  unit_price_paise bigint not null check (unit_price_paise >= 0),
  total_paise bigint not null,
  status text not null default 'ok' check (status in ('ok','removed')),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index tab_items_tab_idx on public.tab_items(tab_id);

-- ───────────────────────── Bills & payments ─────────────────────────
create table public.bills (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  tab_id uuid not null references public.tabs(id),
  bill_no text not null,
  customer_id uuid references public.customers(id),
  subtotal_paise bigint not null default 0,
  discount_paise bigint not null default 0,
  discount_reason text,
  taxable_paise bigint not null default 0,
  tax_paise bigint not null default 0,
  gst_rate_bp integer not null default 0,
  total_paise bigint not null default 0,
  paid_paise bigint not null default 0,
  status text not null default 'paid' check (status in ('paid','partial','unpaid','void')),
  lines jsonb not null default '[]',
  idempotency_key uuid,
  void_reason text,
  voided_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (centre_id, bill_no),
  unique (centre_id, idempotency_key)
);
create unique index bills_tab_live_uq on public.bills(tab_id) where status <> 'void';
create index bills_centre_time_idx on public.bills(centre_id, created_at desc);
create index bills_customer_idx on public.bills(customer_id, created_at desc);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete cascade,
  method text not null check (method in ('cash','upi','card','bank','other')),
  amount_paise bigint not null check (amount_paise > 0),
  reference text,
  status text not null default 'ok' check (status in ('ok','void')),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index payments_centre_time_idx on public.payments(centre_id, created_at desc);
create index payments_bill_idx on public.payments(bill_id);

-- ───────────────────────── Shifts (cash drawer) ─────────────────────────
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  opened_by uuid,
  opened_at timestamptz not null default now(),
  opening_cash_paise bigint not null default 0 check (opening_cash_paise >= 0),
  closed_by uuid,
  closed_at timestamptz,
  expected_cash_paise bigint,
  counted_cash_paise bigint,
  difference_paise bigint,
  summary jsonb,
  note text,
  status text not null default 'open' check (status in ('open','closed'))
);
create unique index shifts_one_open on public.shifts(centre_id) where status = 'open';
create index shifts_centre_idx on public.shifts(centre_id, opened_at desc);

-- ───────────────────────── TV screens ─────────────────────────
create table public.tv_screens (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid references public.centres(id) on delete cascade,
  name text,
  mode text not null default 'staff' check (mode in ('staff','customer')),
  token_hash text not null unique,
  pair_code text,
  pair_expires_at timestamptz,
  paired_at timestamptz,
  paired_by uuid,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index tv_pair_code_uq on public.tv_screens(pair_code) where paired_at is null and revoked_at is null;

-- ───────────────────────── RLS ─────────────────────────
alter table public.tab_items enable row level security;
alter table public.bills enable row level security;
alter table public.payments enable row level security;
alter table public.shifts enable row level security;
alter table public.tv_screens enable row level security;
create policy tab_items_read on public.tab_items for select to authenticated using (is_centre_member(centre_id));
create policy bills_read on public.bills for select to authenticated using (is_centre_member(centre_id));
create policy payments_read on public.payments for select to authenticated using (is_centre_member(centre_id));
create policy shifts_read on public.shifts for select to authenticated using (has_perm(centre_id, 'reports.view') or opened_by = auth.uid());
create policy tv_read on public.tv_screens for select to authenticated using (centre_id is not null and has_perm(centre_id, 'settings.manage'));
grant select on public.tab_items, public.bills, public.payments, public.shifts to authenticated;
grant select (id, centre_id, name, mode, paired_at, last_seen_at, revoked_at, created_at) on public.tv_screens to authenticated;

-- ───────────────────────── Tab commands ─────────────────────────
create or replace function public.tab_add_item(p_centre uuid, p_tab uuid, p_product uuid, p_qty numeric default 1,
  p_name text default null, p_price_paise bigint default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare p products; v_id uuid; v_name text; v_price bigint;
begin
  perform require_perm(p_centre, 'billing.create');
  if coalesce(p_qty,0) <= 0 or p_qty > 999 then raise exception 'Invalid quantity'; end if;
  if not exists (select 1 from tabs where id = p_tab and centre_id = p_centre and status = 'open') then raise exception 'This bill is closed'; end if;
  if p_product is not null then
    select * into p from products where id = p_product and centre_id = p_centre and status = 'active' for update;
    if not found then raise exception 'Item not found'; end if;
    v_name := p.name; v_price := p.price_paise;
    update products set stock_qty = stock_qty - p_qty where id = p.id;
    insert into stock_moves(centre_id, product_id, qty, reason, ref_id, created_by) values (p_centre, p.id, -p_qty, 'sale', p_tab, auth.uid());
  else
    if coalesce(trim(p_name),'') = '' or coalesce(p_price_paise,-1) < 0 then raise exception 'Enter a name and price'; end if;
    v_name := trim(p_name); v_price := p_price_paise;
  end if;
  insert into tab_items(centre_id, tab_id, product_id, name, qty, unit_price_paise, total_paise, created_by)
  values (p_centre, p_tab, p_product, v_name, p_qty, v_price, round(p_qty * v_price), auth.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function public.tab_remove_item(p_centre uuid, p_item uuid)
returns void language plpgsql security definer set search_path = public as $$
declare it tab_items;
begin
  perform require_perm(p_centre, 'billing.create');
  select * into it from tab_items where id = p_item and centre_id = p_centre and status = 'ok' for update;
  if not found then raise exception 'Item not found'; end if;
  if not exists (select 1 from tabs where id = it.tab_id and status = 'open') then raise exception 'This bill is closed'; end if;
  update tab_items set status = 'removed' where id = p_item;
  if it.product_id is not null then
    update products set stock_qty = stock_qty + it.qty where id = it.product_id;
    insert into stock_moves(centre_id, product_id, qty, reason, ref_id, created_by) values (p_centre, it.product_id, it.qty, 'return', it.tab_id, auth.uid());
  end if;
end $$;

-- What the bill looks like right now (live games priced up to this moment).
create or replace function public._tab_preview(p_tab uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t tabs; c centres; v_games jsonb := '[]'; v_items jsonb := '[]'; v_sub bigint := 0; v_isum bigint; g jsonb; sid uuid;
begin
  select * into t from tabs where id = p_tab;
  if not found then return null; end if;
  select * into c from centres where id = t.centre_id;
  for sid in select id from sessions where tab_id = p_tab and status <> 'void' order by started_at loop
    g := _price_session(sid, now());
    v_games := v_games || g; v_sub := v_sub + (g->>'amount_paise')::bigint;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'qty', i.qty, 'unit_price_paise', i.unit_price_paise,
      'total_paise', i.total_paise, 'product_id', i.product_id) order by i.created_at), '[]'), coalesce(sum(i.total_paise),0)
    into v_items, v_isum from tab_items i where i.tab_id = p_tab and i.status = 'ok';
  v_sub := v_sub + coalesce(v_isum, 0);
  return jsonb_build_object('tab_id', t.id, 'status', t.status, 'customer',
      (select jsonb_build_object('id', cu.id, 'name', cu.full_name, 'phone', cu.phone) from customers cu where cu.id = t.customer_id),
    'opened_at', t.opened_at, 'games', v_games, 'items', v_items, 'subtotal_paise', v_sub,
    'gst_enabled', c.gst_enabled, 'gst_rate_bp', c.gst_rate_bp, 'prices_include_tax', c.prices_include_tax,
    'live', exists (select 1 from sessions where tab_id = p_tab and status in ('running','paused')));
end $$;

create or replace function public.tab_preview(p_centre uuid, p_tab uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from tabs where id = p_tab and centre_id = p_centre) then raise exception 'Bill not found'; end if;
  return _tab_preview(p_tab);
end $$;

-- Attach a customer to a tab (by phone) before billing, e.g. for the WhatsApp receipt.
create or replace function public.tab_set_customer(p_centre uuid, p_tab uuid, p_phone text, p_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_customer uuid;
begin
  perform require_perm(p_centre, 'customers.manage');
  if not exists (select 1 from tabs where id = p_tab and centre_id = p_centre and status = 'open') then raise exception 'This bill is closed'; end if;
  v_customer := _customer_by_phone(p_centre, p_name, p_phone, 'walk_in');
  update tabs set customer_id = v_customer where id = p_tab;
  update sessions set customer_id = coalesce(customer_id, v_customer) where tab_id = p_tab;
  return v_customer;
end $$;

-- Close the bill: ends any running games, snapshots the lines, records payments. Idempotent on p_key.
create or replace function public.close_tab(p_centre uuid, p_tab uuid, p_discount_paise bigint default 0, p_discount_reason text default null,
  p_payments jsonb default '[]', p_key uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t tabs; c centres; b bills; v_prev jsonb; v_sub bigint; v_disc bigint := greatest(coalesce(p_discount_paise,0),0); v_net bigint;
  v_tax bigint := 0; v_taxable bigint; v_total bigint; v_rate int := 0; v_paid bigint := 0; pay jsonb; v_status text; v_no text; sid uuid; v_id uuid;
begin
  perform require_perm(p_centre, 'billing.create');
  if p_key is not null then
    select * into b from bills where centre_id = p_centre and idempotency_key = p_key;
    if found then return jsonb_build_object('bill_id', b.id, 'bill_no', b.bill_no, 'total_paise', b.total_paise, 'status', b.status, 'duplicate', true); end if;
  end if;
  select * into t from tabs where id = p_tab and centre_id = p_centre for update;
  if not found then raise exception 'Bill not found'; end if;
  if t.status <> 'open' then raise exception 'This bill is already closed'; end if;
  if v_disc > 0 then
    perform require_perm(p_centre, 'billing.discount');
    if coalesce(trim(p_discount_reason),'') = '' then raise exception 'Give a reason for the discount'; end if;
  end if;
  -- stop the clocks
  for sid in select id from sessions where tab_id = p_tab and status in ('running','paused') loop
    perform end_session(p_centre, sid, null);
  end loop;
  v_prev := _tab_preview(p_tab);
  v_sub := (v_prev->>'subtotal_paise')::bigint;
  if jsonb_array_length(v_prev->'games') = 0 and jsonb_array_length(v_prev->'items') = 0 then raise exception 'Nothing to bill'; end if;
  if v_disc > v_sub then raise exception 'Discount is larger than the bill'; end if;
  v_net := v_sub - v_disc;
  select * into c from centres where id = p_centre for update;
  if c.gst_enabled then
    v_rate := c.gst_rate_bp;
    if c.prices_include_tax then v_total := v_net; v_tax := round(v_net::numeric * v_rate / (10000 + v_rate)); v_taxable := v_net - v_tax;
    else v_taxable := v_net; v_tax := round(v_net::numeric * v_rate / 10000); v_total := v_net + v_tax; end if;
  else v_taxable := v_net; v_total := v_net; end if;

  update centres set invoice_seq = invoice_seq + 1 where id = p_centre returning invoice_prefix || '-' || to_char(now() at time zone timezone, 'YYMM') || '-' || lpad(invoice_seq::text, 4, '0') into v_no;
  insert into bills(centre_id, tab_id, bill_no, customer_id, subtotal_paise, discount_paise, discount_reason, taxable_paise, tax_paise,
    gst_rate_bp, total_paise, lines, idempotency_key, created_by)
  values (p_centre, p_tab, v_no, t.customer_id, v_sub, v_disc, nullif(trim(coalesce(p_discount_reason,'')),''), v_taxable, v_tax,
    v_rate, v_total, jsonb_build_object('games', v_prev->'games', 'items', v_prev->'items'), p_key, auth.uid())
  returning id into v_id;

  for pay in select * from jsonb_array_elements(coalesce(p_payments,'[]')) loop
    if coalesce((pay->>'amount_paise')::bigint,0) > 0 then
      if (pay->>'method') not in ('cash','upi','card','bank','other') then raise exception 'Invalid payment method'; end if;
      insert into payments(centre_id, bill_id, method, amount_paise, reference, created_by)
      values (p_centre, v_id, pay->>'method', (pay->>'amount_paise')::bigint, nullif(trim(coalesce(pay->>'reference','')),''), auth.uid());
      v_paid := v_paid + (pay->>'amount_paise')::bigint;
    end if;
  end loop;
  if v_paid > v_total then raise exception 'Payment is more than the bill amount'; end if;
  v_status := case when v_paid >= v_total then 'paid' when v_paid > 0 then 'partial' else 'unpaid' end;
  update bills set paid_paise = v_paid, status = v_status where id = v_id;
  update tabs set status = 'settled', closed_at = now() where id = p_tab;
  if t.customer_id is not null then
    update customers set visit_count = visit_count + 1, total_spent_paise = total_spent_paise + v_total, last_visit_at = now() where id = t.customer_id;
  end if;
  perform log_audit(p_centre, 'create', 'bill', v_id, jsonb_build_object('no', v_no, 'total', v_total, 'discount', v_disc), nullif(trim(coalesce(p_discount_reason,'')),''));
  return jsonb_build_object('bill_id', v_id, 'bill_no', v_no, 'total_paise', v_total, 'paid_paise', v_paid, 'status', v_status);
end $$;

create or replace function public.add_payment(p_centre uuid, p_bill uuid, p_method text, p_amount_paise bigint, p_reference text default null)
returns void language plpgsql security definer set search_path = public as $$
declare b bills;
begin
  perform require_perm(p_centre, 'billing.create');
  if p_method not in ('cash','upi','card','bank','other') then raise exception 'Invalid payment method'; end if;
  select * into b from bills where id = p_bill and centre_id = p_centre for update;
  if not found then raise exception 'Bill not found'; end if;
  if b.status = 'void' then raise exception 'This bill is void'; end if;
  if coalesce(p_amount_paise,0) <= 0 or b.paid_paise + p_amount_paise > b.total_paise then raise exception 'Amount is more than the balance due'; end if;
  insert into payments(centre_id, bill_id, method, amount_paise, reference, created_by)
  values (p_centre, p_bill, p_method, p_amount_paise, nullif(trim(coalesce(p_reference,'')),''), auth.uid());
  update bills set paid_paise = paid_paise + p_amount_paise,
    status = case when paid_paise + p_amount_paise >= total_paise then 'paid' else 'partial' end where id = p_bill;
  perform log_audit(p_centre, 'payment', 'bill', p_bill, jsonb_build_object('amount', p_amount_paise, 'method', p_method));
end $$;

create or replace function public.void_bill(p_centre uuid, p_bill uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare b bills; it tab_items;
begin
  perform require_perm(p_centre, 'billing.void');
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  select * into b from bills where id = p_bill and centre_id = p_centre for update;
  if not found then raise exception 'Bill not found'; end if;
  if b.status = 'void' then return; end if;
  for it in select * from tab_items where tab_id = b.tab_id and status = 'ok' and product_id is not null loop
    update products set stock_qty = stock_qty + it.qty where id = it.product_id;
    insert into stock_moves(centre_id, product_id, qty, reason, ref_id, created_by) values (p_centre, it.product_id, it.qty, 'void', p_bill, auth.uid());
  end loop;
  update payments set status = 'void' where bill_id = p_bill;
  update bills set status = 'void', void_reason = trim(p_reason), voided_at = now() where id = p_bill;
  update tabs set status = 'void' where id = b.tab_id;
  if b.customer_id is not null then
    update customers set visit_count = greatest(visit_count - 1, 0), total_spent_paise = greatest(total_spent_paise - b.total_paise, 0) where id = b.customer_id;
  end if;
  perform log_audit(p_centre, 'void', 'bill', p_bill, jsonb_build_object('no', b.bill_no, 'total', b.total_paise), trim(p_reason));
end $$;

-- ───────────────────────── Shifts ─────────────────────────
create or replace function public._shift_figures(p_centre uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'by_method', (select coalesce(jsonb_object_agg(method, s), '{}') from (select method, sum(amount_paise) s from payments
        where centre_id = p_centre and status = 'ok' and created_at >= p_from and created_at <= p_to group by method) x),
    'cash_in', (select coalesce(sum(amount_paise),0) from payments where centre_id = p_centre and status = 'ok' and method = 'cash'
        and created_at >= p_from and created_at <= p_to),
    'drawer_expenses', (select coalesce(sum(amount_paise),0) from expenses where centre_id = p_centre and status = 'ok'
        and paid_from = 'drawer' and method = 'cash' and created_at >= p_from and created_at <= p_to),
    'bills', (select count(*) from bills where centre_id = p_centre and status <> 'void' and created_at >= p_from and created_at <= p_to),
    'sales', (select coalesce(sum(total_paise),0) from bills where centre_id = p_centre and status <> 'void' and created_at >= p_from and created_at <= p_to),
    'discounts', (select coalesce(sum(discount_paise),0) from bills where centre_id = p_centre and status <> 'void' and created_at >= p_from and created_at <= p_to),
    'voids', (select count(*) from bills where centre_id = p_centre and status = 'void' and voided_at >= p_from and voided_at <= p_to)
      + (select count(*) from sessions where centre_id = p_centre and status = 'void' and ended_at >= p_from and ended_at <= p_to),
    'dues', (select coalesce(sum(total_paise - paid_paise),0) from bills where centre_id = p_centre and status in ('partial','unpaid')
        and created_at >= p_from and created_at <= p_to)
  );
$$;

create or replace function public.open_shift(p_centre uuid, p_opening_cash_paise bigint)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform require_perm(p_centre, 'floor.operate');
  if exists (select 1 from shifts where centre_id = p_centre and status = 'open') then raise exception 'A shift is already open'; end if;
  insert into shifts(centre_id, opened_by, opening_cash_paise) values (p_centre, auth.uid(), greatest(coalesce(p_opening_cash_paise,0),0)) returning id into v_id;
  perform log_audit(p_centre, 'open', 'shift', v_id, jsonb_build_object('opening', p_opening_cash_paise));
  return v_id;
end $$;

create or replace function public.current_shift(p_centre uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare sh shifts; f jsonb;
begin
  if not has_perm(p_centre, 'floor.operate') then raise exception 'Not allowed'; end if;
  select * into sh from shifts where centre_id = p_centre and status = 'open';
  if not found then return null; end if;
  f := _shift_figures(p_centre, sh.opened_at, now());
  return jsonb_build_object('id', sh.id, 'opened_at', sh.opened_at, 'opening_cash_paise', sh.opening_cash_paise,
    'opened_by', (select display_name from centre_staff where centre_id = p_centre and user_id = sh.opened_by),
    'figures', f, 'expected_cash_paise', sh.opening_cash_paise + (f->>'cash_in')::bigint - (f->>'drawer_expenses')::bigint);
end $$;

create or replace function public.close_shift(p_centre uuid, p_counted_cash_paise bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare sh shifts; f jsonb; v_expected bigint; v_diff bigint;
begin
  perform require_perm(p_centre, 'floor.operate');
  select * into sh from shifts where centre_id = p_centre and status = 'open' for update;
  if not found then raise exception 'No shift is open'; end if;
  if p_counted_cash_paise is null or p_counted_cash_paise < 0 then raise exception 'Enter the cash you counted'; end if;
  f := _shift_figures(p_centre, sh.opened_at, now());
  v_expected := sh.opening_cash_paise + (f->>'cash_in')::bigint - (f->>'drawer_expenses')::bigint;
  v_diff := p_counted_cash_paise - v_expected;
  if v_diff <> 0 and coalesce(trim(p_note),'') = '' then raise exception 'Cash is % by ₹%. Add a note to close the shift.',
    case when v_diff < 0 then 'short' else 'over' end, abs(v_diff) / 100.0; end if;
  update shifts set status = 'closed', closed_at = now(), closed_by = auth.uid(), expected_cash_paise = v_expected,
    counted_cash_paise = p_counted_cash_paise, difference_paise = v_diff, summary = f, note = nullif(trim(coalesce(p_note,'')),'')
  where id = sh.id;
  perform log_audit(p_centre, 'close', 'shift', sh.id, jsonb_build_object('expected', v_expected, 'counted', p_counted_cash_paise, 'difference', v_diff), p_note);
  return jsonb_build_object('expected_cash_paise', v_expected, 'counted_cash_paise', p_counted_cash_paise, 'difference_paise', v_diff, 'figures', f);
end $$;

-- ───────────────────────── Live floor (with running cost) ─────────────────────────
create or replace function public._floor_resources(p_centre uuid, p_private boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'floor_id', r.floor_id, 'activity_id', r.activity_id, 'name', r.name, 'shape', r.shape,
    'x', r.x, 'y', r.y, 'w', r.w, 'h', r.h, 'rotation', r.rotation, 'points', r.points, 'capacity', r.capacity,
    'online_bookable', r.online_bookable, 'status', r.status,
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
    'resources', _floor_resources(p_centre, true),
    'waitlist', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'activity_id', w.activity_id, 'name', w.name, 'phone', w.phone,
        'party_size', w.party_size, 'note', w.note, 'status', w.status, 'created_at', w.created_at) order by w.created_at), '[]')
        from waitlist w where w.centre_id = p_centre and w.status in ('waiting','notified')),
    'open_tabs', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'opened_at', t.opened_at,
        'customer', (select full_name from customers where id = t.customer_id),
        'live', exists (select 1 from sessions s where s.tab_id = t.id and s.status in ('running','paused')))
        order by t.opened_at), '[]') from tabs t where t.centre_id = p_centre and t.status = 'open')
  );
end $$;

-- ───────────────────────── TV screens ─────────────────────────
-- 1. TV opens /tv → tv_begin() returns a 6-digit code + a secret token kept on the TV.
-- 2. Owner types the code in Settings → tv_link(). 3. TV polls tv_poll(token) for the live floor.
create or replace function public.tv_begin()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''); v_code text; v_try int := 0;
begin
  delete from tv_screens where paired_at is null and pair_expires_at < now() - interval '1 day';
  loop
    v_code := lpad(floor(random() * 1000000)::int::text, 6, '0');
    exit when not exists (select 1 from tv_screens where pair_code = v_code and paired_at is null and revoked_at is null);
    v_try := v_try + 1; if v_try > 20 then raise exception 'Try again'; end if;
  end loop;
  insert into tv_screens(token_hash, pair_code, pair_expires_at) values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_code, now() + interval '15 minutes');
  return jsonb_build_object('code', v_code, 'token', v_token, 'expires_at', now() + interval '15 minutes');
end $$;

create or replace function public.tv_link(p_centre uuid, p_code text, p_name text default 'TV', p_mode text default 'staff')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_limit int;
begin
  perform require_perm(p_centre, 'settings.manage');
  perform require_feature(p_centre, 'tv_display');
  if p_mode not in ('staff','customer') then raise exception 'Invalid mode'; end if;
  v_limit := feature_limit(p_centre, 'tv_display');
  if v_limit is not null and (select count(*) from tv_screens where centre_id = p_centre and revoked_at is null) >= v_limit then
    raise exception 'Your plan allows % TV screen(s). Remove one or upgrade.', v_limit;
  end if;
  update tv_screens set centre_id = p_centre, name = coalesce(nullif(trim(p_name),''),'TV'), mode = p_mode, paired_at = now(),
    paired_by = auth.uid(), pair_code = null
  where pair_code = trim(p_code) and paired_at is null and revoked_at is null and pair_expires_at > now()
  returning id into v_id;
  if v_id is null then raise exception 'That code is wrong or has expired. Reload the TV page for a new code.'; end if;
  perform log_audit(p_centre, 'link', 'tv', v_id, jsonb_build_object('name', p_name, 'mode', p_mode));
  return v_id;
end $$;

create or replace function public.tv_revoke(p_centre uuid, p_screen uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm(p_centre, 'settings.manage');
  update tv_screens set revoked_at = now() where id = p_screen and centre_id = p_centre and revoked_at is null;
  if not found then raise exception 'TV not found'; end if;
  perform log_audit(p_centre, 'revoke', 'tv', p_screen, null);
end $$;

create or replace function public.tv_poll(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare tv tv_screens; c centres;
begin
  select * into tv from tv_screens where token_hash = encode(sha256(convert_to(coalesce(p_token,''), 'UTF8')), 'hex');
  if not found or tv.revoked_at is not null then return jsonb_build_object('state', 'revoked'); end if;
  if tv.paired_at is null then
    if tv.pair_expires_at < now() then return jsonb_build_object('state', 'expired'); end if;
    return jsonb_build_object('state', 'pairing', 'code', tv.pair_code, 'expires_at', tv.pair_expires_at);
  end if;
  update tv_screens set last_seen_at = now() where id = tv.id and (last_seen_at is null or last_seen_at < now() - interval '1 minute');
  select * into c from centres where id = tv.centre_id;
  if c.status <> 'active' or not has_feature(c.id, 'tv_display') then return jsonb_build_object('state', 'paused'); end if;
  return jsonb_build_object('state', 'live', 'mode', tv.mode, 'name', tv.name, 'server_time', now(),
    'centre', jsonb_build_object('name', c.name, 'timezone', c.timezone),
    'floors', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'width', f.width, 'height', f.height,
        'outline', f.outline, 'fixtures', f.fixtures) order by f.sort, f.created_at), '[]') from floors f where f.centre_id = c.id),
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'color', a.color) order by a.sort), '[]')
        from activities a where a.centre_id = c.id),
    'resources', (select coalesce(jsonb_agg(
        case when tv.mode = 'staff' then x || jsonb_build_object('session', case when x->'session' = 'null'::jsonb then null else
              (x->'session') - 'tab_id' - 'cost_paise' || jsonb_build_object('customer',
                (select jsonb_build_object('name', split_part(cu.full_name, ' ', 1)) from customers cu where cu.id = ((x->'session'->'customer'->>'id')::uuid))) end)
             else x || jsonb_build_object('session', case when x->'session' = 'null'::jsonb then null else (x->'session') - 'tab_id' - 'cost_paise' - 'customer' end) end), '[]')
        from jsonb_array_elements(_floor_resources(c.id, true)) x),
    'waitlist', (select coalesce(jsonb_agg(jsonb_build_object('n', row_number, 'activity_id', activity_id, 'party_size', party_size,
        'name', case when tv.mode = 'staff' then split_part(name, ' ', 1) end) order by created_at), '[]')
        from (select *, row_number() over (order by created_at) from waitlist where centre_id = c.id and status in ('waiting','notified')) w)
  );
end $$;

-- ───────────────────────── Dashboard (real sales) ─────────────────────────
create or replace function public.dashboard_summary(p_centre uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c centres; v_today date; v_month date; v_start timestamptz; v_end timestamptz; v_mstart timestamptz;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  select * into c from centres where id = p_centre;
  v_today := (now() at time zone c.timezone)::date;
  v_month := date_trunc('month', v_today)::date;
  v_start := v_today::timestamp at time zone c.timezone; v_end := v_start + interval '1 day';
  v_mstart := v_month::timestamp at time zone c.timezone;
  return jsonb_build_object(
    'today', v_today,
    'revenue_today', (select coalesce(sum(total_paise),0) from bills where centre_id = p_centre and status <> 'void' and created_at >= v_start and created_at < v_end),
    'collected_today', (select coalesce(sum(amount_paise),0) from payments where centre_id = p_centre and status = 'ok' and created_at >= v_start and created_at < v_end),
    'bills_today', (select count(*) from bills where centre_id = p_centre and status <> 'void' and created_at >= v_start and created_at < v_end),
    'methods_today', (select coalesce(jsonb_object_agg(method, s),'{}') from (select method, sum(amount_paise) s from payments
        where centre_id = p_centre and status = 'ok' and created_at >= v_start and created_at < v_end group by method) m),
    'by_activity_today', (select coalesce(jsonb_object_agg(act, s),'{}') from (
        select g->>'activity' act, sum((g->>'amount_paise')::bigint) s from bills b, jsonb_array_elements(b.lines->'games') g
        where b.centre_id = p_centre and b.status <> 'void' and b.created_at >= v_start and b.created_at < v_end group by 1) x),
    'snacks_today', (select coalesce(sum((i->>'total_paise')::bigint),0) from bills b, jsonb_array_elements(b.lines->'items') i
        where b.centre_id = p_centre and b.status <> 'void' and b.created_at >= v_start and b.created_at < v_end),
    'busy_now', (select count(*) from sessions where centre_id = p_centre and status in ('running','paused')),
    'resources_total', (select count(*) from resources where centre_id = p_centre and status = 'active'),
    'waiting_now', (select count(*) from waitlist where centre_id = p_centre and status in ('waiting','notified')),
    'open_tabs', (select count(*) from tabs where centre_id = p_centre and status = 'open'),
    'dues_paise', (select coalesce(sum(total_paise - paid_paise),0) from bills where centre_id = p_centre and status in ('partial','unpaid')),
    'revenue_month', (select coalesce(sum(total_paise),0) from bills where centre_id = p_centre and status <> 'void' and created_at >= v_mstart),
    'expenses_month', (select coalesce(sum(amount_paise),0) from expenses where centre_id = p_centre and status = 'ok' and expense_date >= v_month),
    'expenses_by_category', (select coalesce(jsonb_object_agg(category, s),'{}') from (
        select category, sum(amount_paise) s from expenses where centre_id = p_centre and status = 'ok' and expense_date >= v_month group by category) x),
    'new_customers_month', (select count(*) from customers where centre_id = p_centre and created_at >= v_mstart),
    'customers_total', (select count(*) from customers where centre_id = p_centre and status = 'active'),
    'team_total', (select count(*) from centre_staff where centre_id = p_centre and status = 'active'),
    'low_stock', (select count(*) from products where centre_id = p_centre and status = 'active' and kind = 'retail' and stock_qty <= reorder_level),
    'birthdays_week', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name,'phone',phone,'date',date_of_birth)),'[]') from customers
        where centre_id = p_centre and date_of_birth is not null and status = 'active'
          and ((extract(doy from date_of_birth)::int - extract(doy from v_today)::int + 366) % 366) between 0 and 6),
    'last7', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'v', v) order by d),'[]') from (
        select g::date d, coalesce((select sum(total_paise) from bills b where b.centre_id = p_centre and b.status <> 'void'
          and (b.created_at at time zone c.timezone)::date = g::date),0) v
        from generate_series(v_today - 6, v_today, interval '1 day') g) x)
  );
end $$;

-- ───────────────────────── Grants ─────────────────────────
revoke execute on all functions in schema public from public, anon;
revoke execute on function public._session_seconds(uuid,timestamptz), public._session_intervals(uuid,timestamptz),
  public._rate_at(rate_cards,text,timestamptz), public._price_session(uuid,timestamptz), public._tab_preview(uuid),
  public._shift_figures(uuid,timestamptz,timestamptz), public._floor_resources(uuid,boolean), public._fmt_minutes(int)
  from authenticated;
grant execute on function
  public.price_session(uuid), public.set_session_frames(uuid,uuid,int),
  public.tab_add_item(uuid,uuid,uuid,numeric,text,bigint), public.tab_remove_item(uuid,uuid), public.tab_preview(uuid,uuid),
  public.tab_set_customer(uuid,uuid,text,text), public.close_tab(uuid,uuid,bigint,text,jsonb,uuid),
  public.add_payment(uuid,uuid,text,bigint,text), public.void_bill(uuid,uuid,text),
  public.open_shift(uuid,bigint), public.current_shift(uuid), public.close_shift(uuid,bigint,text),
  public.floor_state(uuid), public.dashboard_summary(uuid), public.session_billable_seconds(uuid,timestamptz),
  public.tv_link(uuid,text,text,text), public.tv_revoke(uuid,uuid)
to authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text) to anon, authenticated;
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.tabs, public.tab_items, public.bills;
  end if;
end $$;
