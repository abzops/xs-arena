-- Postgres regexes allow at most 255 repetitions: fix the UPI ID format check.
alter table public.centres drop constraint if exists centres_upi_id_check;
alter table public.centres add constraint centres_upi_id_check
  check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$');
