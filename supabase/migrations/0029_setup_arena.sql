-- XS Arena — "Set up your arena" steps for new centres.
-- setup_arena: the owner picks what the centre has from the ready-made list (snooker, pool, PS5, RC tracks, VR, turf…)
-- with prices; we create or reuse each activity, save its price and switch off ready-made activities they don't have.
-- The floor itself is then saved with save_floor (laid out in the app).

-- Centres made before this have been set up already (the demo, test centres): don't show them the setup steps.
update public.centres set onboarded_at = coalesce(onboarded_at, created_at) where onboarded_at is null;

-- p_items: [{name, kind, icon, color, card: {billing_mode, price_paise, slot_minutes, min_minutes, grace_minutes, per_player,
--            included_players, extra_player_paise}}]
-- Returns {"<name>": "<activity id>", …}
create or replace function public.setup_arena(p_centre uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x jsonb; v_id uuid; v_out jsonb := '{}'; v_names text[] := '{}'; rc rate_cards; v_card jsonb;
begin
  perform require_perm(p_centre, 'settings.manage');
  perform require_perm(p_centre, 'pricing.manage');
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Pick at least one thing your arena has'; end if;
  if jsonb_array_length(p_items) > 40 then raise exception 'Too many items'; end if;
  for x in select * from jsonb_array_elements(p_items) loop
    if coalesce(length(trim(x->>'name')), 0) not between 1 and 40 then raise exception 'Each item needs a name'; end if;
    if coalesce(x->>'kind', '') not in ('table', 'console', 'track', 'other') then raise exception 'Invalid type for %', x->>'name'; end if;
    v_card := coalesce(x->'card', '{}');
    if coalesce((v_card->>'price_paise')::bigint, -1) < 0 or (v_card->>'price_paise')::bigint > 10000000 then
      raise exception 'Enter a price for %', x->>'name';
    end if;
    if lower(trim(x->>'name')) = any(v_names) then raise exception '% is listed twice', x->>'name'; end if;
    v_names := v_names || lower(trim(x->>'name'));

    select id into v_id from activities where centre_id = p_centre and lower(name) = lower(trim(x->>'name'));
    if v_id is null then
      insert into activities(centre_id, name, kind, icon, color, sort)
      values (p_centre, trim(x->>'name'), x->>'kind', coalesce(x->>'icon', 'circle'), coalesce(x->>'color', '#2A78D6'),
        (select coalesce(max(sort), 0) + 1 from activities where centre_id = p_centre))
      returning id into v_id;
    else
      update activities set active = true where id = v_id;
    end if;
    -- save the price only when it differs from the current one (no needless price versions)
    select * into rc from rate_cards where activity_id = v_id and active;
    if rc.id is null or rc.billing_mode is distinct from coalesce(v_card->>'billing_mode', 'per_minute')
       or rc.price_paise <> (v_card->>'price_paise')::bigint
       or rc.slot_minutes <> coalesce((v_card->>'slot_minutes')::int, 15)
       or rc.per_player <> coalesce((v_card->>'per_player')::boolean, false)
       or rc.included_players <> coalesce((v_card->>'included_players')::int, 1)
       or rc.extra_player_paise <> coalesce((v_card->>'extra_player_paise')::bigint, 0) then
      perform save_rate_card(p_centre, v_id, v_card || jsonb_build_object('addons', coalesce(rc.addons, '[]'::jsonb)));
    end if;
    v_out := v_out || jsonb_build_object(trim(x->>'name'), v_id);
  end loop;

  -- ready-made activities they don't have: switch off (kept for history), unless something is on the floor for them
  update activities a set active = false
  where a.centre_id = p_centre and a.active and not (lower(a.name) = any(v_names))
    and not exists (select 1 from resources r where r.activity_id = a.id and r.status <> 'archived');

  perform log_audit(p_centre, 'setup', 'centre', p_centre, jsonb_build_object('items', v_names));
  return v_out;
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.setup_arena(uuid, jsonb) to authenticated;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int,text),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
