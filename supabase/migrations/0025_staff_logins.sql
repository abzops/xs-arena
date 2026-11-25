-- XS Arena — staff logins made by the owner: a username + password, no email or sign-up (same as XS Gym).
--
-- Flow (Edge Function `staff-login`):
--   1. prepare_staff_login     — as the signed-in owner: checks staff.manage and the team row, picks a free username.
--   2. the Edge Function makes the auth account with the service key:
--        email = <username>@staff.xelorsoft.com (internal, never mailed), already confirmed
--        app_metadata.xs_staff_centre / xs_staff_row (only the server can set these)
--   3. attach_staff_login      — as the signed-in owner: links that account to the team row. Audited.
-- Passwords are generated in the Edge Function, shown once to the owner, and never stored or logged by XS Arena.
-- Turning a team member off (Deactivate) already removes their access: is_centre_member checks status.

alter table public.centre_staff add column username text;
alter table public.centre_staff add constraint centre_staff_username_format
  check (username is null or (username ~ '^[a-z0-9]+(\.[a-z0-9]+)*$' and length(username) between 3 and 40));
create unique index centre_staff_username_uq on public.centre_staff(username) where username is not null;

create or replace function public._staff_login_domain()
returns text language sql immutable set search_path = public as $$ select 'staff.xelorsoft.com' $$;

-- Step 1: checks, and a free username like "ravi.xs".
create or replace function public.prepare_staff_login(p_centre uuid, p_staff uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s centre_staff; v_first text; v_tag text; v_base text; v_user text; v_n int := 1;
begin
  perform require_perm(p_centre, 'staff.manage');
  select * into s from centre_staff where id = p_staff and centre_id = p_centre;
  if not found then raise exception 'Team member not found'; end if;
  if s.status <> 'active' then raise exception 'Reactivate this team member first'; end if;
  if s.user_id is not null then raise exception 'This team member already has a login. Use Reset password instead.'; end if;
  if s.role not in ('manager', 'front_desk') then raise exception 'Logins can be made for managers and front desk staff'; end if;

  v_first := left(regexp_replace(lower(split_part(trim(s.display_name), ' ', 1)), '[^a-z0-9]', '', 'g'), 16);
  if length(v_first) < 2 then v_first := 'staff'; end if;  -- e.g. names typed in Malayalam
  select left(regexp_replace(split_part(slug, '-', 1), '[^a-z0-9]', '', 'g'), 12) into v_tag from centres where id = p_centre;
  v_base := v_first || '.' || coalesce(nullif(v_tag, ''), 'arena');
  v_user := v_base;
  while exists (select 1 from centre_staff where username = v_user)
     or exists (select 1 from auth.users where lower(email) = v_user || '@' || _staff_login_domain()) loop
    v_n := v_n + 1;
    v_user := v_base || v_n;
  end loop;

  return jsonb_build_object('username', v_user, 'email', v_user || '@' || _staff_login_domain(),
                            'name', s.display_name, 'phone', s.phone, 'role', s.role);
end $$;

-- Step 3: link the server-made account to the team row. The account must carry the server-only
-- marker for this centre and row, so an owner cannot attach someone else's account.
create or replace function public.attach_staff_login(p_centre uuid, p_staff uuid, p_user uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s centre_staff; u auth.users; v_username text := lower(trim(coalesce(p_username, '')));
begin
  perform require_perm(p_centre, 'staff.manage');
  select * into s from centre_staff where id = p_staff and centre_id = p_centre for update;
  if not found then raise exception 'Team member not found'; end if;
  if s.user_id is not null then raise exception 'This team member already has a login'; end if;
  if s.role not in ('manager', 'front_desk') then raise exception 'Logins can be made for managers and front desk staff'; end if;
  select * into u from auth.users where id = p_user;
  if u.id is null
     or coalesce(u.raw_app_meta_data ->> 'xs_staff_centre', '') <> p_centre::text
     or coalesce(u.raw_app_meta_data ->> 'xs_staff_row', '') <> p_staff::text
     or lower(u.email) <> v_username || '@' || _staff_login_domain() then
    raise exception 'This login was not made for this centre';
  end if;
  if exists (select 1 from centre_staff where centre_id = p_centre and user_id = p_user) then
    raise exception 'This login is already linked';
  end if;

  update centre_staff set user_id = p_user, username = v_username where id = p_staff returning * into s;
  perform log_audit(p_centre, 'staff.login_created', 'staff', s.id,
    jsonb_build_object('username', s.username, 'name', s.display_name, 'role', s.role));
  return jsonb_build_object('id', s.id, 'username', s.username, 'name', s.display_name, 'phone', s.phone, 'role', s.role);
end $$;

-- Password reset for a login made in XS Arena. Returns the account; the Edge Function sets the new password.
create or replace function public.prepare_staff_password_reset(p_centre uuid, p_staff uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s centre_staff;
begin
  perform require_perm(p_centre, 'staff.manage');
  select * into s from centre_staff where id = p_staff and centre_id = p_centre;
  if not found then raise exception 'Team member not found'; end if;
  if s.role = 'owner' then raise exception 'The owner''s password cannot be reset here'; end if;
  if s.username is null or s.user_id is null then
    raise exception 'This person signs in with their own email. They can use "Forgot password" on the sign-in page.';
  end if;
  perform log_audit(p_centre, 'staff.password_reset', 'staff', s.id, jsonb_build_object('username', s.username));
  return jsonb_build_object('user_id', s.user_id, 'username', s.username, 'name', s.display_name, 'phone', s.phone, 'role', s.role);
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.prepare_staff_login(uuid, uuid), public.attach_staff_login(uuid, uuid, uuid, text),
  public.prepare_staff_password_reset(uuid, uuid) to authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
