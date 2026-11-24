-- Every centre gets online booking and loyalty points switched on from day one (Abhinand, 24 Nov).
-- Owners can still turn either off in Settings. Plan gating (has_feature) still applies.

alter table public.centres alter column booking_enabled set default true;
alter table public.loyalty_settings alter column enabled set default true;

-- New centres: loyalty rules row with the default rules, switched on.
create or replace function public._centre_loyalty_default() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into loyalty_settings(centre_id, enabled) values (new.id, true) on conflict (centre_id) do nothing;
  return new;
end $$;
revoke execute on function public._centre_loyalty_default() from public, anon, authenticated;
create trigger centres_loyalty_default after insert on public.centres
  for each row execute function public._centre_loyalty_default();

-- Existing centres: switch both on.
update public.centres set booking_enabled = true where not booking_enabled;
insert into public.loyalty_settings(centre_id, enabled) select id, true from public.centres on conflict (centre_id) do update set enabled = true;
