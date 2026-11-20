-- Functions are created with EXECUTE for PUBLIC/anon by default. Nothing in XS Arena is callable signed out
-- (the public booking page arrives later with its own explicitly granted functions).
revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
alter function public._events_immutable() set search_path = public;
