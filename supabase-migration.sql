-- Steady Hands Operations Leads
-- Exactly 3 lead tables: new_leads, follow_ups, sold_leads
-- Only Kiara can move leads between pipeline stages.
-- Sold phone numbers remain in sold_leads, but normal authenticated users
-- cannot SELECT the phone column. Kiara reads it through a protected RPC.

create extension if not exists pgcrypto;

create table if not exists public.new_leads (
  id uuid primary key default gen_random_uuid(),
  name text default '', company text default '', phone text default '', email text default '', site text default '',
  lead_type text default '', tags text[] default '{}', source_tags text[] default '{}', spanish_possible boolean default false,
  age text default '', issue text default '', concerns text default '', notes text default '',
  answer_status text default '', mood text default '', outcome text default '',
  callback_date date, callback_time text, preferred_contact text default '',
  preferred_date date, preferred_time text, preferred_days text[] default '{}',
  time_preference text default '', specific_time text, tag text default '',
  last_called timestamptz, history jsonb default '[]'::jsonb, sold_by text default '',
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table if not exists public.follow_ups (
  id uuid default gen_random_uuid(),
  name text default '', company text default '', phone text default '', email text default '', site text default '',
  lead_type text default '', tags text[] default '{}', source_tags text[] default '{}', spanish_possible boolean default false,
  age text default '', issue text default '', concerns text default '', notes text default '',
  answer_status text default '', mood text default '', outcome text default '',
  callback_date date, callback_time text, preferred_contact text default '',
  preferred_date date, preferred_time text, preferred_days text[] default '{}',
  time_preference text default '', specific_time text, tag text default '',
  last_called timestamptz, history jsonb default '[]'::jsonb, sold_by text default '',
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table if not exists public.sold_leads (
  id uuid default gen_random_uuid(),
  name text default '', company text default '', phone text default '', email text default '', site text default '',
  lead_type text default '', tags text[] default '{}', source_tags text[] default '{}', spanish_possible boolean default false,
  age text default '', issue text default '', concerns text default '', notes text default '',
  answer_status text default '', mood text default '', outcome text default '',
  callback_date date, callback_time text, preferred_contact text default '',
  preferred_date date, preferred_time text, preferred_days text[] default '{}',
  time_preference text default '', specific_time text, tag text default '',
  last_called timestamptz, history jsonb default '[]'::jsonb, sold_by text default '',
  created_at timestamptz default now(), updated_at timestamptz default now()
);

-- Safe upgrades for any tables that already existed.
alter table public.new_leads add column if not exists email text default '';
alter table public.new_leads add column if not exists source_tags text[] default '{}';
alter table public.new_leads add column if not exists history jsonb default '[]'::jsonb;
alter table public.new_leads add column if not exists sold_by text default '';
alter table public.new_leads add column if not exists updated_at timestamptz default now();

alter table public.follow_ups add column if not exists email text default '';
alter table public.follow_ups add column if not exists source_tags text[] default '{}';
alter table public.follow_ups add column if not exists history jsonb default '[]'::jsonb;
alter table public.follow_ups add column if not exists sold_by text default '';
alter table public.follow_ups add column if not exists updated_at timestamptz default now();

alter table public.sold_leads add column if not exists email text default '';
alter table public.sold_leads add column if not exists source_tags text[] default '{}';
alter table public.sold_leads add column if not exists history jsonb default '[]'::jsonb;
alter table public.sold_leads add column if not exists sold_by text default '';
alter table public.sold_leads add column if not exists updated_at timestamptz default now();

-- The older LIKE-based migration may have created follow_ups/sold_leads
-- without a primary key. Upserts require a unique/primary id.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.follow_ups'::regclass and contype = 'p'
  ) then
    alter table public.follow_ups alter column id set not null;
    alter table public.follow_ups add constraint follow_ups_pkey primary key (id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sold_leads'::regclass and contype = 'p'
  ) then
    alter table public.sold_leads alter column id set not null;
    alter table public.sold_leads add constraint sold_leads_pkey primary key (id);
  end if;
end $$;

-- Remove the old extra private-phone-table design if it was partially installed.
drop trigger if exists redact_sold_lead_phone_trigger on public.sold_leads;
drop function if exists public.redact_sold_lead_phone();
drop function if exists public.store_sold_phone(uuid, text);

-- If the old private table exists and contains anything, copy it back into
-- sold_leads.phone before removing that table.
do $$
begin
  if to_regclass('public.sold_private_phones') is not null then
    execute '
      update public.sold_leads s
      set phone = p.phone
      from public.sold_private_phones p
      where s.id = p.lead_id
        and coalesce(p.phone, '''') <> ''''
    ';
  end if;
end $$;

drop table if exists public.sold_private_phones;

-- RLS --------------------------------------------------------------------
alter table public.new_leads enable row level security;
alter table public.follow_ups enable row level security;
alter table public.sold_leads enable row level security;

-- Remove previous broad policies.
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('new_leads','follow_ups','sold_leads')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- New Leads: everyone signed in may view/edit/add. Only Kiara may remove a row
-- from this stage, which is required to move it elsewhere.
create policy "new leads select" on public.new_leads for select to authenticated using (true);
create policy "new leads insert" on public.new_leads for insert to authenticated with check (true);
create policy "new leads update" on public.new_leads for update to authenticated using (true) with check (true);
create policy "new leads delete kiara" on public.new_leads for delete to authenticated
using (lower(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)) = 'kiara');

-- Follow-ups: everyone may view/edit an existing row. Only Kiara can insert
-- or delete here, so only Kiara can move a lead into/out of Follow-ups.
create policy "follow ups select" on public.follow_ups for select to authenticated using (true);
create policy "follow ups update" on public.follow_ups for update to authenticated using (true) with check (true);
create policy "follow ups insert kiara" on public.follow_ups for insert to authenticated
with check (lower(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)) = 'kiara');
create policy "follow ups delete kiara" on public.follow_ups for delete to authenticated
using (lower(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)) = 'kiara');

