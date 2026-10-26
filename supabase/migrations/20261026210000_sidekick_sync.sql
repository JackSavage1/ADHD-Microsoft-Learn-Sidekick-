-- Sidekick cloud sync.
--
-- Two tables hold each learner's progress. Row level security is on with no
-- policies, and the API roles have no table privileges, so nobody can read or
-- write the tables directly through Supabase's API. The extension can only call
-- the four functions at the bottom, and each one checks the sync code first.
--
-- A sync code is the learner's only key: no emails, no passwords. The database
-- generates it, returns it once, and stores only its SHA-256 hash.

create extension if not exists pgcrypto with schema extensions;


-- ---- Tables -------------------------------------------------------------------

create table public.sidekick_accounts (
  id bigint generated always as identity primary key,
  code_hash text not null unique,           -- sha256 of the sync code, never the code itself
  created_at timestamptz not null default now()
);

create index sidekick_accounts_created_at on public.sidekick_accounts (created_at);

-- One row per account: the whole progress snapshot the panel sends, plus a
-- version number that goes up by one on every save.
create table public.sidekick_progress (
  account_id bigint primary key references public.sidekick_accounts (id) on delete cascade,
  data jsonb not null,
  version integer not null,
  updated_at timestamptz not null default now()
);

alter table public.sidekick_accounts enable row level security;
alter table public.sidekick_progress enable row level security;
revoke all on public.sidekick_accounts, public.sidekick_progress from anon, authenticated;


-- ---- Private helpers (not reachable through the API) ----------------------------

create schema if not exists sidekick_private;
revoke all on schema sidekick_private from public, anon, authenticated;

-- 'k7qx2-mpd4r-...' -> 'K7QX2MPD4R...'. Crockford base32 reads O as 0 and I or L
-- as 1, so a mistyped letter still works.
create function sidekick_private.normalize_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'OIL', '011')
$$;

create function sidekick_private.code_hash(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(sidekick_private.normalize_code(p_code), 'sha256'), 'hex')
$$;

-- The account a sync code belongs to, or null if the code is malformed or unknown.
create function sidekick_private.account_id(p_code text)
returns bigint
language sql
stable
set search_path = ''
as $$
  select a.id
  from public.sidekick_accounts a
  where sidekick_private.normalize_code(p_code) ~ '^[0-9A-HJKMNP-TV-Z]{20}$'
    and a.code_hash = sidekick_private.code_hash(p_code)
$$;

revoke all on all functions in schema sidekick_private from public, anon, authenticated;


-- ---- The API: four functions ----------------------------------------------------
-- Called as POST /rest/v1/rpc/<name>. Each answers with JSON whose "status" is
-- 'ok', or a reason: 'unknown_code', 'conflict', 'invalid', 'too_large', 'busy'.
-- SECURITY DEFINER lets them use the locked tables; an empty search_path stops
-- anyone from swapping in look-alike tables or functions.

-- New account. Returns its sync code, the only time the code is ever shown.
create function public.sidekick_create_account()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  random_bytes bytea := extensions.gen_random_bytes(20);
  code text := '';
begin
  -- A simple brake on spam: at most 30 new accounts per minute, across everyone.
  if (select count(*) from public.sidekick_accounts where created_at > now() - interval '1 minute') >= 30 then
    return jsonb_build_object('status', 'busy');
  end if;

  -- 20 characters from 20 random bytes, 5 bits each: about 100 bits. 256 is a
  -- multiple of 32, so taking each byte mod 32 favours no character.
  for i in 0..19 loop
    code := code || substr(alphabet, get_byte(random_bytes, i) % 32 + 1, 1);
  end loop;

  insert into public.sidekick_accounts (code_hash) values (sidekick_private.code_hash(code));

  return jsonb_build_object(
    'status', 'ok',
    'code', substr(code, 1, 5) || '-' || substr(code, 6, 5) || '-' || substr(code, 11, 5) || '-' || substr(code, 16, 5)
  );
end;
$$;

-- The saved progress for a code. A new account has data null and version 0.
create function public.sidekick_get_progress(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account bigint := sidekick_private.account_id(p_code);
  saved public.sidekick_progress;
begin
  if account is null then
    return jsonb_build_object('status', 'unknown_code');
  end if;
  select * into saved from public.sidekick_progress where account_id = account;
  return jsonb_build_object(
    'status', 'ok',
    'data', saved.data,
    'version', coalesce(saved.version, 0),
    'updatedAt', saved.updated_at
  );
end;
$$;

-- Save progress, but only if nobody else saved since the version this copy is
-- based on. The check and the write are one statement, so two computers saving
-- at the same moment can't both win. The loser gets 'conflict' with the current
-- copy, merges it, and tries again.
create function public.sidekick_put_progress(p_code text, p_data jsonb, p_base_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account bigint := sidekick_private.account_id(p_code);
  saved public.sidekick_progress;
begin
  if account is null then
    return jsonb_build_object('status', 'unknown_code');
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or p_base_version is null or p_base_version < 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if octet_length(p_data::text) > 262144 then
    return jsonb_build_object('status', 'too_large');
  end if;

  if p_base_version = 0 then
    insert into public.sidekick_progress (account_id, data, version)
    values (account, p_data, 1)
    on conflict (account_id) do nothing
    returning * into saved;
  else
    update public.sidekick_progress
    set data = p_data, version = version + 1, updated_at = now()
    where account_id = account and version = p_base_version
    returning * into saved;
  end if;

  if saved.account_id is not null then
    return jsonb_build_object('status', 'ok', 'version', saved.version, 'updatedAt', saved.updated_at);
  end if;

  -- Someone saved first: send back the current copy.
  select * into saved from public.sidekick_progress where account_id = account;
  return jsonb_build_object(
    'status', 'conflict',
    'data', saved.data,
    'version', coalesce(saved.version, 0),
    'updatedAt', saved.updated_at
  );
end;
$$;

-- Delete the account and its progress ("Delete my cloud data").
create function public.sidekick_delete_account(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account bigint := sidekick_private.account_id(p_code);
begin
  if account is null then
    return jsonb_build_object('status', 'unknown_code');
  end if;
  delete from public.sidekick_accounts where id = account; -- progress goes too (on delete cascade)
  return jsonb_build_object('status', 'ok');
end;
$$;

-- Only these four functions are callable through the API.
revoke all on function public.sidekick_create_account() from public;
revoke all on function public.sidekick_get_progress(text) from public;
revoke all on function public.sidekick_put_progress(text, jsonb, integer) from public;
revoke all on function public.sidekick_delete_account(text) from public;
grant execute on function public.sidekick_create_account() to anon, authenticated;
grant execute on function public.sidekick_get_progress(text) to anon, authenticated;
grant execute on function public.sidekick_put_progress(text, jsonb, integer) to anon, authenticated;
grant execute on function public.sidekick_delete_account(text) to anon, authenticated;
