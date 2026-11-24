-- XS Arena — faster start: one call for "my centres" (after claiming invites) and one call for everything a centre screen needs.
-- Before: 9 requests one after another after login. After: 3.

create or replace function public.my_home()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then return '[]'::jsonb; end if;
  perform claim_invites();
  return coalesce((select jsonb_agg(jsonb_build_object('centre_id', m.centre_id, 'name', m.name, 'slug', m.slug, 'role', m.role, 'city', m.city))
                   from my_centres() m), '[]'::jsonb);
end $$;

-- Centre by slug + the caller's staff row, subscription, permissions and plan features. Null if the caller isn't active staff there.
create or replace function public.centre_context(p_slug text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare c centres; st centre_staff; cs centre_subscriptions; v_plan text;
begin
  if auth.uid() is null then return null; end if;
  perform claim_invites();
  select * into c from centres where slug = p_slug;
  if not found then return null; end if;
  select * into st from centre_staff where centre_id = c.id and user_id = auth.uid() and status = 'active';
  if not found then return null; end if;
  select * into cs from centre_subscriptions where centre_id = c.id;
  v_plan := coalesce(cs.plan, 'pro');
  return jsonb_build_object(
    'centre', to_jsonb(c), 'me', to_jsonb(st), 'subscription', case when cs.centre_id is null then null else to_jsonb(cs) end, 'plan', v_plan,
    'permissions', coalesce((select jsonb_agg(permission) from role_permissions where role = st.role), '[]'::jsonb),
    'features', coalesce((select jsonb_agg(feature) from plan_features where plan = v_plan), '[]'::jsonb));
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
grant execute on function public.my_home(), public.centre_context(text) to authenticated;
