-- XS Arena — loyalty: fixed rewards and tiers.
-- Rewards: owner lists things like "500 points = 30 min snooker free" (points + rupee value). Front desk picks one at checkout;
--   it takes its own points and value (no percent cap, never more than the bill).
-- Tiers: e.g. Silver from 500 points earned (1.25×), Gold from 2,000 (1.5×). Lifetime = points earned on bills
--   (voided bills taken back). The multiplier applies to new earnings only; past points never change.

alter table public.loyalty_settings
  add column rewards jsonb not null default '[]' check (jsonb_typeof(rewards) = 'array'),
  add column tiers jsonb not null default '[]' check (jsonb_typeof(tiers) = 'array');

-- Points earned from bills over all time (bills later voided don't count).
create or replace function public._loyalty_lifetime(p_customer uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(l.points), 0)::int from loyalty_ledger l
  where l.customer_id = p_customer and l.kind = 'earn'
    and not exists (select 1 from bills b where b.id = l.bill_id and b.status = 'void');
$$;

-- Highest tier reached, or null.
create or replace function public._loyalty_tier(p_tiers jsonb, p_lifetime int)
returns jsonb language sql immutable set search_path = public as $$
  select t from jsonb_array_elements(coalesce(p_tiers,'[]')) t
  where (t->>'min_points')::int <= p_lifetime order by (t->>'min_points')::int desc limit 1;
$$;

create or replace function public._loyalty_earn(p_centre uuid, p_customer uuid, p_bill uuid)
returns integer language plpgsql volatile security definer set search_path = public as $$
declare ls loyalty_settings; b bills; c centres; cu customers; g jsonb; v_tier jsonb; v_base numeric := 0; v_pts int := 0; v_exp timestamptz; v_total int := 0;
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
  v_tier := _loyalty_tier(ls.tiers, _loyalty_lifetime(p_customer));
  v_pts := floor(v_base * ls.earn_points_per_100 / 10000 * coalesce((v_tier->>'multiplier')::numeric, 1))::int;

  if ls.welcome_points > 0 and not exists (select 1 from loyalty_ledger where customer_id = p_customer) then
    insert into loyalty_ledger(centre_id, customer_id, points, kind, bill_id, note, expires_at)
    values (p_centre, p_customer, ls.welcome_points, 'welcome', p_bill, 'Welcome bonus', v_exp);
    v_total := v_total + ls.welcome_points;
  end if;
  if v_pts > 0 then
    insert into loyalty_ledger(centre_id, customer_id, points, kind, bill_id, note, expires_at)
    values (p_centre, p_customer, v_pts, 'earn', p_bill, b.bill_no || coalesce(' · ' || (v_tier->>'name'), ''), v_exp);
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

drop function public.close_tab(uuid,uuid,bigint,text,jsonb,uuid,integer);
create or replace function public.close_tab(p_centre uuid, p_tab uuid, p_discount_paise bigint default 0, p_discount_reason text default null,
  p_payments jsonb default '[]', p_key uuid default null, p_points integer default 0, p_reward text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t tabs; c centres; b bills; v_prev jsonb; v_sub bigint; v_disc bigint := greatest(coalesce(p_discount_paise,0),0); v_net bigint;
  v_tax bigint := 0; v_taxable bigint; v_total bigint; v_rate int := 0; v_paid bigint := 0; pay jsonb; v_status text; v_no text; sid uuid; v_id uuid;
  ls loyalty_settings; v_pts int := greatest(coalesce(p_points,0),0); v_pts_paise bigint := 0; v_earn int := 0; v_rw jsonb;
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
  if v_pts > 0 or p_reward is not null then
    if t.customer_id is null then raise exception 'Add the customer''s phone to use points'; end if;
    select * into ls from loyalty_settings where centre_id = p_centre;
    if not found or not ls.enabled or not has_feature(p_centre, 'loyalty') then raise exception 'Loyalty points are off'; end if;
    perform 1 from customers where id = t.customer_id for update;
    perform _loyalty_expire(t.customer_id);
    if p_reward is not null then
      -- a fixed reward ("500 points = 30 min free"): its own points and value; no percent cap, never more than the bill
      select r into v_rw from jsonb_array_elements(ls.rewards) r where r->>'id' = p_reward;
      if v_rw is null then raise exception 'That reward is no longer offered'; end if;
      v_pts := (v_rw->>'points')::int;
      v_pts_paise := least((v_rw->>'value_paise')::bigint, v_sub - v_disc);
      if v_pts > (select coalesce(sum(points),0) from loyalty_ledger where customer_id = t.customer_id) then raise exception 'Not enough points'; end if;
    else
      if v_pts < ls.min_redeem_points then raise exception 'Use at least % points', ls.min_redeem_points; end if;
      if v_pts > (select coalesce(sum(points),0) from loyalty_ledger where customer_id = t.customer_id) then raise exception 'Not enough points'; end if;
      v_pts_paise := v_pts::bigint * ls.point_value_paise;
      if v_pts_paise > floor((v_sub - v_disc) * ls.max_redeem_pct / 100.0) then
        raise exception 'Points can pay at most % percent of this bill', ls.max_redeem_pct;
      end if;
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
    values (p_centre, t.customer_id, -v_pts, 'redeem', v_id, v_no || coalesce(' · ' || (v_rw->>'name'), ''), auth.uid());
  end if;
  if t.customer_id is not null then v_earn := _loyalty_earn(p_centre, t.customer_id, v_id); end if;
  perform log_audit(p_centre, 'create', 'bill', v_id, jsonb_build_object('no', v_no, 'total', v_total, 'discount', v_disc), nullif(trim(coalesce(p_discount_reason,'')),''));
  return jsonb_build_object('bill_id', v_id, 'bill_no', v_no, 'total_paise', v_total, 'paid_paise', v_paid, 'status', v_status,
    'points_earned', v_earn, 'points_used', v_pts, 'reward', v_rw->>'name');
end $$;

create or replace function public.customer_points(p_centre uuid, p_customer uuid, p_bill_paise bigint default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare ls loyalty_settings; v_bal int; v_max int; v_step int; v_life int; v_tier jsonb; v_next jsonb;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from customers where id = p_customer and centre_id = p_centre) then raise exception 'Customer not found'; end if;
  select * into ls from loyalty_settings where centre_id = p_centre;
  if not found or not ls.enabled or not has_feature(p_centre, 'loyalty') then return jsonb_build_object('enabled', false); end if;
  perform _loyalty_expire(p_customer);
  select coalesce(sum(points),0)::int into v_bal from loyalty_ledger where customer_id = p_customer;
  v_max := case when p_bill_paise is null then v_bal
    else least(v_bal, floor(floor(p_bill_paise * ls.max_redeem_pct / 100.0) / ls.point_value_paise))::int end;
  -- suggest a number of points worth whole rupees (e.g. 154 × ₹0.50 = ₹77, not 155 = ₹77.50)
  v_life := _loyalty_lifetime(p_customer);
  v_tier := _loyalty_tier(ls.tiers, v_life);
  select t into v_next from jsonb_array_elements(ls.tiers) t where (t->>'min_points')::int > v_life order by (t->>'min_points')::int limit 1;
  v_step := 100 / gcd(100, ls.point_value_paise);
  v_max := v_max - (v_max % v_step);
  return jsonb_build_object('enabled', true, 'balance', v_bal, 'value_paise', v_bal::bigint * ls.point_value_paise,
    'point_value_paise', ls.point_value_paise, 'min_redeem', ls.min_redeem_points,
    'usable', case when v_max >= ls.min_redeem_points then v_max else 0 end,
    'lifetime', v_life, 'tier', v_tier, 'next_tier', v_next,
    'rewards', (select coalesce(jsonb_agg(r || jsonb_build_object('affordable', v_bal >= (r->>'points')::int) order by (r->>'points')::int), '[]')
      from jsonb_array_elements(ls.rewards) r),
    'next_expiry', (select min(expires_at) from loyalty_ledger where customer_id = p_customer and points > 0 and expires_at > now()),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('points', points, 'kind', kind, 'note', note, 'at', created_at) order by id desc), '[]')
      from (select * from loyalty_ledger where customer_id = p_customer order by id desc limit 30) h));
