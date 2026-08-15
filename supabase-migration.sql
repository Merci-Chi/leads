-- Steady Hands Operations Leads - two-table Supabase setup

create table if not exists public.new_leads (
  id uuid primary key default gen_random_uuid(),
  name text default '', company text default '', phone text default '', email text default '', site text default '',
  lead_type text default '', tags text[] default '{}', spanish_possible boolean default false,
  age text default '', issue text default '', concerns text default '', notes text default '',
  answer_status text default '', mood text default '', outcome text default '',
  callback_date date, callback_time text, preferred_contact text default '',
  preferred_date date, preferred_time text, preferred_days text[] default '{}',
  time_preference text default '', specific_time text, tag text default '',
  last_called timestamptz, created_at timestamptz default now(), updated_at timestamptz default now()
);

create table if not exists public.follow_ups (like public.new_leads including defaults including constraints);

alter table public.new_leads enable row level security;
alter table public.follow_ups enable row level security;

grant select, insert, update, delete on public.new_leads to authenticated;
grant select, insert, update, delete on public.follow_ups to authenticated;

drop policy if exists "authenticated access new leads" on public.new_leads;
create policy "authenticated access new leads" on public.new_leads for all to authenticated using (true) with check (true);

drop policy if exists "authenticated access follow ups" on public.follow_ups;
create policy "authenticated access follow ups" on public.follow_ups for all to authenticated using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='new_leads') then
    alter publication supabase_realtime add table public.new_leads;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='follow_ups') then
    alter publication supabase_realtime add table public.follow_ups;
  end if;
end $$;

notify pgrst, 'reload schema';


-- Safe upgrade for existing projects
alter table public.new_leads add column if not exists email text default '';
alter table public.follow_ups add column if not exists email text default '';
alter table public.new_leads add column if not exists history jsonb default '[]'::jsonb;
alter table public.follow_ups add column if not exists history jsonb default '[]'::jsonb;
notify pgrst, 'reload schema';


-- Lead discovery/source platforms
alter table public.new_leads add column if not exists source_tags text[] default '{}';
alter table public.follow_ups add column if not exists source_tags text[] default '{}';
notify pgrst, 'reload schema';