-- Sold: everyone may view/edit the non-phone customer information. Only Kiara
-- can insert/delete sold rows, which controls movement into/out of Sold.
create policy "sold select" on public.sold_leads for select to authenticated using (true);
create policy "sold update" on public.sold_leads for update to authenticated using (true) with check (true);
create policy "sold insert kiara" on public.sold_leads for insert to authenticated
with check (lower(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)) = 'kiara');
create policy "sold delete kiara" on public.sold_leads for delete to authenticated
using (lower(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)) = 'kiara');

-- Table privileges -------------------------------------------------------
grant select, insert, update, delete on public.new_leads to authenticated;
grant select, insert, update, delete on public.follow_ups to authenticated;

-- sold_leads uses column-level SELECT/UPDATE privileges so the phone column
-- cannot be fetched by other authenticated users.
revoke all on public.sold_leads from anon;
revoke all on public.sold_leads from authenticated;

grant select (
  id,name,company,email,site,lead_type,tags,source_tags,spanish_possible,
  age,issue,concerns,notes,answer_status,mood,outcome,callback_date,callback_time,
  preferred_contact,preferred_date,preferred_time,preferred_days,time_preference,
  specific_time,tag,last_called,history,sold_by,created_at,updated_at
) on public.sold_leads to authenticated;

grant update (
  name,company,email,site,lead_type,tags,source_tags,spanish_possible,
  age,issue,concerns,notes,answer_status,mood,outcome,callback_date,callback_time,
  preferred_contact,preferred_date,preferred_time,preferred_days,time_preference,
  specific_time,tag,last_called,history,sold_by,updated_at
) on public.sold_leads to authenticated;

-- INSERT/DELETE are granted at the SQL privilege level, but RLS above allows
-- them only for Kiara.
grant insert, delete on public.sold_leads to authenticated;

-- Kiara-only phone functions. No extra phone table is created.
create or replace function public.get_sold_phones()
returns table (lead_id uuid, phone text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)) <> 'kiara' then
    return;
  end if;
  return query select id, sold_leads.phone from public.sold_leads;
end;
$$;

create or replace function public.set_sold_phone(p_lead_id uuid, p_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)) <> 'kiara' then
    raise exception 'Only Kiara can change sold phone numbers';
  end if;

  update public.sold_leads
  set phone = coalesce(p_phone,''), updated_at = now()
  where id = p_lead_id;
end;
$$;

revoke all on function public.get_sold_phones() from public;
revoke all on function public.set_sold_phone(uuid,text) from public;
grant execute on function public.get_sold_phones() to authenticated;
grant execute on function public.set_sold_phone(uuid,text) to authenticated;

-- Realtime tables (safe if already present).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='new_leads') then
    alter publication supabase_realtime add table public.new_leads;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='follow_ups') then
    alter publication supabase_realtime add table public.follow_ups;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sold_leads') then
    alter publication supabase_realtime add table public.sold_leads;
  end if;
end $$;

notify pgrst, 'reload schema';
