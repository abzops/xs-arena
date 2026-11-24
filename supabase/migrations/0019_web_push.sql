-- XS Arena — web push alerts to staff phones (works with the app closed).
-- Each signed-in staff phone saves a push subscription. Every minute pg_cron calls the Edge Function "push-alerts",
-- which asks _due_push_alerts() for "5 min left" / "time's up" alerts not yet sent (each sent once per planned time)
-- and delivers them to the centre's floor staff. Calling the function more often only sends what is due — it is safe.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  user_id uuid not null,
  endpoint text not null unique check (endpoint like 'https://%' and length(endpoint) < 1000),
  p256dh text not null check (length(p256dh) < 200),
  auth text not null check (length(auth) < 100),
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index push_subscriptions_centre_idx on public.push_subscriptions(centre_id);
alter table public.push_subscriptions enable row level security;
create policy push_subs_own on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
grant select on public.push_subscriptions to authenticated;

create table public.push_sent (
  session_id uuid not null references public.sessions(id) on delete cascade,
  kind text not null check (kind in ('soon','over')),
  planned_minutes integer not null,
  sent_at timestamptz not null default now(),
  primary key (session_id, kind, planned_minutes)
);
alter table public.push_sent enable row level security;   -- no policies: server only

-- Save this phone for alerts at this centre (same phone can follow several centres).
create or replace function public.save_push_subscription(p_centre uuid, p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  perform require_perm(p_centre, 'floor.operate');
  if p_endpoint is null or p_endpoint not like 'https://%' then raise exception 'Invalid subscription'; end if;
  insert into push_subscriptions(centre_id, user_id, endpoint, p256dh, auth, user_agent)
  values (p_centre, auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 200))
  on conflict (endpoint) do update set centre_id = excluded.centre_id, user_id = excluded.user_id,
    p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, created_at = now();
end $$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void language sql volatile security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

-- Alerts that are due now and not yet sent, claimed atomically (so two runs never send the same alert),
-- with the phones to send them to (active floor staff of that centre).
create or replace function public._due_push_alerts()
returns table (centre_id uuid, kind text, title text, body text, tag text, url text, endpoint text, p256dh text, auth text)
language plpgsql volatile security definer set search_path = public as $$
begin
  return query
  with live as (
    select s.id, s.centre_id, s.planned_minutes, r.name res, c.slug, cu.full_name cust,
           s.planned_minutes * 60 - _session_seconds(s.id, now()) as left_s
    from sessions s join resources r on r.id = s.resource_id join centres c on c.id = s.centre_id
    left join customers cu on cu.id = s.customer_id
    where s.status = 'running' and s.planned_minutes is not null
      and exists (select 1 from push_subscriptions p where p.centre_id = s.centre_id)
  ), due as (
    select l.*, case when l.left_s <= 0 then 'over' else 'soon' end k from live l
    where l.left_s <= 300 and l.left_s > -1800          -- up to 30 minutes over; older ones are stale
  ), claimed as (
    insert into push_sent(session_id, kind, planned_minutes)
    select d.id, d.k, d.planned_minutes from due d
    on conflict do nothing
    returning push_sent.session_id, push_sent.kind
  )
  select d.centre_id, d.k,
         d.res || case when d.k = 'over' then ': time''s up' else ': ' || greatest(1, ceil(d.left_s / 60.0))::int || ' min left' end,
         coalesce(d.cust, 'Walk-in') || case when d.k = 'over' then ' · tap to extend or bill' else '' end,
         d.id::text || ':' || d.k, '/s/' || d.slug || '/floor',
         p.endpoint, p.p256dh, p.auth
  from due d join claimed c on c.session_id = d.id and c.kind = d.k
  join push_subscriptions p on p.centre_id = d.centre_id
  join centre_staff st on st.centre_id = d.centre_id and st.user_id = p.user_id and st.status = 'active'
  where has_role_perm(st.role, 'floor.operate');
end $$;

create or replace function public.has_role_perm(p_role text, p_perm text)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from role_permissions where role = p_role and permission = p_perm);
$$;

-- Push service said the phone is gone (404/410): forget it.
create or replace function public._drop_push_endpoint(p_endpoint text)
returns void language sql volatile security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint;
$$;

-- Every minute (Supabase only): call the Edge Function. It needs no secret: it only sends alerts that are due.
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') and exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_net;
    create extension if not exists pg_cron;
    perform cron.schedule('push-alerts', '* * * * *',
      $c$select net.http_post(url := 'https://ppdfdymgtvrimmhcrmbl.supabase.co/functions/v1/push-alerts',
        headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 20000)$c$);
  end if;
end $$;

-- VAPID keys: made once by the push-alerts function, kept here; nobody but the service role can read the private key.
create table if not exists public.push_vapid (
  id int primary key default 1 check (id = 1),
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);
alter table public.push_vapid enable row level security;
revoke all on public.push_vapid from public, anon, authenticated;

create or replace function public.push_public_key()
returns text language sql stable security definer set search_path = public as $$
  select public_key from push_vapid where id = 1 and auth.uid() is not null;
$$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public._due_push_alerts(), public._drop_push_endpoint(text), public.has_role_perm(text,text) from authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on public.push_vapid to service_role;
    grant execute on function public._due_push_alerts(), public._drop_push_endpoint(text) to service_role;
  end if;
end $$;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
grant execute on function public.save_push_subscription(uuid,text,text,text,text), public.delete_push_subscription(text), public.push_public_key() to authenticated;
