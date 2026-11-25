-- XS Arena — front-desk fixes from the 24–25 Nov tablet test.
-- 1. Cancelling a game keeps snacks on the bill (before: the whole bill was voided and the snacks were lost).
-- 2. Moving a game to another table renames its open bill ("Pool 1 · Rahul" → "Pool 2 · Rahul").
-- 3. Every bill gets a secret share token for a public receipt link (/r/<token>) that customers can open without logging in.

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
  -- an open tab left with nothing in it is closed as void; snacks on it keep the bill open so they're still paid for
  update tabs set status = 'void', closed_at = now() where id = s.tab_id and status = 'open'
    and not exists (select 1 from sessions x where x.tab_id = s.tab_id and x.status <> 'void')
    and not exists (select 1 from tab_items i where i.tab_id = s.tab_id and i.status = 'ok');
  perform log_audit(p_centre, 'void', 'session', p_session, jsonb_build_object('resource', s.resource_id, 'started_at', s.started_at), trim(p_reason));
end $$;

create or replace function public.transfer_session(p_centre uuid, p_session uuid, p_to_resource uuid, p_client_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s sessions; r resources; v_from text;
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
    select name into v_from from resources where id = s.resource_id;
    update sessions set resource_id = p_to_resource where id = p_session;
    -- the bill was named after the old table: follow the game
    update tabs set label = r.name where id = s.tab_id and status = 'open' and label = v_from;
  end if;
  return jsonb_build_object('resource_id', p_to_resource);
end $$;

alter table public.bills add column if not exists share_token text unique
  default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
update public.bills set share_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') where share_token is null;

-- Public receipt, read only by the `receipt` Edge Function (service role). Shows what's on a paper receipt, nothing more.
create or replace function public._receipt_by_token(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bill_no', b.bill_no, 'created_at', b.created_at, 'status', b.status,
    'subtotal_paise', b.subtotal_paise, 'discount_paise', b.discount_paise, 'tax_paise', b.tax_paise, 'gst_rate_bp', b.gst_rate_bp,
    'total_paise', b.total_paise, 'paid_paise', b.paid_paise, 'lines', b.lines,
    'points_redeemed', b.points_redeemed, 'points_paise', b.points_paise, 'discount_reason', b.discount_reason,
    'customer', (select split_part(full_name, ' ', 1) from customers where id = b.customer_id),
    'centre', jsonb_build_object('name', c.name, 'slug', c.slug, 'phone', c.phone, 'address', c.address, 'city', c.city, 'timezone', c.timezone, 'gstin', c.gstin))
  from bills b join centres c on c.id = b.centre_id
  where length(p_token) >= 32 and b.share_token = p_token;
$$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public._receipt_by_token(text) from authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public._receipt_by_token(text) to service_role;
  end if;
end $$;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
