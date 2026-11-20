-- XS Arena — foundation schema (Day 1)
-- Tenancy, subscription plans + feature gates, staff roles, customers, snacks stock, expenses, audit log.
-- Money is stored in paise (bigint). Times are timestamptz; business logic uses the centre's timezone.
-- Floors, tables/consoles/tracks, rate cards and sessions arrive in 0003+.

create extension if not exists pgcrypto;

-- ───────────────────────── Plans (subscription-ready from day 1) ─────────────────────────
create table public.plans (
  code text primary key check (code in ('starter','growth','pro')),
  name text not null,
  sort integer not null default 0
);
insert into public.plans(code, name, sort) values ('starter','Starter',1), ('growth','Growth',2), ('pro','Pro',3);

-- A feature is on for a plan when a row exists. limit_value = null means unlimited.
create table public.plan_features (
  plan text not null references public.plans(code) on delete cascade,
  feature text not null,
  limit_value integer,
  primary key (plan, feature)
);
insert into public.plan_features(plan, feature, limit_value) values
  -- every plan
  ('starter','floor',null), ('growth','floor',null), ('pro','floor',null),
  ('starter','billing',null), ('growth','billing',null), ('pro','billing',null),
  ('starter','expenses',null), ('growth','expenses',null), ('pro','expenses',null),
  ('starter','waitlist',null), ('growth','waitlist',null), ('pro','waitlist',null),
  ('starter','tv_display',1), ('growth','tv_display',2), ('pro','tv_display',null),
  ('starter','staff_logins',2), ('growth','staff_logins',5), ('pro','staff_logins',null),
  ('starter','reports_basic',null), ('growth','reports_basic',null), ('pro','reports_basic',null),
  -- growth and up
  ('growth','loyalty',null), ('pro','loyalty',null),
  ('growth','online_booking',null), ('pro','online_booking',null),
  ('growth','rc_fleet',null), ('pro','rc_fleet',null),
  ('growth','reports_full',null), ('pro','reports_full',null),
  -- pro only
  ('pro','xs_ai',null),
  ('growth','auto_whatsapp',500), ('pro','auto_whatsapp',2000);

-- ───────────────────────── Tenancy ─────────────────────────
create table public.centres (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  phone text,
  email text,
  address text,
  city text,
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR',
  upi_id text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$'),
  gstin text,
  gst_enabled boolean not null default false,
  gst_rate_bp integer not null default 1800 check (gst_rate_bp between 0 and 2800),
  prices_include_tax boolean not null default true,
  open_time time not null default '10:00',
  close_time time not null default '23:00',
  slot_minutes integer not null default 30 check (slot_minutes in (5,10,15,20,30,60)),
  booking_enabled boolean not null default false,
  booking_note text,
  invoice_prefix text not null default 'BILL',
  invoice_seq integer not null default 0,
  customer_seq integer not null default 0,
  status text not null default 'active' check (status in ('active','suspended')),
  onboarded_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.centre_subscriptions (
  centre_id uuid primary key references public.centres(id) on delete cascade,
  plan text not null default 'pro' references public.plans(code),
  status text not null default 'trialing' check (status in ('trialing','active','past_due','cancelled')),
  trial_ends_at timestamptz not null default now() + interval '14 days',
  paid_until timestamptz,
  updated_at timestamptz not null default now()
);

create table public.centre_staff (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  user_id uuid references auth.users(id),
  role text not null default 'front_desk' check (role in ('owner','manager','front_desk')),
  display_name text not null check (length(trim(display_name)) between 1 and 60),
  title text,
  phone text,
  email text,
  color text not null default '#8b8b93',
  sort integer not null default 0,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now()
);
create unique index centre_staff_user_uq on public.centre_staff(centre_id, user_id) where user_id is not null;
create unique index centre_staff_email_uq on public.centre_staff(centre_id, lower(email)) where email is not null;
create index centre_staff_user_idx on public.centre_staff(user_id);

create table public.role_permissions (
  role text not null,
  permission text not null,
  primary key (role, permission)
);
-- owner: everything. manager: everything except settings, team and the floor designer.
-- front desk: run the floor, bill, find/add customers, sell snacks.
insert into public.role_permissions(role, permission)
select r, p from
  (values ('owner'),('manager')) roles(r),
  (values ('floor.operate'),('floor.design'),('pricing.manage'),('billing.create'),('billing.discount'),('billing.void'),
          ('customers.manage'),('inventory.manage'),('expenses.manage'),('loyalty.manage'),('reports.view'),
          ('staff.manage'),('settings.manage')) perms(p)
where not (r = 'manager' and p in ('settings.manage','staff.manage','floor.design'))
union all
select 'front_desk', p from (values ('floor.operate'),('billing.create'),('customers.manage')) x(p);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  centre_id uuid not null references public.centres(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  data jsonb,
  reason text
);
create index audit_logs_centre_idx on public.audit_logs(centre_id, occurred_at desc);

-- ───────────────────────── Customers ─────────────────────────
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  customer_no integer not null,
  full_name text not null check (length(trim(full_name)) between 1 and 80),
  phone text not null check (phone ~ '^\+?[0-9]{8,15}$'),
  email text,
  gender text check (gender in ('female','male','other')),
  date_of_birth date,
  anniversary date,
  notes text,
  tags text[] not null default '{}',
  source text not null default 'walk_in' check (source in ('walk_in','phone','online','whatsapp','instagram','referral','other')),
  marketing_opt_in boolean not null default true,
  visit_count integer not null default 0,
  total_spent_paise bigint not null default 0,
  last_visit_at timestamptz,
  status text not null default 'active' check (status in ('active','blocked','archived')),
  created_at timestamptz not null default now(),
  unique (centre_id, phone),
  unique (centre_id, customer_no)
);
create index customers_centre_name_idx on public.customers(centre_id, lower(full_name));

