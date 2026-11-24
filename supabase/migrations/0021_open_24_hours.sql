-- XS Arena — a centre open 24 hours (same opening and closing time) accepts bookings that cross midnight.
-- Before, a 24-hour centre refused e.g. 11:30 PM for 1 hour ("We are open 12:00 AM to 12:00 AM").

create or replace function public._check_booking_time(c centres, p_start timestamptz, p_minutes int, p_staff boolean)
returns void language plpgsql stable set search_path = public as $$
declare v_local timestamp := p_start at time zone c.timezone; v_day date := v_local::date; v_open timestamp; v_close timestamp;
begin
  if coalesce(p_minutes, 0) < 5 or p_minutes > 720 then raise exception 'Choose how long you want to play'; end if;
  if p_start < now() - interval '5 minutes' then raise exception 'That time has passed'; end if;
  if not p_staff then
    if p_start < now() + make_interval(mins => c.booking_lead_minutes) then
      raise exception 'Book at least % minutes ahead', c.booking_lead_minutes;
    end if;
    if p_start > now() + make_interval(days => c.booking_days_ahead + 1) then
      raise exception 'Bookings open % days ahead', c.booking_days_ahead;
    end if;
  end if;
  -- open 24 hours (same open and close time): any time is fine
  if c.open_time = c.close_time then return; end if;
  -- opening hours; a close time at or before the open time means "after midnight"
  if v_local::time < c.open_time and c.close_time <= c.open_time then v_day := v_day - 1; end if;
  v_open := v_day + c.open_time;
  v_close := v_day + c.close_time + case when c.close_time <= c.open_time then interval '1 day' else interval '0' end;
  if v_local < v_open or v_local + make_interval(mins => p_minutes) > v_close then
    raise exception 'We are open % to %', to_char(c.open_time, 'FMHH12:MI AM'), to_char(c.close_time, 'FMHH12:MI AM');
  end if;
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.tv_begin(), public.tv_poll(text), public.booking_page(text), public.booking_slots(text,uuid,date,int,int),
  public.create_booking(text,uuid,timestamptz,int,int,text,text,text), public.booking_ticket(text), public.cancel_booking_by_token(text)
  to anon, authenticated;
