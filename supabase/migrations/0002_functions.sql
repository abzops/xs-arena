-- XS Arena — business logic (RPC) for the foundation. Every write that matters goes through these.

-- ───────────── Onboarding / membership ─────────────
create or replace function public.create_centre(p_name text, p_phone text default null, p_city text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_slug text; v_base text; v_n int := 0; v_email text; v_display text;
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  if (select count(*) from centre_staff where user_id = auth.uid() and role = 'owner') >= 5 then
    raise exception 'Centre limit reached for this account';
  end if;
  select email, coalesce(nullif(trim(raw_user_meta_data->>'display_name'),''), split_part(email,'@',1))
    into v_email, v_display from auth.users where id = auth.uid();
  v_base := trim(both '-' from regexp_replace(lower(coalesce(p_name,'centre')), '[^a-z0-9]+', '-', 'g'));
  if length(v_base) < 3 then v_base := 'arena-' || v_base; end if;
  v_base := left(v_base, 34);
  v_slug := v_base;
  while exists (select 1 from centres where slug = v_slug) loop
    v_n := v_n + 1; v_slug := v_base || '-' || v_n;
  end loop;

  insert into centres(name, slug, phone, city, email, created_by)
  values (trim(p_name), v_slug, nullif(trim(p_phone),''), nullif(trim(p_city),''), v_email, auth.uid())
  returning id into v_id;
  insert into centre_subscriptions(centre_id) values (v_id);
  insert into centre_staff(centre_id, user_id, role, display_name, email, color)
  values (v_id, auth.uid(), 'owner', coalesce(v_display,'Owner'), v_email, '#2A78D6');

  -- starter snack menu (editable)
  insert into products(centre_id, name, kind, price_paise, cost_paise, stock_qty, reorder_level, unit) values
    (v_id, 'Water bottle', 'retail', 2000, 1000, 24, 6, 'pc'),
    (v_id, 'Soft drink', 'retail', 4000, 2500, 24, 6, 'pc'),
    (v_id, 'Energy drink', 'retail', 12000, 9000, 12, 4, 'pc'),
    (v_id, 'Chips', 'retail', 3000, 2000, 20, 5, 'pc');

  perform log_audit(v_id, 'create', 'centre', v_id, jsonb_build_object('name', p_name));
  return v_id;
end $$;

-- Link staff rows that were added by email to the signed-in user.
create or replace function public.claim_invites()
returns integer language plpgsql security definer set search_path = public as $$
declare v_email text; v_n int;
begin
  if auth.uid() is null then return 0; end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;
  update centre_staff s set user_id = auth.uid()
   where s.user_id is null and lower(s.email) = v_email and s.status = 'active'
     and not exists (select 1 from centre_staff x where x.centre_id = s.centre_id and x.user_id = auth.uid());
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.my_centres()
returns table(centre_id uuid, name text, slug text, role text, city text)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.slug, st.role, c.city
  from centre_staff st join centres c on c.id = st.centre_id
  where st.user_id = auth.uid() and st.status = 'active' and c.status = 'active'
  order by c.created_at;
$$;

create or replace function public.complete_onboarding(p_centre uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm(p_centre, 'settings.manage');
  update centres set onboarded_at = coalesce(onboarded_at, now()) where id = p_centre;
end $$;

-- ───────────── Staff ─────────────
create or replace function public.save_staff(
  p_centre uuid, p_staff uuid, p_display_name text, p_role text, p_title text default null,
  p_phone text default null, p_email text default null, p_color text default '#8b8b93', p_status text default 'active')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_old centre_staff; v_limit int; v_logins int;
begin
  perform require_perm(p_centre, 'staff.manage');
  if p_role not in ('owner','manager','front_desk') then raise exception 'Invalid role'; end if;
  if p_status not in ('active','inactive') then raise exception 'Invalid status'; end if;
  if p_staff is not null then
    select * into v_old from centre_staff where id = p_staff and centre_id = p_centre for update;
    if not found then raise exception 'Team member not found'; end if;
    if v_old.role = 'owner' and (p_role <> 'owner' or p_status <> 'active')
       and (select count(*) from centre_staff where centre_id = p_centre and role = 'owner' and status = 'active') <= 1 then
      raise exception 'A centre must keep at least one active owner';
    end if;
    if v_old.user_id = auth.uid() and p_status <> 'active' then raise exception 'You cannot deactivate yourself'; end if;
    update centre_staff set display_name = trim(p_display_name), role = p_role, title = nullif(trim(p_title),''),
      phone = nullif(trim(p_phone),''),
      email = case when v_old.user_id is null then nullif(lower(trim(p_email)),'') else email end,
      color = coalesce(p_color,'#8b8b93'), status = p_status
    where id = p_staff;
    v_id := p_staff;
    perform log_audit(p_centre, 'update', 'staff', v_id, to_jsonb(v_old));
  else
    -- plan limit on staff logins (owner counts)
    v_limit := feature_limit(p_centre, 'staff_logins');
    select count(*) into v_logins from centre_staff where centre_id = p_centre and status = 'active';
    if v_limit is not null and v_logins >= v_limit then
      raise exception 'Your plan allows % team members. Upgrade to add more.', v_limit;
    end if;
    insert into centre_staff(centre_id, display_name, role, title, phone, email, color, status, sort)
    values (p_centre, trim(p_display_name), p_role, nullif(trim(p_title),''), nullif(trim(p_phone),''),
      nullif(lower(trim(p_email)),''), coalesce(p_color,'#8b8b93'), coalesce(p_status,'active'),
      (select coalesce(max(sort),0)+1 from centre_staff where centre_id = p_centre))
    returning id into v_id;
    -- link immediately if that email already has an account
    update centre_staff set user_id = u.id from auth.users u
     where centre_staff.id = v_id and centre_staff.email is not null and lower(u.email) = centre_staff.email
       and not exists (select 1 from centre_staff x where x.centre_id = p_centre and x.user_id = u.id);
    perform log_audit(p_centre, 'create', 'staff', v_id, jsonb_build_object('name', p_display_name, 'role', p_role));
  end if;
  return v_id;
end $$;

-- ───────────── Customers ─────────────
create or replace function public.normalize_phone(p text)
returns text language sql immutable set search_path = public as $$
  select case
    when p is null then null
    when regexp_replace(p,'[^0-9]','','g') ~ '^[6-9][0-9]{9}$' then '+91' || regexp_replace(p,'[^0-9]','','g')
    when regexp_replace(p,'[^0-9]','','g') ~ '^91[6-9][0-9]{9}$' then '+' || regexp_replace(p,'[^0-9]','','g')
    when p ~ '^\s*\+' then '+' || regexp_replace(p,'[^0-9]','','g')
    else regexp_replace(p,'[^0-9]','','g') end;
$$;

create or replace function public.save_customer(
  p_centre uuid, p_customer uuid, p_full_name text, p_phone text, p_email text default null,
  p_gender text default null, p_date_of_birth date default null, p_anniversary date default null,
  p_notes text default null, p_tags text[] default '{}', p_source text default 'walk_in', p_marketing_opt_in boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_phone text := normalize_phone(p_phone); v_no int;
begin
  perform require_perm(p_centre, 'customers.manage');
  if v_phone is null or v_phone !~ '^\+?[0-9]{8,15}$' then raise exception 'Enter a valid phone number'; end if;
  if exists (select 1 from customers where centre_id = p_centre and phone = v_phone and id is distinct from p_customer) then
    raise exception 'A customer with this phone number already exists';
  end if;
  if p_customer is null then
    update centres set customer_seq = customer_seq + 1 where id = p_centre returning customer_seq into v_no;
    insert into customers(centre_id, customer_no, full_name, phone, email, gender, date_of_birth, anniversary, notes, tags, source, marketing_opt_in)
    values (p_centre, v_no, trim(p_full_name), v_phone, nullif(trim(p_email),''), p_gender, p_date_of_birth, p_anniversary,
            nullif(trim(p_notes),''), coalesce(p_tags,'{}'), coalesce(p_source,'walk_in'), coalesce(p_marketing_opt_in,true))
    returning id into v_id;
    perform log_audit(p_centre, 'create', 'customer', v_id, null);
  else
    update customers set full_name = trim(p_full_name), phone = v_phone, email = nullif(trim(p_email),''), gender = p_gender,
      date_of_birth = p_date_of_birth, anniversary = p_anniversary, notes = nullif(trim(p_notes),''),
      tags = coalesce(p_tags,'{}'), source = coalesce(p_source, source), marketing_opt_in = coalesce(p_marketing_opt_in,true)
    where id = p_customer and centre_id = p_centre returning id into v_id;
    if v_id is null then raise exception 'Customer not found'; end if;
  end if;
  return v_id;
end $$;

-- internal: find or create a customer by phone (no permission check — callers check)
create or replace function public._customer_by_phone(p_centre uuid, p_name text, p_phone text, p_source text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_phone text := normalize_phone(p_phone); v_no int;
begin
  if v_phone is null or v_phone !~ '^\+?[0-9]{8,15}$' then raise exception 'Enter a valid phone number'; end if;
  select id into v_id from customers where centre_id = p_centre and phone = v_phone;
  if v_id is not null then return v_id; end if;
  update centres set customer_seq = customer_seq + 1 where id = p_centre returning customer_seq into v_no;
  insert into customers(centre_id, customer_no, full_name, phone, source)
  values (p_centre, v_no, coalesce(nullif(trim(p_name),''),'Guest'), v_phone, p_source) returning id into v_id;
  return v_id;
end $$;

-- ───────────── Stock & expenses ─────────────
create or replace function public.adjust_stock(p_centre uuid, p_product uuid, p_qty numeric, p_reason text, p_note text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_new numeric;
begin
  perform require_perm(p_centre, 'inventory.manage');
  if p_reason not in ('purchase','use','adjust','return') then raise exception 'Invalid reason'; end if;
  if p_qty = 0 then raise exception 'Quantity cannot be zero'; end if;
  update products set stock_qty = stock_qty + p_qty where id = p_product and centre_id = p_centre returning stock_qty into v_new;
  if v_new is null then raise exception 'Product not found'; end if;
  insert into stock_moves(centre_id, product_id, qty, reason, note, created_by) values (p_centre, p_product, p_qty, p_reason, nullif(trim(p_note),''), auth.uid());
  return v_new;
end $$;

create or replace function public.record_expense(p_centre uuid, p_category text, p_amount_paise bigint, p_expense_date date,
  p_method text, p_paid_from text default 'drawer', p_description text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform require_perm(p_centre, 'expenses.manage');
  if coalesce(p_amount_paise,0) <= 0 then raise exception 'Enter an amount'; end if;
  insert into expenses(centre_id, category, amount_paise, expense_date, method, paid_from, description, created_by)
  values (p_centre, trim(p_category), p_amount_paise, coalesce(p_expense_date, current_date), coalesce(p_method,'cash'),
          coalesce(p_paid_from,'drawer'), nullif(trim(p_description),''), auth.uid())
  returning id into v_id;
  perform log_audit(p_centre, 'create', 'expense', v_id, jsonb_build_object('amount', p_amount_paise, 'category', p_category));
  return v_id;
end $$;

create or replace function public.void_expense(p_centre uuid, p_expense uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm(p_centre, 'expenses.manage');
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  update expenses set status = 'void' where id = p_expense and centre_id = p_centre and status = 'ok';
  if not found then raise exception 'Expense not found'; end if;
  perform log_audit(p_centre, 'void', 'expense', p_expense, null, p_reason);
end $$;

-- ───────────── Owner home ─────────────
-- Sales figures are zero until billing lands (Day 5); the shape is final so the screen doesn't change.
create or replace function public.dashboard_summary(p_centre uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c centres; v_today date; v_month date;
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  select * into c from centres where id = p_centre;
  v_today := (now() at time zone c.timezone)::date;
  v_month := date_trunc('month', v_today)::date;
  return jsonb_build_object(
    'today', v_today,
    'revenue_today', 0, 'collected_today', 0, 'bills_today', 0, 'methods_today', '{}'::jsonb,
    'revenue_month', 0,
    'expenses_month', (select coalesce(sum(amount_paise),0) from expenses where centre_id = p_centre and status = 'ok' and expense_date >= v_month),
    'expenses_by_category', (select coalesce(jsonb_object_agg(category, s),'{}') from (
        select category, sum(amount_paise) s from expenses where centre_id = p_centre and status = 'ok' and expense_date >= v_month group by category) x),
    'new_customers_month', (select count(*) from customers where centre_id = p_centre and created_at >= v_month::timestamp at time zone c.timezone),
    'customers_total', (select count(*) from customers where centre_id = p_centre and status = 'active'),
    'team_total', (select count(*) from centre_staff where centre_id = p_centre and status = 'active'),
    'low_stock', (select count(*) from products where centre_id = p_centre and status = 'active' and kind = 'retail' and stock_qty <= reorder_level),
    'birthdays_week', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name,'phone',phone,'date',date_of_birth)),'[]') from customers
        where centre_id = p_centre and date_of_birth is not null and status = 'active'
          and ((extract(doy from date_of_birth)::int - extract(doy from v_today)::int + 366) % 366) between 0 and 6)
  );
end $$;

-- ───────────── Grants ─────────────
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.create_centre(text,text,text), public.claim_invites(), public.my_centres(), public.complete_onboarding(uuid),
  public.save_staff(uuid,uuid,text,text,text,text,text,text,text),
  public.save_customer(uuid,uuid,text,text,text,text,date,date,text,text[],text,boolean),
  public.adjust_stock(uuid,uuid,numeric,text,text),
  public.record_expense(uuid,text,bigint,date,text,text,text), public.void_expense(uuid,uuid,text),
  public.dashboard_summary(uuid),
  public.is_centre_member(uuid), public.has_perm(uuid,text), public.has_feature(uuid,text), public.feature_limit(uuid,text),
  public.normalize_phone(text)
to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