-- ───────────────────────── Snacks, drinks & stock ─────────────────────────
create table public.products (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  brand text,
  sku text,
  kind text not null default 'retail' check (kind in ('retail','consumable')),
  price_paise bigint not null default 0 check (price_paise >= 0),
  cost_paise bigint not null default 0 check (cost_paise >= 0),
  stock_qty numeric(12,2) not null default 0,
  reorder_level numeric(12,2) not null default 0,
  unit text not null default 'pc',
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now()
);
create index products_centre_idx on public.products(centre_id, status);

create table public.stock_moves (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  qty numeric(12,2) not null,
  reason text not null check (reason in ('purchase','sale','use','adjust','return','void')),
  note text,
  ref_id uuid,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index stock_moves_product_idx on public.stock_moves(product_id, created_at desc);

-- ───────────────────────── Expenses ─────────────────────────
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  category text not null check (length(trim(category)) between 1 and 40),
  amount_paise bigint not null check (amount_paise > 0),
  expense_date date not null default current_date,
  method text not null default 'cash' check (method in ('cash','upi','card','bank','other')),
  paid_from text not null default 'drawer' check (paid_from in ('drawer','bank','owner')),
  description text,
  status text not null default 'ok' check (status in ('ok','void')),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index expenses_centre_date_idx on public.expenses(centre_id, expense_date desc);

-- ───────────────────────── Helpers ─────────────────────────
create or replace function public.is_centre_member(p_centre uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from centre_staff s where s.centre_id = p_centre and s.user_id = auth.uid() and s.status = 'active');
$$;

create or replace function public.has_perm(p_centre uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from centre_staff s join role_permissions rp on rp.role = s.role
    where s.centre_id = p_centre and s.user_id = auth.uid() and s.status = 'active' and rp.permission = p_perm);
$$;

create or replace function public.require_perm(p_centre uuid, p_perm text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '28000'; end if;
  if not has_perm(p_centre, p_perm) then raise exception 'You do not have permission for this action' using errcode = '42501'; end if;
end $$;

-- Is a feature included in the centre's plan? (Everything is on during the Pro trial.)
create or replace function public.has_feature(p_centre uuid, p_feature text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from centre_subscriptions cs join plan_features pf on pf.plan = cs.plan
    where cs.centre_id = p_centre and pf.feature = p_feature and cs.status in ('trialing','active','past_due'));
$$;

create or replace function public.feature_limit(p_centre uuid, p_feature text)
returns integer language sql stable security definer set search_path = public as $$
  select pf.limit_value from centre_subscriptions cs join plan_features pf on pf.plan = cs.plan
  where cs.centre_id = p_centre and pf.feature = p_feature;
$$;

create or replace function public.require_feature(p_centre uuid, p_feature text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not has_feature(p_centre, p_feature) then
    raise exception 'This feature is not included in your plan' using errcode = '42501';
  end if;
end $$;

create or replace function public.log_audit(p_centre uuid, p_action text, p_entity text, p_entity_id uuid, p_data jsonb default null, p_reason text default null)
returns void language sql security definer set search_path = public as $$
  insert into audit_logs(centre_id, actor_user_id, action, entity, entity_id, data, reason)
  values (p_centre, auth.uid(), p_action, p_entity, p_entity_id, p_data, p_reason);
$$;
revoke execute on function public.log_audit(uuid,text,text,uuid,jsonb,text) from public, anon, authenticated;

-- ───────────────────────── RLS ─────────────────────────
alter table public.plans enable row level security;
alter table public.plan_features enable row level security;
alter table public.centres enable row level security;
alter table public.centre_subscriptions enable row level security;
alter table public.centre_staff enable row level security;
alter table public.role_permissions enable row level security;
alter table public.audit_logs enable row level security;
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.stock_moves enable row level security;
alter table public.expenses enable row level security;

create policy plans_read on public.plans for select to authenticated using (true);
create policy plan_features_read on public.plan_features for select to authenticated using (true);
create policy centres_read on public.centres for select to authenticated using (is_centre_member(id));
create policy centres_update on public.centres for update to authenticated using (has_perm(id,'settings.manage')) with check (has_perm(id,'settings.manage'));
create policy subs_read on public.centre_subscriptions for select to authenticated using (is_centre_member(centre_id));
create policy staff_read on public.centre_staff for select to authenticated using (is_centre_member(centre_id) or user_id = auth.uid());
create policy perms_read on public.role_permissions for select to authenticated using (true);
create policy audit_read on public.audit_logs for select to authenticated using (has_perm(centre_id,'reports.view'));
create policy customers_read on public.customers for select to authenticated using (is_centre_member(centre_id));
create policy customers_upd on public.customers for update to authenticated using (has_perm(centre_id,'customers.manage')) with check (has_perm(centre_id,'customers.manage'));
create policy prod_read on public.products for select to authenticated using (is_centre_member(centre_id));
create policy prod_ins on public.products for insert to authenticated with check (has_perm(centre_id,'inventory.manage'));
create policy prod_upd on public.products for update to authenticated using (has_perm(centre_id,'inventory.manage')) with check (has_perm(centre_id,'inventory.manage'));
create policy moves_read on public.stock_moves for select to authenticated using (is_centre_member(centre_id));
create policy exp_read on public.expenses for select to authenticated using (has_perm(centre_id,'expenses.manage') or has_perm(centre_id,'reports.view'));

-- Explicit grants (the project does not auto-grant new tables to the Data API).
grant usage on schema public to anon, authenticated;
grant select on public.plans, public.plan_features, public.centres, public.centre_subscriptions, public.centre_staff,
  public.role_permissions, public.audit_logs, public.customers, public.products, public.stock_moves, public.expenses to authenticated;
grant insert, update on public.products to authenticated;
-- centres/customers: only editable columns (counters, status etc. change via RPC only)
grant update (name, phone, email, address, city, upi_id, gstin, gst_enabled, gst_rate_bp, prices_include_tax, open_time, close_time,
  slot_minutes, booking_enabled, booking_note, invoice_prefix, updated_at) on public.centres to authenticated;
grant update (full_name, email, gender, date_of_birth, anniversary, notes, tags, marketing_opt_in, status) on public.customers to authenticated;
revoke all on all tables in schema public from anon;
