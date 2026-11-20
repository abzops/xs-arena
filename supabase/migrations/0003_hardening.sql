-- Supabase's default privileges hand TRUNCATE/REFERENCES/TRIGGER to API roles on new tables.
-- The Data API can't issue them, but nothing should hold them: strip them now and for future tables.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon;
