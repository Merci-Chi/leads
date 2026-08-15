-- Run this once in Supabase SQL Editor after the original leads table setup.
alter table public.leads
  add column if not exists tag text default '',
  add column if not exists last_called timestamptz;
