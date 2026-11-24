-- XS Arena — expenses: monthly recurring expenses (rent, salary, electricity…) and a photo of the bill.
--
-- Recurring: each rule posts one normal expense per month on its day (or the month's last day if shorter).
-- Posting is idempotent (one expense per rule per month), runs daily via pg_cron, and also whenever the
-- Expenses page or Home opens, so nothing is missed if the schedule is late.
-- Photos: private storage bucket "expense-bills", one folder per centre; only that centre's team can read or add.

create table public.recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  category text not null check (length(trim(category)) between 1 and 40),
  amount_paise bigint not null check (amount_paise > 0),
  day_of_month integer not null default 1 check (day_of_month between 1 and 31),
  method text not null default 'bank' check (method in ('cash','upi','card','bank','other')),
  paid_from text not null default 'bank' check (paid_from in ('drawer','bank','owner')),
  description text,
  starts_on date not null default current_date,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index recurring_expenses_centre_idx on public.recurring_expenses(centre_id) where active;
alter table public.recurring_expenses enable row level security;
create policy recurring_expenses_read on public.recurring_expenses for select to authenticated using (is_centre_member(centre_id));
grant select on public.recurring_expenses to authenticated;

alter table public.expenses
  add column recurring_id uuid references public.recurring_expenses(id) on delete set null,
  add column recurring_month date,
  add column photo_path text check (photo_path is null or length(photo_path) < 300);
create unique index expenses_recurring_month_uq on public.expenses(recurring_id, recurring_month) where recurring_id is not null;

-- Post every recurring expense that is due up to today (centre's local date). Returns how many were added.
create or replace function public._post_recurring(p_centre uuid default null)
returns integer language plpgsql volatile security definer set search_path = public as $$
declare r record; v_today date; v_month date; v_day date; v_n int := 0; v_id uuid;
begin
  for r in select re.*, c.timezone from recurring_expenses re join centres c on c.id = re.centre_id
           where re.active and (p_centre is null or re.centre_id = p_centre) loop
    v_today := (now() at time zone r.timezone)::date;
    v_month := date_trunc('month', greatest(r.starts_on, v_today - interval '2 months'))::date;   -- catch up at most 3 months
    while v_month <= v_today loop
      v_day := least(v_month + (r.day_of_month - 1), (v_month + interval '1 month - 1 day')::date);
      if v_day >= r.starts_on and v_day <= v_today then
        insert into expenses(centre_id, category, amount_paise, expense_date, method, paid_from, description, created_by, recurring_id, recurring_month)
        values (r.centre_id, r.category, r.amount_paise, v_day, r.method, r.paid_from,
          coalesce(r.description, r.category) || ' (monthly)', r.created_by, r.id, v_month)
        on conflict (recurring_id, recurring_month) where recurring_id is not null do nothing
        returning id into v_id;
        if v_id is not null then v_n := v_n + 1; v_id := null; end if;
      end if;
      v_month := (v_month + interval '1 month')::date;
    end loop;
  end loop;
  return v_n;
end $$;

create or replace function public.post_due_recurring(p_centre uuid)
returns integer language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  return _post_recurring(p_centre);
end $$;

-- p_rule: {id?, category, amount_paise, day_of_month, method, paid_from, description, starts_on, active}
create or replace function public.save_recurring_expense(p_centre uuid, p_rule jsonb)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid := nullif(p_rule->>'id','')::uuid; v_old recurring_expenses;
begin
  perform require_perm(p_centre, 'expenses.manage');
  if coalesce((p_rule->>'amount_paise')::bigint, 0) <= 0 then raise exception 'Enter an amount'; end if;
  if coalesce(trim(p_rule->>'category'),'') = '' then raise exception 'Choose a category'; end if;
  if v_id is null then
    insert into recurring_expenses(centre_id, category, amount_paise, day_of_month, method, paid_from, description, starts_on, created_by)
    values (p_centre, trim(p_rule->>'category'), (p_rule->>'amount_paise')::bigint, coalesce((p_rule->>'day_of_month')::int, 1),
      coalesce(p_rule->>'method','bank'), coalesce(p_rule->>'paid_from','bank'), nullif(trim(coalesce(p_rule->>'description','')),''),
      coalesce((p_rule->>'starts_on')::date, (now() at time zone (select timezone from centres where id = p_centre))::date), auth.uid())
    returning id into v_id;
    perform log_audit(p_centre, 'create', 'recurring_expense', v_id, p_rule);
  else
    select * into v_old from recurring_expenses where id = v_id and centre_id = p_centre for update;
    if not found then raise exception 'Not found'; end if;
    update recurring_expenses set category = trim(p_rule->>'category'), amount_paise = (p_rule->>'amount_paise')::bigint,
      day_of_month = coalesce((p_rule->>'day_of_month')::int, day_of_month), method = coalesce(p_rule->>'method', method),
      paid_from = coalesce(p_rule->>'paid_from', paid_from), description = nullif(trim(coalesce(p_rule->>'description','')),''),
      active = coalesce((p_rule->>'active')::boolean, active)
    where id = v_id;
    perform log_audit(p_centre, 'update', 'recurring_expense', v_id, to_jsonb(v_old));
  end if;
  perform _post_recurring(p_centre);
  return v_id;
end $$;

-- record_expense gains an optional bill photo (a path inside this centre's folder).
drop function public.record_expense(uuid,text,bigint,date,text,text,text);
create or replace function public.record_expense(p_centre uuid, p_category text, p_amount_paise bigint, p_expense_date date,
  p_method text, p_paid_from text default 'drawer', p_description text default null, p_photo_path text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform require_perm(p_centre, 'expenses.manage');
  if coalesce(p_amount_paise,0) <= 0 then raise exception 'Enter an amount'; end if;
  if p_photo_path is not null and p_photo_path not like p_centre::text || '/%' then raise exception 'Invalid photo'; end if;
  insert into expenses(centre_id, category, amount_paise, expense_date, method, paid_from, description, created_by, photo_path)
  values (p_centre, trim(p_category), p_amount_paise, coalesce(p_expense_date, current_date), coalesce(p_method,'cash'),
          coalesce(p_paid_from,'drawer'), nullif(trim(p_description),''), auth.uid(), nullif(p_photo_path,''))
  returning id into v_id;
  perform log_audit(p_centre, 'create', 'expense', v_id, jsonb_build_object('amount', p_amount_paise, 'category', p_category, 'photo', p_photo_path is not null));
  return v_id;
end $$;

-- Storage (Supabase only; skipped in plain-Postgres test databases)
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    values ('expense-bills', 'expense-bills', false, 5242880, array['image/jpeg','image/png','image/webp'])
    on conflict (id) do nothing;
    execute $p$create policy expense_bills_read on storage.objects for select to authenticated
      using (bucket_id = 'expense-bills' and public.is_centre_member(((storage.foldername(name))[1])::uuid))$p$;
    execute $p$create policy expense_bills_add on storage.objects for insert to authenticated
      with check (bucket_id = 'expense-bills' and public.has_perm(((storage.foldername(name))[1])::uuid, 'expenses.manage'))$p$;
  end if;
end $$;

-- Daily schedule (Supabase only): 00:30 UTC = 6 AM India
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('post-recurring-expenses', '30 0 * * *', 'select public._post_recurring()');
  end if;
end $$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public._post_recurring(uuid) from authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
grant execute on function public.post_due_recurring(uuid), public.save_recurring_expense(uuid,jsonb),
  public.record_expense(uuid,text,bigint,date,text,text,text,text) to authenticated;
