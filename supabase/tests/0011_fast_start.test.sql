-- XS Arena — my_home() and centre_context(): same answers as the old step-by-step loading, members only.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000ae', 'owner.fast@test.local', '{"display_name":"Owner F"}'),
  ('00000000-0000-0000-0000-0000000000af', 'desk.fast@test.local', '{"display_name":"Desk F"}'),
  ('00000000-0000-0000-0000-0000000000b0', 'stranger.fast@test.local', '{"display_name":"Stranger"}');

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create or replace function pg_temp.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin if got is distinct from want then raise exception '%: expected % but got %', label, want, got; end if; end $$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare c uuid; slug text; ctx jsonb; home jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000ae');
  c := create_centre('Fast Arena');
  select centres.slug into slug from centres where id = c;
  -- invite the desk person by email (not yet linked to an account)
  perform save_staff(c, null, 'Desk F', 'front_desk', null, null, 'desk.fast@test.local', null, 'active');
  ctx := centre_context(slug);
  perform pg_temp.eq('owner role', ctx->'me'->>'role', 'owner');
  perform pg_temp.eq('centre id', (ctx->'centre'->>'id')::uuid, c);
  perform pg_temp.eq('plan', ctx->>'plan', 'pro');
  perform pg_temp.eq('owner can design', ctx->'permissions' ? 'floor.design', true);
  perform pg_temp.eq('xs_ai feature', ctx->'features' ? 'xs_ai', true);
  perform pg_temp.eq('home lists it', (select count(*) from jsonb_array_elements(my_home()) e where e->>'slug' = slug), 1::bigint);
  perform pg_temp.eq('unknown slug', centre_context('no-such-centre'), null::jsonb);
  perform pg_temp.reset();

  -- invited desk person: my_home claims the invite, then the centre opens with front-desk permissions
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000af');
  home := my_home();
  perform pg_temp.eq('invite claimed', jsonb_array_length(home), 1);
  ctx := centre_context(slug);
  perform pg_temp.eq('desk role', ctx->'me'->>'role', 'front_desk');
  perform pg_temp.eq('desk cannot design', ctx->'permissions' ? 'floor.design', false);
  perform pg_temp.reset();

  -- a stranger sees nothing
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b0');
  perform pg_temp.eq('stranger ctx', centre_context(slug), null::jsonb);
  perform pg_temp.eq('stranger home', my_home(), '[]'::jsonb);
  perform pg_temp.reset();
end $$;

select 'fast start ok';

-- 24-hour centre: a booking that crosses midnight is fine
do $$
declare c centres;
begin
  select * into c from centres where name = 'Fast Arena';
  c.open_time := '00:00'; c.close_time := '00:00';
  perform _check_booking_time(c, ((current_date + 2) + time '23:30') at time zone c.timezone, 60, true);
  c.open_time := '10:00'; c.close_time := '22:00';
  begin
    perform _check_booking_time(c, ((current_date + 2) + time '21:30') at time zone c.timezone, 60, true);
    raise exception 'expected closing-time error';
  exception when others then
    if sqlerrm not like 'We are open%' then raise; end if;
  end;
end $$;
select '24 hours ok';
