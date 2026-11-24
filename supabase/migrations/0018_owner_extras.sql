-- XS Arena — owner extras: end-of-day summary with leakage alerts; staff may add photos (RC damage) to the bills bucket.

-- One day at a glance (centre's local date). Owner/manager only (reports.view).
-- Leakage alerts are the things an owner should look at: voids, cancelled games, big discounts, unpaid tabs,
-- games left running for hours, and cash differences at shift close.
create or replace function public.day_summary(p_centre uuid, p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c centres; v_day date; v_from timestamptz; v_to timestamptz; v_rev bigint; v_exp bigint; v_disc bigint; v_alerts jsonb := '[]';
  v_n int; v_amt bigint; r record;
begin
  perform require_perm(p_centre, 'reports.view');
  select * into c from centres where id = p_centre;
  v_day := coalesce(p_date, (now() at time zone c.timezone)::date);
  v_from := v_day::timestamp at time zone c.timezone; v_to := v_from + interval '1 day';

  select coalesce(sum(total_paise),0), coalesce(sum(discount_paise),0) into v_rev, v_disc
  from bills where centre_id = p_centre and status <> 'void' and created_at >= v_from and created_at < v_to;
  select coalesce(sum(amount_paise),0) into v_exp from expenses where centre_id = p_centre and status = 'ok' and expense_date = v_day;

  -- leakage alerts
  for r in select a.action, a.entity, a.reason, a.data, a.occurred_at,
                  (select display_name from centre_staff s where s.centre_id = p_centre and s.user_id = a.actor_user_id limit 1) who
           from audit_logs a where a.centre_id = p_centre and a.action = 'void' and a.entity in ('bill','session','expense')
             and a.occurred_at >= v_from and a.occurred_at < v_to order by a.occurred_at loop
    v_alerts := v_alerts || jsonb_build_object('kind', 'void_' || r.entity, 'level', 'warn',
      'text', case r.entity when 'bill' then 'Bill voided' when 'session' then 'Game cancelled' else 'Expense voided' end
        || coalesce(' (' || (r.data->>'no') || ')', '')
        || coalesce(' — ₹' || ((r.data->>'total')::bigint / 100)::text, '')
        || coalesce(' by ' || r.who, '') || coalesce(': ' || r.reason, ''),
      'at', r.occurred_at);
  end loop;
  if v_disc > 0 and v_rev + v_disc > 0 and v_disc * 100 / (v_rev + v_disc) >= 10 then
    v_alerts := v_alerts || jsonb_build_object('kind', 'discounts', 'level', 'warn',
      'text', format('Discounts were %s%% of sales (₹%s)', v_disc * 100 / (v_rev + v_disc), v_disc / 100));
  end if;
  select count(*), coalesce(sum(i.total_paise),0) into v_n, v_amt from tabs t left join tab_items i on i.tab_id = t.id and i.status = 'ok'
  where t.centre_id = p_centre and t.status = 'open' and t.opened_at < now() - interval '3 hours'
    and not exists (select 1 from sessions s where s.tab_id = t.id and s.status in ('running','paused'));
  if v_n > 0 then
    v_alerts := v_alerts || jsonb_build_object('kind', 'open_tabs', 'level', 'bad',
      'text', format('%s bill%s still open with no game running — collect or close', v_n, case when v_n = 1 then '' else 's' end));
  end if;
  for r in select res.name, s.started_at from sessions s join resources res on res.id = s.resource_id
           where s.centre_id = p_centre and s.status in ('running','paused') and s.started_at < now() - interval '6 hours' loop
    v_alerts := v_alerts || jsonb_build_object('kind', 'long_game', 'level', 'bad',
      'text', format('%s has been running since %s — was it stopped?', r.name, to_char(r.started_at at time zone c.timezone, 'FMHH12:MI AM')));
  end loop;
  for r in select difference_paise, note, closed_at from shifts
           where centre_id = p_centre and status = 'closed' and closed_at >= v_from and closed_at < v_to and difference_paise <> 0 loop
    v_alerts := v_alerts || jsonb_build_object('kind', 'cash_difference', 'level', case when abs(r.difference_paise) >= 10000 then 'bad' else 'warn' end,
      'text', format('Cash %s by ₹%s at shift close%s', case when r.difference_paise < 0 then 'short' else 'over' end,
        abs(r.difference_paise) / 100, coalesce(': ' || r.note, '')));
  end loop;

  return jsonb_build_object(
    'date', v_day, 'centre', c.name,
    'revenue_paise', v_rev, 'expenses_paise', v_exp, 'net_paise', v_rev - v_exp, 'discount_paise', v_disc,
    'bills', (select count(*) from bills where centre_id = p_centre and status <> 'void' and created_at >= v_from and created_at < v_to),
    'customers', (select count(distinct coalesce(customer_id::text, id::text)) from bills
      where centre_id = p_centre and status <> 'void' and created_at >= v_from and created_at < v_to),
    'games', (select count(*) from sessions where centre_id = p_centre and status = 'ended' and started_at >= v_from and started_at < v_to),
    'by_game', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'amount_paise', amt, 'games', n) order by amt desc), '[]') from (
        select g->>'activity' name, sum((g->>'amount_paise')::bigint) amt, count(*) n
        from bills b, jsonb_array_elements(b.lines->'games') g
        where b.centre_id = p_centre and b.status <> 'void' and b.created_at >= v_from and b.created_at < v_to group by 1) x),
    'snacks_paise', (select coalesce(sum((i->>'total_paise')::bigint),0) from bills b, jsonb_array_elements(b.lines->'items') i
        where b.centre_id = p_centre and b.status <> 'void' and b.created_at >= v_from and b.created_at < v_to),
    'by_method', (select coalesce(jsonb_object_agg(method, amt), '{}') from (
        select p.method, sum(p.amount_paise) amt from payments p join bills b on b.id = p.bill_id
        where b.centre_id = p_centre and p.status <> 'void' and b.created_at >= v_from and b.created_at < v_to group by 1) x),
    'unpaid_paise', (select coalesce(sum(total_paise - paid_paise),0) from bills
        where centre_id = p_centre and status in ('unpaid','partial') and created_at >= v_from and created_at < v_to),
    'bookings', (select count(*) from bookings where centre_id = p_centre and starts_at >= v_from and starts_at < v_to and status not in ('cancelled')),
    'alerts', v_alerts);
end $$;

-- Staff who run the floor may attach photos (e.g. RC damage); folder must be their centre's.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute 'drop policy if exists expense_bills_add on storage.objects';
    execute $p$create policy expense_bills_add on storage.objects for insert to authenticated
      with check (bucket_id = 'expense-bills' and (public.has_perm(((storage.foldername(name))[1])::uuid, 'expenses.manage')
        or public.has_perm(((storage.foldername(name))[1])::uuid, 'floor.operate')))$p$;
  end if;
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
grant execute on function public.day_summary(uuid,date) to authenticated;
