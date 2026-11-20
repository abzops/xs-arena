-- Quick layout may reuse names of items it replaces: archive removed items before inserting new ones.
create or replace function public.save_floor(p_centre uuid, p_floor jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_floor uuid := nullif(p_floor->>'id','')::uuid; v_old floors; r jsonb; v_keep uuid[] := '{}'; v_rid uuid; v_ver int;
begin
  perform require_perm(p_centre, 'floor.design');
  if v_floor is null then
    insert into floors(centre_id, name, width, height, outline, fixtures, sort, updated_by)
    values (p_centre, coalesce(nullif(trim(p_floor->>'name'),''),'Main hall'), coalesce((p_floor->>'width')::int,2000),
      coalesce((p_floor->>'height')::int,1200), coalesce(p_floor->'outline','[]'), coalesce(p_floor->'fixtures','[]'),
      coalesce((p_floor->>'sort')::int, (select coalesce(max(sort),0)+1 from floors where centre_id = p_centre)), auth.uid())
    returning id, version into v_floor, v_ver;
  else
    select * into v_old from floors where id = v_floor and centre_id = p_centre for update;
    if not found then raise exception 'Floor not found'; end if;
    if p_floor ? 'version' and (p_floor->>'version')::int <> v_old.version then
      raise exception 'This floor was changed by someone else. Reload to see the latest layout.';
    end if;
    update floors set name = coalesce(nullif(trim(p_floor->>'name'),''), name), width = coalesce((p_floor->>'width')::int, width),
      height = coalesce((p_floor->>'height')::int, height), outline = coalesce(p_floor->'outline', outline),
      fixtures = coalesce(p_floor->'fixtures', fixtures), sort = coalesce((p_floor->>'sort')::int, sort),
      version = version + 1, updated_by = auth.uid(), updated_at = now()
    where id = v_floor returning version into v_ver;
  end if;

  -- retire what the designer removed first, so a new item may reuse a removed item's name
  if p_floor ? 'resources' then
    select coalesce(array_agg(nullif(x->>'id','')::uuid), '{}') into v_keep from jsonb_array_elements(p_floor->'resources') x where nullif(x->>'id','') is not null;
    if exists (select 1 from resources r join sessions s on s.resource_id = r.id and s.status in ('running','paused')
               where r.floor_id = v_floor and r.status <> 'archived' and not (r.id = any(v_keep))) then
      raise exception 'A table you removed has a game running. End it first.';
    end if;
    update resources set status = 'archived' where floor_id = v_floor and status <> 'archived' and not (id = any(v_keep));
    v_keep := '{}';
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_floor->'resources','[]')) loop
    if not exists (select 1 from activities where id = (r->>'activity_id')::uuid and centre_id = p_centre) then
      raise exception 'Unknown activity for %', coalesce(r->>'name','an item');
    end if;
    v_rid := nullif(r->>'id','')::uuid;
    if v_rid is not null and exists (select 1 from resources where id = v_rid and centre_id = p_centre) then
      update resources set floor_id = v_floor, activity_id = (r->>'activity_id')::uuid, name = trim(r->>'name'),
        shape = coalesce(r->>'shape', shape), x = coalesce((r->>'x')::numeric, x), y = coalesce((r->>'y')::numeric, y),
        w = coalesce((r->>'w')::numeric, w), h = coalesce((r->>'h')::numeric, h), rotation = coalesce((r->>'rotation')::numeric, rotation),
        points = case when r ? 'points' then nullif(r->'points', 'null'::jsonb) else points end, capacity = coalesce((r->>'capacity')::int, capacity),
        online_bookable = coalesce((r->>'online_bookable')::boolean, online_bookable),
        status = case when coalesce(r->>'status','active') = 'out_of_service' then 'out_of_service' else 'active' end
      where id = v_rid;
    else
      insert into resources(id, centre_id, floor_id, activity_id, name, shape, x, y, w, h, rotation, points, capacity, online_bookable, sort)
      values (coalesce(v_rid, gen_random_uuid()), p_centre, v_floor, (r->>'activity_id')::uuid, trim(r->>'name'), coalesce(r->>'shape','rect'),
        coalesce((r->>'x')::numeric,0), coalesce((r->>'y')::numeric,0), coalesce((r->>'w')::numeric,200), coalesce((r->>'h')::numeric,100),
        coalesce((r->>'rotation')::numeric,0), nullif(r->'points', 'null'::jsonb), coalesce((r->>'capacity')::int,4), coalesce((r->>'online_bookable')::boolean,true),
        (select coalesce(max(sort),0)+1 from resources where centre_id = p_centre))
      returning id into v_rid;
    end if;
    v_keep := v_keep || v_rid;
  end loop;

  perform log_audit(p_centre, 'save', 'floor', v_floor, jsonb_build_object('version', v_ver, 'resources', array_length(v_keep,1)));
  return jsonb_build_object('floor_id', v_floor, 'version', v_ver);
end $$;
