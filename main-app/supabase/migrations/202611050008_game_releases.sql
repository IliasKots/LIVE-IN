-- Game package releases for launcher downloads from private Cloudflare R2.
-- A release row describes one immutable ZIP object. Only rows marked 'ready' (verified and published) are
-- ever handed to the launcher, and at most one ready release exists per game/platform. Presigned URLs are
-- generated per request by the server and are never stored here.
-- All access goes through service-role-only security definer functions, like the points ledger.

create table if not exists public.game_releases (
  id uuid primary key default gen_random_uuid(),
  game_id text not null check (game_id ~ '^[a-z0-9_-]{1,100}$'),
  platform text not null default 'windows-x64' check (platform in ('windows-x64')),
  version text not null check (char_length(version) between 1 and 64 and version = btrim(version)
    and version !~ '[[:cntrl:]]'),
  bucket text not null check (bucket ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  filename text not null check (filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.zip$'),
  object_key text not null,
  size_bytes bigint not null check (size_bytes between 1 and 2147483648),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  executable_path text not null check (char_length(executable_path) between 5 and 240
    and lower(executable_path) like '%.exe' and executable_path = btrim(executable_path)
    and executable_path !~ '[\\:%<>"|?*[:cntrl:]]' and left(executable_path, 1) <> '/'),
  status text not null default 'pending' check (status in ('pending', 'ready', 'disabled')),
  verified_at timestamptz,
  verification jsonb not null default '{}'::jsonb check (jsonb_typeof(verification) = 'object'),
  published_at timestamptz,
  publisher text check (publisher is null or char_length(publisher) <= 200),
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_releases_key_layout check (object_key = game_id || '/' || version || '/' || filename),
  constraint game_releases_ready_verified check (status <> 'ready' or (verified_at is not null and published_at is not null)),
  constraint game_releases_version_unique unique (game_id, platform, version),
  constraint game_releases_object_unique unique (bucket, object_key)
);

create unique index if not exists game_releases_one_ready
  on public.game_releases (game_id, platform) where status = 'ready';

-- Package identity is immutable: a repaired or rebuilt package is a new version/key, never an edit.
create or replace function public.game_releases_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.game_id is distinct from old.game_id
    or new.platform is distinct from old.platform or new.version is distinct from old.version
    or new.bucket is distinct from old.bucket or new.filename is distinct from old.filename
    or new.object_key is distinct from old.object_key or new.size_bytes is distinct from old.size_bytes
    or new.sha256 is distinct from old.sha256 or new.executable_path is distinct from old.executable_path
    or new.created_at is distinct from old.created_at) then
    raise exception 'GAME_RELEASE_IMMUTABLE' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists game_releases_guard on public.game_releases;
create trigger game_releases_guard before update on public.game_releases
  for each row execute function public.game_releases_guard();

-- One row per authenticated download request: audit trail and per-account rate limiting. No URLs.
create table if not exists public.game_download_requests (
  request_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id text not null check (game_id ~ '^[a-z0-9_-]{1,100}$'),
  version text check (version is null or char_length(version) <= 64),
  outcome text not null default 'requested' check (outcome in ('requested', 'issued', 'rate_limited',
    'package_unavailable', 'game_not_found', 'signing_failed', 'server_error')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists game_download_requests_user_time on public.game_download_requests (user_id, created_at desc);

alter table public.game_releases enable row level security;
alter table public.game_download_requests enable row level security;
revoke all on public.game_releases from public, anon, authenticated, service_role;
revoke all on public.game_download_requests from public, anon, authenticated, service_role;

-- Returns the single verified, published release, or null. Never returns pending/disabled rows.
create or replace function public.get_ready_game_release(p_game_id text, p_platform text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('gameId', r.game_id, 'platform', r.platform, 'version', r.version,
    'bucket', r.bucket, 'objectKey', r.object_key, 'filename', r.filename, 'sizeBytes', r.size_bytes,
    'sha256', r.sha256, 'executablePath', r.executable_path)
  from public.game_releases r
  where r.game_id = p_game_id and r.platform = p_platform and r.status = 'ready'
    and r.verified_at is not null and r.published_at is not null
  limit 1
$$;

-- Atomically applies the per-account limit and records the attempt.
create or replace function public.begin_game_download(p_request_id uuid, p_user_id uuid, p_game_id text,
  p_limit integer, p_window_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  recent integer;
  oldest timestamptz;
begin
  if p_request_id is null or p_user_id is null or p_limit < 1 or p_limit > 1000
    or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'GAME_DOWNLOAD_INVALID_ARGUMENT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('game_download:' || p_user_id::text, 0));
  select count(*), min(created_at) into recent, oldest from public.game_download_requests
    where user_id = p_user_id and outcome <> 'rate_limited'
      and created_at > now() - make_interval(secs => p_window_seconds);
  if recent >= p_limit then
    insert into public.game_download_requests (request_id, user_id, game_id, outcome, completed_at)
      values (p_request_id, p_user_id, p_game_id, 'rate_limited', now());
    return jsonb_build_object('allowed', false, 'retryAfter',
      greatest(1, ceil(extract(epoch from (oldest + make_interval(secs => p_window_seconds) - now())))::integer));
  end if;
  insert into public.game_download_requests (request_id, user_id, game_id) values (p_request_id, p_user_id, p_game_id);
  return jsonb_build_object('allowed', true, 'retryAfter', 0);
end $$;

create or replace function public.finish_game_download(p_request_id uuid, p_outcome text, p_version text)
returns void language sql security definer set search_path = '' as $$
  update public.game_download_requests set outcome = p_outcome, version = p_version, completed_at = now()
    where request_id = p_request_id and outcome = 'requested'
$$;

revoke all on function public.get_ready_game_release(text, text),
  public.begin_game_download(uuid, uuid, text, integer, integer),
  public.finish_game_download(uuid, text, text) from public, anon, authenticated;
grant execute on function public.get_ready_game_release(text, text),
  public.begin_game_download(uuid, uuid, text, integer, integer),
  public.finish_game_download(uuid, text, text) to service_role;
