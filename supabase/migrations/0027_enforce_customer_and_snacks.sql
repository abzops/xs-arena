-- XS Arena — the database now enforces the two pilot rules the app screens already enforce (owner's OK, 26 Nov 2026):
--   1. centres.require_customer: a new game needs a customer with a name and mobile (directly or on the bill it joins);
--      the waiting list needs a mobile.
--   2. Snacks & stock is an add-on: no snack sales, product changes or stock top-ups without it.
--      Voids, returns and stock already sold keep working, so bills from before stay correct.

create or replace function public._enforce_session_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select require_customer from centres where id = new.centre_id)
     and coalesce(new.customer_id, (select customer_id from tabs where id = new.tab_id)) is null then
    raise exception 'Enter the customer''s name and mobile to start';
  end if;
  return new;
end $$;
create trigger sessions_require_customer before insert on public.sessions
  for each row execute function public._enforce_session_customer();

-- A walk-in customer made without a name is saved as "Guest"; with the rule on, ask for the name instead.
create or replace function public._enforce_customer_name()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.full_name = 'Guest' and new.source = 'walk_in' and (select require_customer from centres where id = new.centre_id) then
    raise exception 'Enter the customer''s name';
  end if;
  return new;
end $$;
create trigger customers_require_name before insert on public.customers
  for each row execute function public._enforce_customer_name();

create or replace function public._enforce_waitlist_phone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select require_customer from centres where id = new.centre_id) and nullif(trim(coalesce(new.phone, '')), '') is null then
    raise exception 'Enter the customer''s mobile';
  end if;
  return new;
end $$;
create trigger waitlist_require_phone before insert on public.waitlist
  for each row execute function public._enforce_waitlist_phone();

create or replace function public._enforce_snacks_addon()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- create_centre adds a starter snack list in the same transaction; that stays, ready for when the add-on is turned on
  if tg_table_name = 'products' and tg_op = 'INSERT' and (select created_at from centres where id = new.centre_id) = now() then
    return new;
  end if;
  if not has_feature(new.centre_id, 'snacks') then
    raise exception 'Snacks & stock is an add-on. The owner can add it from Settings → Plan.';
  end if;
  return new;
end $$;
create trigger tab_items_snacks_addon before insert on public.tab_items
  for each row when (new.product_id is not null) execute function public._enforce_snacks_addon();
create trigger products_snacks_addon before insert or update of name, price_paise, kind on public.products
  for each row execute function public._enforce_snacks_addon();
create trigger stock_moves_snacks_addon before insert on public.stock_moves
  for each row when (new.reason in ('purchase', 'adjust')) execute function public._enforce_snacks_addon();

revoke execute on all functions in schema public from public, anon;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int,text),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
