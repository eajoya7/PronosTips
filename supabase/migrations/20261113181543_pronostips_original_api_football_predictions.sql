create table if not exists public.pronostips_predictions (
  fixture_id bigint primary key,
  provider_fixture_key text not null unique,
  match_date date not null,
  kickoff_at timestamptz not null,
  league_id text,
  league_name text not null default 'Fútbol',
  home_team text not null,
  away_team text not null,
  advice text,
  winner jsonb,
  percent jsonb,
  goals jsonb,
  comparison jsonb,
  provider_response jsonb,
  prediction_available boolean not null default false,
  fetch_status text not null default 'ok' check (fetch_status in ('ok', 'error')),
  fetch_error text,
  fetched_at timestamptz not null default now()
);
create index if not exists pronostips_predictions_date_kickoff_idx
  on public.pronostips_predictions (match_date, kickoff_at);

alter table public.pronostips_predictions enable row level security;
drop policy if exists "Signed-in users can read original predictions" on public.pronostips_predictions;
create policy "Signed-in users can read original predictions"
  on public.pronostips_predictions for select to authenticated using (true);
grant select on public.pronostips_predictions to authenticated;
grant select, insert, update, delete on public.pronostips_predictions to service_role;

create table if not exists public.pronostips_api_football_usage (
  usage_date date primary key,
  request_count integer not null default 0 check (request_count >= 0)
);
alter table public.pronostips_api_football_usage enable row level security;
revoke all on public.pronostips_api_football_usage from anon, authenticated;
grant select, insert, update on public.pronostips_api_football_usage to service_role;

create or replace function public.pronostips_reserve_api_football_call(daily_limit integer default 100)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_count integer;
  bogota_date date := (now() at time zone 'America/Bogota')::date;
begin
  if daily_limit < 1 or daily_limit > 100 then
    raise exception 'daily_limit must be between 1 and 100';
  end if;
  insert into public.pronostips_api_football_usage as daily_usage (usage_date, request_count)
    values (bogota_date, 1)
    on conflict (usage_date) do update
      set request_count = daily_usage.request_count + 1
      where daily_usage.request_count < daily_limit
    returning request_count into next_count;
  return next_count;
end;
$$;
revoke all on function public.pronostips_reserve_api_football_call(integer) from public, anon, authenticated;
grant execute on function public.pronostips_reserve_api_football_call(integer) to service_role;


