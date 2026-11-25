-- XS Arena — staff choose per bill: time played (default) or the full booked time when a customer leaves early.
-- Abhinand, 25 Nov: "Staff choose per bill". The choice is stored on the game so the bill, the receipt and the totals agree.

alter table public.sessions add column if not exists charge_booked boolean not null default false;

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
    if s.charge_booked and v_planned is not null then v_bill_min := greatest(v_bill_min, v_planned); end if;
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
    -- minimum charge tops up at the normal price. When every minute played was at the normal price,
    -- the game is one line ("Minimum 30m") so it's rounded once: 30 min at ₹150/hr = ₹75, not ₹53 + ₹23.
    -- staff chose to charge the full booked time (customer left early): booked minutes top up like the minimum
    if s.charge_booked and v_planned is not null and v_i < v_planned and v_planned >= rc.min_minutes then
      if v_buckets = '{}'::jsonb or (select bool_and(key = 'Standard|' || rc.price_paise) from jsonb_each(v_buckets)) then
        v_buckets := jsonb_build_object('Booked|' || rc.price_paise, v_planned);
      else
        k := 'Booked, not played|' || rc.price_paise;
        v_buckets := jsonb_set(v_buckets, array[k], to_jsonb(v_planned - v_i));
      end if;
    elsif v_i < rc.min_minutes then
      if v_buckets = '{}'::jsonb or (select bool_and(key = 'Standard|' || rc.price_paise) from jsonb_each(v_buckets)) then
        v_buckets := jsonb_build_object('Minimum|' || rc.price_paise, rc.min_minutes);
      else
        k := 'Minimum charge|' || rc.price_paise;
        v_buckets := jsonb_set(v_buckets, array[k], to_jsonb(rc.min_minutes - v_i));
      end if;
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
      v_amt := round(greatest(v_i, rc.min_minutes, case when s.charge_booked then coalesce(v_planned, 0) else 0 end) * v_extra * rc.extra_player_paise / 60.0 / 100.0) * 100;
      v_lines := v_lines || jsonb_build_object('label', v_extra || ' extra player' || case when v_extra = 1 then '' else 's' end ||
        ' @ ₹' || (rc.extra_player_paise / 100) || '/hr', 'amount_paise', v_amt);
      v_total := v_total + v_amt;
    end if;
  end if;

  return jsonb_build_object('session_id', s.id, 'resource', r.name, 'activity', a.name, 'activity_id', a.id, 'mode', rc.billing_mode,
    'minutes', v_min, 'billable_seconds', v_secs, 'planned_minutes', s.planned_minutes, 'players', s.players, 'frames', s.frames,
    'started_at', s.started_at, 'ended_at', s.ended_at, 'status', s.status, 'lines', v_lines, 'amount_paise', v_total,
    'charge_booked', s.charge_booked);
end $$;

create or replace function public.set_charge_booked(p_centre uuid, p_session uuid, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare s sessions;
begin
  perform require_perm(p_centre, 'floor.operate');
  select * into s from sessions where id = p_session and centre_id = p_centre for update;
  if not found then raise exception 'Game not found'; end if;
  if s.status = 'void' then raise exception 'This game was cancelled'; end if;
  if s.planned_minutes is null then raise exception 'This game has no booked time'; end if;
  if exists (select 1 from tabs where id = s.tab_id and status <> 'open') then raise exception 'This game is already billed'; end if;
  if s.charge_booked is distinct from p_on then
    update sessions set charge_booked = p_on where id = p_session;
    perform log_audit(p_centre, 'update', 'session', p_session, jsonb_build_object('charge_booked', p_on, 'planned_minutes', s.planned_minutes), null);
  end if;
  return _price_session(p_session, now());
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.set_charge_booked(uuid, uuid, boolean) to authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