end $$;

create or replace function public.loyalty_settings_get(p_centre uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ls loyalty_settings;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  select * into ls from loyalty_settings where centre_id = p_centre;
  if not found then ls.centre_id := p_centre; ls.enabled := true; ls.earn_points_per_100 := 10; ls.earn_on_snacks := false;
    ls.point_value_paise := 50; ls.min_redeem_points := 100; ls.max_redeem_pct := 50; ls.welcome_points := 50; ls.birthday_points := 100;
    ls.expiry_months := 12; ls.multipliers := '{}'; ls.happy_hours := '[]'; ls.rewards := '[]'; ls.tiers := '[]'; end if;
  return to_jsonb(ls) - 'updated_by' || jsonb_build_object('available', has_feature(p_centre, 'loyalty'));
end $$;

-- Rewards / tiers are checked and cleaned here; other rules as before.
create or replace function public.save_loyalty_settings(p_centre uuid, p_settings jsonb)
returns void language plpgsql volatile security definer set search_path = public as $$
declare s jsonb := coalesce(p_settings, '{}'); r jsonb; v_rewards jsonb := '[]'; v_tiers jsonb := '[]';
begin
  perform require_perm(p_centre, 'loyalty.manage');
  perform require_feature(p_centre, 'loyalty');
  if s ? 'rewards' then
    for r in select * from jsonb_array_elements(s->'rewards') loop
      if coalesce(trim(r->>'name'),'') = '' then raise exception 'Give each reward a name'; end if;
      if coalesce((r->>'points')::int, 0) <= 0 or coalesce((r->>'value_paise')::bigint, 0) <= 0 then
        raise exception 'Reward "%" needs points and a rupee value', r->>'name';
      end if;
      v_rewards := v_rewards || jsonb_build_object('id', coalesce(nullif(r->>'id',''), gen_random_uuid()::text), 'name', left(trim(r->>'name'), 60),
        'points', (r->>'points')::int, 'value_paise', (r->>'value_paise')::bigint);
    end loop;
  end if;
  if s ? 'tiers' then
    for r in select * from jsonb_array_elements(s->'tiers') order by (value->>'min_points')::int loop
      if coalesce(trim(r->>'name'),'') = '' then raise exception 'Give each tier a name'; end if;
      if coalesce((r->>'min_points')::int, -1) < 0 or coalesce((r->>'multiplier')::numeric, 0) < 1 or (r->>'multiplier')::numeric > 5 then
        raise exception 'Tier "%" needs points from 0 and extra earning between 1× and 5×', r->>'name';
      end if;
      v_tiers := v_tiers || jsonb_build_object('name', left(trim(r->>'name'), 30), 'min_points', (r->>'min_points')::int, 'multiplier', (r->>'multiplier')::numeric);
    end loop;
  end if;
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
    rewards = case when s ? 'rewards' then v_rewards else rewards end,
    tiers = case when s ? 'tiers' then v_tiers else tiers end,
    updated_by = auth.uid(), updated_at = now()
  where centre_id = p_centre;
  perform log_audit(p_centre, 'update', 'loyalty_settings', p_centre, s);
end $$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public._loyalty_lifetime(uuid), public._loyalty_tier(jsonb,int), public._loyalty_earn(uuid,uuid,uuid) from authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
grant execute on function public.close_tab(uuid,uuid,bigint,text,jsonb,uuid,integer,text), public.customer_points(uuid,uuid,bigint),
  public.loyalty_settings_get(uuid), public.save_loyalty_settings(uuid,jsonb) to authenticated;
