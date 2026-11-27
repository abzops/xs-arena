-- XS Arena — booking advance by the centre's own UPI QR (owner's choice, off by default; replaces the Razorpay plan),
-- and the Snacks & stock add-on free during the pilot (owners turn it on themselves).
--
-- Advance: the ticket page shows the centre's UPI QR with the advance amount; staff tap "Advance received" in Bookings;
-- when that customer's bill is closed the advance is added as a UPI payment ("Advance · <code>"). The bill total itself
-- is unchanged (GST and revenue stay right). If the game cost less than the advance, the bill says what to give back.

-- The owner switches the advance on (off for everyone to start; online payments were never switched on).
-- booking_advance_bp stays the percent; with the switch off nobody is asked to pay it.
alter table public.centres add column booking_advance_on boolean not null default false;
grant update (booking_advance_on) on public.centres to authenticated;

-- Public pages need to know whether to ask for the advance.
create or replace function public._public_profile(c centres)
returns jsonb language sql stable as $$
  select jsonb_build_object('logo_path', c.logo_path, 'cover_path', c.cover_path, 'about', c.about,
    'maps_url', c.maps_url, 'instagram', c.instagram, 'advance_on', c.booking_advance_on and c.booking_advance_bp > 0);
$$;

alter table public.bookings add column advance_bill_id uuid references public.bills(id);

-- Staff mark the advance as received (or undo a mistake before it is on a bill).
create or replace function public.mark_booking_advance(p_centre uuid, p_booking uuid, p_received boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bookings;
begin
  perform require_perm(p_centre, 'floor.operate');
  select * into b from bookings where id = p_booking and centre_id = p_centre for update;
  if not found then raise exception 'Booking not found'; end if;
  if b.advance_paise <= 0 then raise exception 'This booking has no advance'; end if;
  if b.advance_bill_id is not null then raise exception 'The advance is already on bill %', (select bill_no from bills where id = b.advance_bill_id); end if;
  if p_received and b.status in ('cancelled', 'no_show') then raise exception 'This booking was %', replace(b.status, '_', '-'); end if;
  update bookings set paid_paise = case when p_received then advance_paise else 0 end,
    payment_status = case when p_received then 'paid' else 'pay_at_counter' end
  where id = b.id returning * into b;
  perform log_audit(p_centre, case when p_received then 'advance_received' else 'advance_undone' end, 'booking', b.id,
    jsonb_build_object('code', b.code, 'amount', b.advance_paise));
  return _booking_json(b, true);
end $$;

-- Advance already paid for the games on this bill (not yet used on a bill).
create or replace function public._tab_advance(p_tab uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(b.paid_paise), 0)::bigint from bookings b join sessions s on s.id = b.session_id
  where s.tab_id = p_tab and b.advance_bill_id is null and b.paid_paise > 0;
$$;

-- Bill preview: same as before plus the advance paid.
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
    'live', exists (select 1 from sessions where tab_id = p_tab and status in ('running','paused')),
    'advance_paise', _tab_advance(p_tab));
end $$;

-- Closing a bill: unchanged (renamed), then the advance is added as a UPI payment.
alter function public.close_tab(uuid,uuid,bigint,text,jsonb,uuid,integer,text) rename to _close_tab_base;
create function public.close_tab(p_centre uuid, p_tab uuid, p_discount_paise bigint default 0, p_discount_reason text default null,
  p_payments jsonb default '[]', p_key uuid default null, p_points integer default 0, p_reward text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; v_adv bigint; v_use bigint; bl bills; v_codes text;
begin
  -- lock the advance before the bill is made, so two closes can't both use it
  perform 1 from bookings b join sessions s on s.id = b.session_id where s.tab_id = p_tab and b.advance_bill_id is null for update of b;
  v_adv := _tab_advance(p_tab);
  v := _close_tab_base(p_centre, p_tab, p_discount_paise, p_discount_reason, p_payments, p_key, p_points, p_reward);
  if coalesce((v->>'duplicate')::boolean, false) or v_adv <= 0 then return v; end if;
  select * into bl from bills where id = (v->>'bill_id')::uuid for update;
  v_use := least(v_adv, greatest(bl.total_paise - bl.paid_paise, 0));
  select string_agg(b.code, ', ' order by b.code) into v_codes from bookings b join sessions s on s.id = b.session_id
    where s.tab_id = p_tab and b.advance_bill_id is null and b.paid_paise > 0;
  if v_use > 0 then
    insert into payments(centre_id, bill_id, method, amount_paise, reference, created_by)
    values (p_centre, bl.id, 'upi', v_use, 'Advance · ' || v_codes, auth.uid());
    update bills set paid_paise = paid_paise + v_use,
      status = case when paid_paise + v_use >= total_paise then 'paid' when paid_paise + v_use > 0 then 'partial' else 'unpaid' end
    where id = bl.id returning * into bl;
  end if;
  update bookings b set advance_bill_id = bl.id from sessions s
    where s.id = b.session_id and s.tab_id = p_tab and b.advance_bill_id is null and b.paid_paise > 0;
  perform log_audit(p_centre, 'advance_used', 'bill', bl.id, jsonb_build_object('advance', v_adv, 'used', v_use, 'bookings', v_codes));
  return v || jsonb_build_object('paid_paise', bl.paid_paise, 'status', bl.status, 'advance_paise', v_adv, 'advance_used_paise', v_use,
    'advance_refund_paise', v_adv - v_use);
end $$;

-- Snacks & stock: free during the pilot — the owner turns it on in Settings → Plan.
create or replace function public._pilot_free_addons() returns boolean language sql immutable as $$ select true $$;
create or replace function public.claim_free_addon(p_centre uuid, p_addon text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm(p_centre, 'settings.manage');
  if p_addon is distinct from 'snacks' then raise exception 'Unknown add-on'; end if;
  if not _pilot_free_addons() then raise exception 'Contact Xelorsoft to add this to your plan'; end if;
  insert into centre_addons(centre_id, addon, active) values (p_centre, p_addon, true)
  on conflict (centre_id, addon) do update set active = true;
  perform log_audit(p_centre, 'addon_on', 'centre', p_centre, jsonb_build_object('addon', p_addon, 'free', 'pilot'));
end $$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public._close_tab_base(uuid,uuid,bigint,text,jsonb,uuid,integer,text), public._tab_advance(uuid), public._public_profile(centres) from authenticated;
grant execute on function public.close_tab(uuid,uuid,bigint,text,jsonb,uuid,integer,text), public.mark_booking_advance(uuid,uuid,boolean),
  public.claim_free_addon(uuid,text) to authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int,text),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
