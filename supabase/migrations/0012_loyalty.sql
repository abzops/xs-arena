-- XS Arena — Phase 2: loyalty points.
-- Owner sets every rule (earn rate, game multipliers, happy hours, point value, redeem limits, welcome/birthday bonus, expiry).
-- Points live in an append-only ledger: changing the settings never changes points already given or used.
-- Earned when a bill closes; spent as a "points" deduction on a bill (front desk can apply, owner sets the limits);
-- a void gives back used points and takes back earned ones.

create table public.loyalty_settings (
  centre_id uuid primary key references public.centres(id) on delete cascade,
  enabled boolean not null default false,
  earn_points_per_100 integer not null default 10 check (earn_points_per_100 between 0 and 1000),   -- points per ₹100 paid
  earn_on_snacks boolean not null default false,
  point_value_paise integer not null default 50 check (point_value_paise between 1 and 10000),        -- 1 point = ₹0.50
  min_redeem_points integer not null default 100 check (min_redeem_points between 1 and 100000),
  max_redeem_pct integer not null default 50 check (max_redeem_pct between 1 and 100),
  welcome_points integer not null default 50 check (welcome_points between 0 and 100000),
  birthday_points integer not null default 100 check (birthday_points between 0 and 100000),
  expiry_months integer check (expiry_months is null or expiry_months between 1 and 60),                -- null = never
  multipliers jsonb not null default '{}' check (jsonb_typeof(multipliers) = 'object'),               -- {activity_id: 2}
  happy_hours jsonb not null default '[]' check (jsonb_typeof(happy_hours) = 'array'),               -- [{label,days[],start,end,multiplier}]
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.loyalty_settings enable row level security;
create policy loyalty_settings_read on public.loyalty_settings for select to authenticated using (is_centre_member(centre_id));
grant select on public.loyalty_settings to authenticated;

create table public.loyalty_ledger (
  id bigint generated always as identity primary key,
  centre_id uuid not null references public.centres(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  points integer not null check (points <> 0),
  kind text not null check (kind in ('earn','redeem','welcome','birthday','adjust','expire','reverse')),
  bill_id uuid references public.bills(id),
  note text,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index loyalty_ledger_customer_idx on public.loyalty_ledger(customer_id, created_at);
create index loyalty_ledger_bill_idx on public.loyalty_ledger(bill_id) where bill_id is not null;
alter table public.loyalty_ledger enable row level security;
create policy loyalty_ledger_read on public.loyalty_ledger for select to authenticated using (is_centre_member(centre_id));
grant select on public.loyalty_ledger to authenticated;

create or replace function public._ledger_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'Points history cannot be changed'; end if;
  if not exists (select 1 from customers where id = old.customer_id) then return old; end if;
  raise exception 'Points history cannot be deleted';
end $$;
create trigger loyalty_ledger_immutable before update or delete on public.loyalty_ledger
  for each row execute function public._ledger_immutable();

alter table public.bills
  add column points_redeemed integer not null default 0 check (points_redeemed >= 0),
  add column points_paise bigint not null default 0 check (points_paise >= 0);

-- Expired points (oldest are used first): add one 'expire' row for whatever has expired and not been used.
create or replace function public._loyalty_expire(p_customer uuid)
returns integer language plpgsql volatile security definer set search_path = public as $$
declare v_exp bigint; v_used bigint; v_done bigint; v_due int;
begin
  select coalesce(sum(points) filter (where points > 0 and expires_at is not null and expires_at <= now()), 0),
         coalesce(-sum(points) filter (where points < 0 and kind <> 'expire'), 0),
         coalesce(-sum(points) filter (where kind = 'expire'), 0)
    into v_exp, v_used, v_done from loyalty_ledger where customer_id = p_customer;
  v_due := greatest(0, least(v_exp - v_used - v_done, (select coalesce(sum(points),0) from loyalty_ledger where customer_id = p_customer)))::int;
  if v_due > 0 then
    insert into loyalty_ledger(centre_id, customer_id, points, kind, note)
    select centre_id, id, -v_due, 'expire', 'Expired' from customers where id = p_customer;
  end if;
  return v_due;
end $$;

-- Happy-hour multiplier for a moment (1 when no rule matches).
create or replace function public._loyalty_hh(p_rules jsonb, p_tz text, p_at timestamptz)
returns numeric language plpgsql stable set search_path = public as $$
declare r jsonb; v_local timestamp := p_at at time zone p_tz; v_dow int := extract(dow from v_local)::int; v_t time := v_local::time; v_s time; v_e time;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rules,'[]')) loop
    if r->'days' @> to_jsonb(v_dow) then
      v_s := (r->>'start')::time; v_e := (r->>'end')::time;
      if (v_s < v_e and v_t >= v_s and v_t < v_e) or (v_s >= v_e and (v_t >= v_s or v_t < v_e)) then
        return greatest(coalesce((r->>'multiplier')::numeric, 1), 0);
      end if;
    end if;
  end loop;
  return 1;
end $$;

-- Points for a closed bill: games × game multiplier × happy hour (+ snacks if on), scaled down by discounts / points used.
-- Also gives the welcome bonus on a customer's first points and the birthday bonus once a year.
create or replace function public._loyalty_earn(p_centre uuid, p_customer uuid, p_bill uuid)
returns integer language plpgsql volatile security definer set search_path = public as $$
declare ls loyalty_settings; b bills; c centres; cu customers; g jsonb; v_base numeric := 0; v_pts int := 0; v_exp timestamptz; v_total int := 0;
begin
  select * into ls from loyalty_settings where centre_id = p_centre;
  if not found or not ls.enabled or not has_feature(p_centre, 'loyalty') then return 0; end if;
  select * into b from bills where id = p_bill;
  select * into c from centres where id = p_centre;
  select * into cu from customers where id = p_customer;
  v_exp := case when ls.expiry_months is null then null else now() + make_interval(months => ls.expiry_months) end;
  for g in select * from jsonb_array_elements(b.lines->'games') loop
    v_base := v_base + (g->>'amount_paise')::numeric
      * coalesce((ls.multipliers->>(g->>'activity_id'))::numeric, 1)
      * _loyalty_hh(ls.happy_hours, c.timezone, coalesce((g->>'started_at')::timestamptz, b.created_at));
  end loop;
  if ls.earn_on_snacks then
    v_base := v_base + coalesce((select sum((i->>'total_paise')::numeric) from jsonb_array_elements(b.lines->'items') i), 0);
  end if;
  if b.subtotal_paise > 0 then v_base := v_base * (b.subtotal_paise - b.discount_paise - b.points_paise) / b.subtotal_paise; end if;
  v_pts := floor(v_base * ls.earn_points_per_100 / 10000)::int;

  if ls.welcome_points > 0 and not exists (select 1 from loyalty_ledger where customer_id = p_customer) then
    insert into loyalty_ledger(centre_id, customer_id, points, kind, bill_id, note, expires_at)
    values (p_centre, p_customer, ls.welcome_points, 'welcome', p_bill, 'Welcome bonus', v_exp);
    v_total := v_total + ls.welcome_points;
  end if;
  if v_pts > 0 then
    insert into loyalty_ledger(centre_id, customer_id, points, kind, bill_id, note, expires_at)
    values (p_centre, p_customer, v_pts, 'earn', p_bill, b.bill_no, v_exp);
    v_total := v_total + v_pts;
  end if;
  if ls.birthday_points > 0 and cu.date_of_birth is not null
     and to_char(cu.date_of_birth, 'MMDD') = to_char(now() at time zone c.timezone, 'MMDD')
     and not exists (select 1 from loyalty_ledger where customer_id = p_customer and kind = 'birthday' and created_at > now() - interval '300 days') then
    insert into loyalty_ledger(centre_id, customer_id, points, kind, bill_id, note, expires_at)
    values (p_centre, p_customer, ls.birthday_points, 'birthday', p_bill, 'Happy birthday!', v_exp);
    v_total := v_total + ls.birthday_points;
  end if;
  return v_total;
end $$;

-- ───────────────────────── Billing: use + earn points ─────────────────────────
drop function public.close_tab(uuid,uuid,bigint,text,jsonb,uuid);
create or replace function public.close_tab(p_centre uuid, p_tab uuid, p_discount_paise bigint default 0, p_discount_reason text default null,
  p_payments jsonb default '[]', p_key uuid default null, p_points integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t tabs; c centres; b bills; v_prev jsonb; v_sub bigint; v_disc bigint := greatest(coalesce(p_discount_paise,0),0); v_net bigint;
  v_tax bigint := 0; v_taxable bigint; v_total bigint; v_rate int := 0; v_paid bigint := 0; pay jsonb; v_status text; v_no text; sid uuid; v_id uuid;
  ls loyalty_settings; v_pts int := greatest(coalesce(p_points,0),0); v_pts_paise bigint := 0; v_earn int := 0;
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
  -- loyalty points used on this bill (front desk may apply them; limits come from the owner's settings)
  if v_pts > 0 then
    if t.customer_id is null then raise exception 'Add the customer''s phone to use points'; end if;
    select * into ls from loyalty_settings where centre_id = p_centre;
    if not found or not ls.enabled or not has_feature(p_centre, 'loyalty') then raise exception 'Loyalty points are off'; end if;
    perform 1 from customers where id = t.customer_id for update;
    perform _loyalty_expire(t.customer_id);
    if v_pts < ls.min_redeem_points then raise exception 'Use at least % points', ls.min_redeem_points; end if;
    if v_pts > (select coalesce(sum(points),0) from loyalty_ledger where customer_id = t.customer_id) then raise exception 'Not enough points'; end if;
    v_pts_paise := v_pts::bigint * ls.point_value_paise;
    if v_pts_paise > floor((v_sub - v_disc) * ls.max_redeem_pct / 100.0) then
      raise exception 'Points can pay at most % percent of this bill', ls.max_redeem_pct;
    end if;
  end if;
  v_net := v_sub - v_disc - v_pts_paise;
  select * into c from centres where id = p_centre for update;
  if c.gst_enabled then
    v_rate := c.gst_rate_bp;
    if c.prices_include_tax then v_total := v_net; v_tax := round(v_net::numeric * v_rate / (10000 + v_rate)); v_taxable := v_net - v_tax;
    else v_taxable := v_net; v_tax := round(v_net::numeric * v_rate / 10000); v_total := v_net + v_tax; end if;
  else v_taxable := v_net; v_total := v_net; end if;

  update centres set invoice_seq = invoice_seq + 1 where id = p_centre returning invoice_prefix || '-' || to_char(now() at time zone timezone, 'YYMM') || '-' || lpad(invoice_seq::text, 4, '0') into v_no;
  insert into bills(centre_id, tab_id, bill_no, customer_id, subtotal_paise, discount_paise, discount_reason, taxable_paise, tax_paise,
    gst_rate_bp, total_paise, lines, idempotency_key, created_by, points_redeemed, points_paise)
  values (p_centre, p_tab, v_no, t.customer_id, v_sub, v_disc, nullif(trim(coalesce(p_discount_reason,'')),''), v_taxable, v_tax,
    v_rate, v_total, jsonb_build_object('games', v_prev->'games', 'items', v_prev->'items'), p_key, auth.uid(), v_pts, v_pts_paise)
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
  if v_pts > 0 then
    insert into loyalty_ledger(centre_id, customer_id, points, kind, bill_id, note, created_by)
    values (p_centre, t.customer_id, -v_pts, 'redeem', v_id, v_no, auth.uid());
  end if;
  if t.customer_id is not null then v_earn := _loyalty_earn(p_centre, t.customer_id, v_id); end if;
  perform log_audit(p_centre, 'create', 'bill', v_id, jsonb_build_object('no', v_no, 'total', v_total, 'discount', v_disc), nullif(trim(coalesce(p_discount_reason,'')),''));
  return jsonb_build_object('bill_id', v_id, 'bill_no', v_no, 'total_paise', v_total, 'paid_paise', v_paid, 'status', v_status,
    'points_earned', v_earn, 'points_used', v_pts);
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
  -- give back points used and take back points earned on this bill
  insert into loyalty_ledger(centre_id, customer_id, points, kind, bill_id, note, created_by)
  select p_centre, l.customer_id, -sum(l.points)::int, 'reverse', p_bill, 'Bill ' || b.bill_no || ' voided', auth.uid()
  from loyalty_ledger l where l.bill_id = p_bill and l.kind in ('earn','redeem','welcome','birthday')
  group by l.customer_id having sum(l.points) <> 0;
  perform log_audit(p_centre, 'void', 'bill', p_bill, jsonb_build_object('no', b.bill_no, 'total', b.total_paise), trim(p_reason));
end $$;
-- ───────────────────────── Read + settings ─────────────────────────
create or replace function public.loyalty_settings_get(p_centre uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ls loyalty_settings;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  select * into ls from loyalty_settings where centre_id = p_centre;
  if not found then ls.centre_id := p_centre; ls.enabled := false; ls.earn_points_per_100 := 10; ls.earn_on_snacks := false;
    ls.point_value_paise := 50; ls.min_redeem_points := 100; ls.max_redeem_pct := 50; ls.welcome_points := 50; ls.birthday_points := 100;
    ls.expiry_months := 12; ls.multipliers := '{}'; ls.happy_hours := '[]'; end if;
  return to_jsonb(ls) - 'updated_by' || jsonb_build_object('available', has_feature(p_centre, 'loyalty'));
end $$;

create or replace function public.save_loyalty_settings(p_centre uuid, p_settings jsonb)
returns void language plpgsql volatile security definer set search_path = public as $$
declare s jsonb := coalesce(p_settings, '{}');
begin
  perform require_perm(p_centre, 'loyalty.manage');
  perform require_feature(p_centre, 'loyalty');
  insert into loyalty_settings(centre_id) values (p_centre) on conflict do nothing;
  update loyalty_settings set
    enabled = coalesce((s->>'enabled')::boolean, enabled),
    earn_points_per_100 = coalesce((s->>'earn_points_per_100')::int, earn_points_per_100),
    earn_on_snacks = coalesce((s->>'earn_on_snacks')::boolean, earn_on_snacks),
    point_value_paise = coalesce((s->>'point_value_paise')::int, point_value_paise),
    min_redeem_points = coalesce((s->>'min_redeem_points')::int, min_redeem_points),
    max_redeem_pct = coalesce((s->>'max_redeem_pct')::int, max_redeem_pct),
    welcome_points = coalesce((s->>'welcome_points')::int, welcome_points),
    birthday_points = coalesce((s->>'birthday_points')::int, birthday_points),
    expiry_months = case when s ? 'expiry_months' then (s->>'expiry_months')::int else expiry_months end,
    multipliers = coalesce(s->'multipliers', multipliers),
    happy_hours = coalesce(s->'happy_hours', happy_hours),
    updated_by = auth.uid(), updated_at = now()
  where centre_id = p_centre;
  perform log_audit(p_centre, 'update', 'loyalty_settings', p_centre, s);
end $$;

-- A customer's points: balance, rupee value, what they can use on a bill of p_bill_paise, and recent history.
create or replace function public.customer_points(p_centre uuid, p_customer uuid, p_bill_paise bigint default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare ls loyalty_settings; v_bal int; v_max int;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from customers where id = p_customer and centre_id = p_centre) then raise exception 'Customer not found'; end if;
  select * into ls from loyalty_settings where centre_id = p_centre;
  if not found or not ls.enabled or not has_feature(p_centre, 'loyalty') then return jsonb_build_object('enabled', false); end if;
  perform _loyalty_expire(p_customer);
  select coalesce(sum(points),0)::int into v_bal from loyalty_ledger where customer_id = p_customer;
  v_max := case when p_bill_paise is null then v_bal
    else least(v_bal, floor(floor(p_bill_paise * ls.max_redeem_pct / 100.0) / ls.point_value_paise))::int end;
  return jsonb_build_object('enabled', true, 'balance', v_bal, 'value_paise', v_bal::bigint * ls.point_value_paise,
    'point_value_paise', ls.point_value_paise, 'min_redeem', ls.min_redeem_points,
    'usable', case when v_max >= ls.min_redeem_points then v_max else 0 end,
    'next_expiry', (select min(expires_at) from loyalty_ledger where customer_id = p_customer and points > 0 and expires_at > now()),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('points', points, 'kind', kind, 'note', note, 'at', created_at) order by id desc), '[]')
      from (select * from loyalty_ledger where customer_id = p_customer order by id desc limit 30) h));
end $$;

-- Manual correction by the owner/manager, with a reason.
create or replace function public.adjust_points(p_centre uuid, p_customer uuid, p_points integer, p_reason text)
returns integer language plpgsql volatile security definer set search_path = public as $$
declare ls loyalty_settings; v_bal int;
begin
  perform require_perm(p_centre, 'loyalty.manage');
  if coalesce(p_points,0) = 0 then raise exception 'Enter points to add or remove'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  if not exists (select 1 from customers where id = p_customer and centre_id = p_centre) then raise exception 'Customer not found'; end if;
  perform 1 from customers where id = p_customer for update;
  perform _loyalty_expire(p_customer);
  select coalesce(sum(points),0)::int into v_bal from loyalty_ledger where customer_id = p_customer;
  if v_bal + p_points < 0 then raise exception 'That would take the balance below zero (% points)', v_bal; end if;
  select * into ls from loyalty_settings where centre_id = p_centre;
  insert into loyalty_ledger(centre_id, customer_id, points, kind, note, expires_at, created_by)
  values (p_centre, p_customer, p_points, 'adjust', trim(p_reason),
    case when p_points > 0 and ls.expiry_months is not null then now() + make_interval(months => ls.expiry_months) end, auth.uid());
  perform log_audit(p_centre, 'adjust', 'points', p_customer, jsonb_build_object('points', p_points), trim(p_reason));
  return v_bal + p_points;
end $$;

-- ───────────────────────── Grants ─────────────────────────
revoke execute on all functions in schema public from public, anon;
revoke execute on function public._loyalty_expire(uuid), public._loyalty_hh(jsonb,text,timestamptz), public._loyalty_earn(uuid,uuid,uuid),
  public._ledger_immutable() from authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
grant execute on function public.close_tab(uuid,uuid,bigint,text,jsonb,uuid,integer), public.void_bill(uuid,uuid,text),
  public.loyalty_settings_get(uuid), public.save_loyalty_settings(uuid,jsonb), public.customer_points(uuid,uuid,bigint),
  public.adjust_points(uuid,uuid,integer,text)
  to authenticated;
-- flagged by the Supabase advisor: fixed search_path
alter function public._fmt_minutes(int) set search_path = public;
