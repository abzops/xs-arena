-- XS Arena — RC fleet: cars, batteries and controllers.
-- Staff (floor.operate) log charges, damage, status and deposits; owner/manager (inventory.manage) add and edit items;
-- a repair with a cost is also recorded as an "RC repairs" expense (expenses.manage). Logs are append-only.

create table public.rc_items (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  kind text not null default 'car' check (kind in ('car','battery','controller')),
  name text not null check (length(trim(name)) between 1 and 40),
  activity_id uuid references public.activities(id) on delete set null,
  status text not null default 'ready' check (status in ('ready','charging','in_use','repair','retired')),
  charge_cycles integer not null default 0 check (charge_cycles >= 0),
  last_charged_at timestamptz,
  deposit_paise bigint not null default 0 check (deposit_paise >= 0),
  notes text,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (centre_id, name)
);
alter table public.rc_items enable row level security;
create policy rc_items_read on public.rc_items for select to authenticated using (is_centre_member(centre_id));
grant select on public.rc_items to authenticated;

create table public.rc_logs (
  id bigint generated always as identity primary key,
  centre_id uuid not null references public.centres(id) on delete cascade,
  item_id uuid not null references public.rc_items(id) on delete cascade,
  kind text not null check (kind in ('charge','damage','repair','status','deposit_in','deposit_out','note')),
  status text,
  note text,
  cost_paise bigint not null default 0 check (cost_paise >= 0),
  photo_path text check (photo_path is null or length(photo_path) < 300),
  expense_id uuid references public.expenses(id),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index rc_logs_item_idx on public.rc_logs(item_id, id desc);
alter table public.rc_logs enable row level security;
create policy rc_logs_read on public.rc_logs for select to authenticated using (is_centre_member(centre_id));
grant select on public.rc_logs to authenticated;
create or replace function public._rc_logs_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'RC history cannot be changed'; end if;
  if not exists (select 1 from rc_items where id = old.item_id) then return old; end if;   -- item removed with its centre
  raise exception 'RC history cannot be deleted';
end $$;
create trigger rc_logs_immutable before update or delete on public.rc_logs
  for each row execute function public._rc_logs_guard();

-- Add or edit an item. p_item: {id?, kind, name, activity_id?, deposit_paise?, notes?, status? ('retired' to retire)}
create or replace function public.save_rc_item(p_centre uuid, p_item jsonb)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid := nullif(p_item->>'id','')::uuid; v_old rc_items;
begin
  perform require_perm(p_centre, 'inventory.manage');
  perform require_feature(p_centre, 'rc_fleet');
  if coalesce(trim(p_item->>'name'),'') = '' then raise exception 'Give it a name, e.g. Car 4'; end if;
  if nullif(p_item->>'activity_id','') is not null
     and not exists (select 1 from activities where id = (p_item->>'activity_id')::uuid and centre_id = p_centre) then
    raise exception 'Pick a game from this centre';
  end if;
  if v_id is null then
    insert into rc_items(centre_id, kind, name, activity_id, deposit_paise, notes, sort)
    values (p_centre, coalesce(p_item->>'kind','car'), trim(p_item->>'name'), nullif(p_item->>'activity_id','')::uuid,
      coalesce((p_item->>'deposit_paise')::bigint, 0), nullif(trim(coalesce(p_item->>'notes','')),''),
      (select coalesce(max(sort),0)+1 from rc_items where centre_id = p_centre))
    returning id into v_id;
    perform log_audit(p_centre, 'create', 'rc_item', v_id, p_item);
  else
    select * into v_old from rc_items where id = v_id and centre_id = p_centre for update;
    if not found then raise exception 'Not found'; end if;
    update rc_items set kind = coalesce(p_item->>'kind', kind), name = trim(p_item->>'name'),
      activity_id = case when p_item ? 'activity_id' then nullif(p_item->>'activity_id','')::uuid else activity_id end,
      deposit_paise = coalesce((p_item->>'deposit_paise')::bigint, deposit_paise),
      notes = case when p_item ? 'notes' then nullif(trim(p_item->>'notes'),'') else notes end,
      status = case when p_item->>'status' = 'retired' then 'retired' when status = 'retired' and p_item->>'status' = 'ready' then 'ready' else status end
    where id = v_id;
    perform log_audit(p_centre, 'update', 'rc_item', v_id, to_jsonb(v_old));
  end if;
  return v_id;
exception when unique_violation then raise exception 'There is already an item called %', trim(p_item->>'name');
end $$;

-- Log something that happened to an item.
--   charge: +1 charge cycle, back to ready · damage: goes to repair · repair: back to ready (+ expense if it cost money)
--   status: set ready / charging / in_use / repair · deposit_in / deposit_out / note: just recorded
create or replace function public.rc_log(p_centre uuid, p_item uuid, p_kind text, p_note text default null,
  p_cost_paise bigint default 0, p_status text default null, p_photo_path text default null, p_paid_from text default 'drawer')
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare it rc_items; v_exp uuid; v_status text;
begin
  perform require_perm(p_centre, 'floor.operate');
  perform require_feature(p_centre, 'rc_fleet');
  select * into it from rc_items where id = p_item and centre_id = p_centre for update;
  if not found then raise exception 'Not found'; end if;
  if it.status = 'retired' then raise exception '% is retired', it.name; end if;
  if p_kind not in ('charge','damage','repair','status','deposit_in','deposit_out','note') then raise exception 'Invalid action'; end if;
  if p_photo_path is not null and p_photo_path not like p_centre::text || '/%' then raise exception 'Invalid photo'; end if;
  if p_kind = 'damage' and coalesce(trim(p_note),'') = '' then raise exception 'Say what is damaged'; end if;
  if p_kind in ('deposit_in','deposit_out') and coalesce(p_cost_paise,0) <= 0 then raise exception 'Enter the deposit amount'; end if;
  v_status := case p_kind when 'charge' then 'ready' when 'damage' then 'repair' when 'repair' then 'ready'
    when 'status' then p_status else it.status end;
  if v_status not in ('ready','charging','in_use','repair') then raise exception 'Invalid status'; end if;
  if p_kind = 'repair' and coalesce(p_cost_paise,0) > 0 then
    v_exp := record_expense(p_centre, 'RC repairs', p_cost_paise, (now() at time zone (select timezone from centres where id = p_centre))::date,
      case when p_paid_from = 'drawer' then 'cash' else 'bank' end, coalesce(p_paid_from,'drawer'),
      it.name || coalesce(' · ' || nullif(trim(p_note),''), ''), p_photo_path);
  end if;
  update rc_items set status = v_status,
    charge_cycles = charge_cycles + case when p_kind = 'charge' then 1 else 0 end,
    last_charged_at = case when p_kind = 'charge' then now() else last_charged_at end
  where id = it.id;
  insert into rc_logs(centre_id, item_id, kind, status, note, cost_paise, photo_path, expense_id, created_by)
  values (p_centre, it.id, p_kind, v_status, nullif(trim(coalesce(p_note,'')),''), coalesce(p_cost_paise,0), p_photo_path, v_exp, auth.uid());
  return jsonb_build_object('status', v_status, 'charge_cycles', it.charge_cycles + case when p_kind = 'charge' then 1 else 0 end, 'expense_id', v_exp);
end $$;

-- Fleet at a glance: items with their last few logs, and deposits currently held.
create or replace function public.rc_fleet(p_centre uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_centre_member(p_centre) then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'available', has_feature(p_centre, 'rc_fleet'),
    'items', (select coalesce(jsonb_agg(to_jsonb(i) || jsonb_build_object(
        'activity', (select name from activities where id = i.activity_id),
        'deposit_held_paise', (select coalesce(sum(case kind when 'deposit_in' then cost_paise when 'deposit_out' then -cost_paise else 0 end), 0)
          from rc_logs where item_id = i.id),
        'repairs_paise', (select coalesce(sum(cost_paise), 0) from rc_logs where item_id = i.id and kind = 'repair'),
        'logs', (select coalesce(jsonb_agg(jsonb_build_object('kind', l.kind, 'status', l.status, 'note', l.note, 'cost_paise', l.cost_paise,
            'photo_path', l.photo_path, 'at', l.created_at) order by l.id desc), '[]')
          from (select * from rc_logs where item_id = i.id order by id desc limit 8) l))
        order by i.status = 'retired', i.kind, i.sort, i.name), '[]')
      from rc_items i where i.centre_id = p_centre));
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
grant execute on function public.save_rc_item(uuid,jsonb), public.rc_log(uuid,uuid,text,text,bigint,text,text,text), public.rc_fleet(uuid)
  to authenticated;
