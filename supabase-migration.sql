-- Run this once in Supabase SQL Editor after the original leads table setup.
alter table public.leads
  add column if not exists tag text default '',
  add column if not exists last_called timestamptz;

-- Keep New Leads / Follow-ups driven by one canonical status field.
-- These views make the split visible in Supabase without duplicating records.
create or replace view public.new_leads
with (security_invoker = true)
as
select * from public.leads where status = 'new';

create or replace view public.followups
with (security_invoker = true)
as
select * from public.leads where status = 'followup';

-- Enable live Postgres changes for the leads table once.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'leads'
  ) then
    alter publication supabase_realtime add table public.leads;
  end if;
end $$;
