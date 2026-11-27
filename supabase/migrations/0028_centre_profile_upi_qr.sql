-- XS Arena — centre profile (logo, cover photo, about, map + Instagram links), the centre's own UPI QR, staff photos.
-- Pictures live in the public bucket "centre-media" under <centre id>/…: they are shown on the public booking page,
-- the ticket and receipt pages and the WhatsApp images anyway. Only settings managers upload centre pictures; each
-- team member uploads only their own photo (<centre id>/staff/<user id>/…).

alter table public.centres
  add column logo_path text,
  add column cover_path text,
  add column about text check (about is null or length(about) <= 300),
  add column maps_url text check (maps_url is null or maps_url ~ '^https://'),
  add column instagram text check (instagram is null or instagram ~ '^[A-Za-z0-9._]{1,30}$'),
  -- UPI: 'amount' = XS Arena draws a QR with the exact bill amount (from upi_id); 'own' = show the centre's uploaded QR as it is
  add column upi_qr_path text,
  add column upi_payee text check (upi_payee is null or length(upi_payee) <= 60),
  add column upi_mode text not null default 'amount' check (upi_mode in ('amount', 'own'));
alter table public.centres add constraint centres_media_paths check (
  (logo_path is null or logo_path like id::text || '/%') and (cover_path is null or cover_path like id::text || '/%')
  and (upi_qr_path is null or upi_qr_path like id::text || '/%'));
alter table public.centres add constraint centres_upi_own_needs_qr check (upi_mode = 'amount' or upi_qr_path is not null);
grant update (logo_path, cover_path, about, maps_url, instagram, upi_qr_path, upi_payee, upi_mode) on public.centres to authenticated;

alter table public.centre_staff add column avatar_path text;

-- A team member sets (or clears) their own photo.
create or replace function public.set_my_avatar(p_centre uuid, p_path text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_path is not null and p_path not like p_centre::text || '/staff/' || auth.uid()::text || '/%' then raise exception 'Invalid photo'; end if;
  update centre_staff set avatar_path = p_path where centre_id = p_centre and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'Not a member of this centre'; end if;
end $$;

-- Public pages get the profile too: keep booking_page / booking_ticket as they are (renamed) and add the profile on top.
create or replace function public._public_profile(c centres)
returns jsonb language sql stable as $$
  select jsonb_build_object('logo_path', c.logo_path, 'cover_path', c.cover_path, 'about', c.about,
    'maps_url', c.maps_url, 'instagram', c.instagram);
$$;

alter function public.booking_page(text) rename to _booking_page_base;
create function public.booking_page(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb := _booking_page_base(p_slug);
begin
  return jsonb_set(v, '{centre}', (v->'centre') || (select _public_profile(c) from centres c where c.slug = lower(trim(p_slug))));
end $$;

alter function public.booking_ticket(text) rename to _booking_ticket_base;
create function public.booking_ticket(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb := _booking_ticket_base(p_token);
begin
  return jsonb_set(v, '{centre}', (v->'centre') || (select _public_profile(c) from centres c where c.slug = v->'centre'->>'slug')
    || (select jsonb_build_object('upi_payee', c.upi_payee, 'upi_mode', c.upi_mode, 'upi_qr_path', c.upi_qr_path)
        from centres c where c.slug = v->'centre'->>'slug'));
end $$;

create or replace function public._receipt_by_token(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bill_no', b.bill_no, 'created_at', b.created_at, 'status', b.status,
    'subtotal_paise', b.subtotal_paise, 'discount_paise', b.discount_paise, 'tax_paise', b.tax_paise, 'gst_rate_bp', b.gst_rate_bp,
    'total_paise', b.total_paise, 'paid_paise', b.paid_paise, 'lines', b.lines,
    'points_redeemed', b.points_redeemed, 'points_paise', b.points_paise, 'discount_reason', b.discount_reason,
    'customer', (select split_part(full_name, ' ', 1) from customers where id = b.customer_id),
    'centre', jsonb_build_object('name', c.name, 'slug', c.slug, 'phone', c.phone, 'address', c.address, 'city', c.city,
      'timezone', c.timezone, 'gstin', c.gstin, 'logo_path', c.logo_path, 'instagram', c.instagram))
  from bills b join centres c on c.id = b.centre_id
  where length(p_token) >= 32 and b.share_token = p_token;
$$;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    values ('centre-media', 'centre-media', true, 3145728, array['image/jpeg','image/png','image/webp'])
    on conflict (id) do nothing;
    execute $p$create policy centre_media_add on storage.objects for insert to authenticated
      with check (bucket_id = 'centre-media' and (
        ((storage.foldername(name))[2] is distinct from 'staff' and public.has_perm(((storage.foldername(name))[1])::uuid, 'settings.manage'))
        or ((storage.foldername(name))[2] = 'staff' and (storage.foldername(name))[3] = auth.uid()::text
            and public.is_centre_member(((storage.foldername(name))[1])::uuid))))$p$;
    execute $p$create policy centre_media_list on storage.objects for select to authenticated
      using (bucket_id = 'centre-media' and public.is_centre_member(((storage.foldername(name))[1])::uuid))$p$;
    execute $p$create policy centre_media_remove on storage.objects for delete to authenticated
      using (bucket_id = 'centre-media' and (
        ((storage.foldername(name))[2] is distinct from 'staff' and public.has_perm(((storage.foldername(name))[1])::uuid, 'settings.manage'))
        or ((storage.foldername(name))[2] = 'staff' and (storage.foldername(name))[3] = auth.uid()::text)))$p$;
  end if;
end $$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public._booking_page_base(text), public._booking_ticket_base(text), public._public_profile(centres),
  public._receipt_by_token(text) from authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public._receipt_by_token(text) to service_role;
  end if;
end $$;
grant execute on function public.set_my_avatar(uuid, text) to authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int,text),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
