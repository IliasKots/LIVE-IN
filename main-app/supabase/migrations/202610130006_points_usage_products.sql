-- TikTok gift usage billing and in-game Point products. Requires 202610130005.
-- Every debit goes through public.apply_point_transaction (and therefore the
-- purchase-lot allocation). Apply to STAGING only; never run Prisma for it.
--
-- USAGE BILLING IS OFF BY DEFAULT AND CANNOT CHARGE UNTIL ALL OF THESE HOLD:
--  * point_billing_settings.usage_billing_enabled = true
--  * the rate's quantity source is listed in verified_quantity_sources
--  * the game row in point_billable_games has billing_enabled = true
--  * the gift has a row in point_gift_values (an operator-verified Diamond
--    quantity per gift). This table is shipped EMPTY: the game library's
--    gift "DiamondCost" field is a catalogue value reported by the streamer's
--    own client, not a verified creator-Diamond amount, and is never used here.
begin;

create table public.point_billing_settings (
  id smallint primary key default 1 check (id = 1),
  usage_billing_enabled boolean not null default false,
  verified_quantity_sources text[] not null default '{}',
  session_timeout_seconds integer not null default 90 check (session_timeout_seconds between 30 and 900),
  updated_at timestamptz not null default now()
);
insert into public.point_billing_settings(id) values (1);

-- Versioned rates. A price change is a NEW version; old versions never change,
-- so every historical charge stays auditable against the rate it used.
create table public.point_billing_rates (
  version integer primary key check (version > 0),
  quantity_source text not null check (quantity_source ~ '^[a-z][a-z0-9_]{1,63}$'),
  points_per_unit bigint not null check (points_per_unit > 0),
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z_]{1,63}$'),
  description text not null check (length(btrim(description)) between 1 and 200),
  created_at timestamptz not null default clock_timestamp()
);
insert into public.point_billing_rates(version, quantity_source, points_per_unit, reason_code, description)
values (1, 'tiktok_creator_diamonds', 1, 'TIKTOK_DIAMOND_USAGE', '1 TikTok Diamond = 1 PlayLive Point');

create table public.point_billable_games (
  game_id text primary key check (game_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  rate_version integer not null references public.point_billing_rates(version) on delete restrict,
  billing_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Operator-verified quantity per TikTok gift ID, with the evidence used.
create table public.point_gift_values (
  quantity_source text not null check (quantity_source ~ '^[a-z][a-z0-9_]{1,63}$'),
  gift_id bigint not null check (gift_id > 0),
  units_per_gift bigint not null check (units_per_gift > 0),
  evidence text not null check (length(btrim(evidence)) between 10 and 500),
  verified_by uuid references auth.users(id) on delete restrict,
  verified_at timestamptz not null default clock_timestamp(),
  primary key (quantity_source, gift_id)
);

create table public.point_usage_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  game_id text not null references public.point_billable_games(game_id) on delete restrict,
  live_id text not null check (live_id ~ '^[A-Za-z0-9._-]{1,100}$'),
  rate_version integer not null references public.point_billing_rates(version) on delete restrict,
  state text not null check (state in ('active', 'paused', 'stopped', 'expired')),
  started_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  end_reason text check (end_reason in ('stopped', 'timeout')),
  points_charged bigint not null default 0 check (points_charged >= 0),
  units_charged bigint not null default 0 check (units_charged >= 0),
  charges integer not null default 0 check (charges >= 0),
  unique (user_id, request_id),
  check ((state in ('stopped', 'expired')) = (ended_at is not null))
);
create index point_usage_sessions_owner on public.point_usage_sessions(user_id, started_at desc);

-- One immutable row per definitive outcome of a gift report. The key
-- (account, LIVE, gift event, cumulative streak count) is independent of the
-- session, so retries, reconnects, restarts and concurrent sessions of the same
-- streamer can never charge the same gift twice. The highest recorded count of
-- an event is its watermark: only the increment above it can be charged.
create table public.point_usage_events (
  user_id uuid not null references auth.users(id) on delete restrict,
  live_id text not null check (live_id ~ '^[A-Za-z0-9._-]{1,100}$'),
  event_key text not null check (event_key ~ '^[A-Za-z0-9:._|-]{1,200}$'),
  cumulative_count bigint not null check (cumulative_count > 0),
  session_id uuid not null references public.point_usage_sessions(id) on delete restrict,
  game_id text not null,
  gift_id bigint not null check (gift_id > 0),
  outcome text not null check (outcome in ('charged', 'insufficient_points', 'session_not_active',
    'session_expired', 'billing_disabled', 'gift_value_unverified', 'before_session')),
  increment bigint not null check (increment > 0),
  quantity_source text,
  units_per_gift bigint check (units_per_gift > 0),
  units bigint check (units > 0),
  rate_version integer references public.point_billing_rates(version) on delete restrict,
  points bigint check (points > 0),
  transaction_id uuid unique references public.point_transactions(id) on delete restrict,
  occurred_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, live_id, event_key, cumulative_count),
  check ((outcome = 'charged') = (transaction_id is not null)),
  check (outcome <> 'charged' or (units is not null and points is not null and rate_version is not null))
);
create index point_usage_events_session on public.point_usage_events(session_id, created_at);

alter table public.point_billing_settings enable row level security;
alter table public.point_billing_rates enable row level security;
alter table public.point_billable_games enable row level security;
alter table public.point_gift_values enable row level security;
alter table public.point_usage_sessions enable row level security;
alter table public.point_usage_events enable row level security;
revoke all on public.point_billing_settings, public.point_billing_rates, public.point_billable_games,
  public.point_gift_values, public.point_usage_sessions, public.point_usage_events
  from public, anon, authenticated, service_role;
grant select on public.point_billing_settings, public.point_billing_rates, public.point_billable_games,
  public.point_gift_values to service_role;
create trigger point_billing_rates_immutable before update or delete on public.point_billing_rates
  for each row execute function public.point_ledger_immutable();
create trigger point_usage_events_immutable before update or delete on public.point_usage_events
  for each row execute function public.point_ledger_immutable();

create function public.point_usage_billing_ready(p_game_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_settings public.point_billing_settings; v_game public.point_billable_games; v_rate public.point_billing_rates;
begin
  select * into v_settings from public.point_billing_settings where id = 1;
  select * into v_game from public.point_billable_games where game_id = p_game_id;
  if not found then return jsonb_build_object('ready', false, 'reason', 'GAME_NOT_BILLABLE'); end if;
  select * into strict v_rate from public.point_billing_rates where version = v_game.rate_version;
  if not v_game.billing_enabled then return jsonb_build_object('ready', false, 'reason', 'GAME_BILLING_DISABLED'); end if;
  if not coalesce(v_settings.usage_billing_enabled, false) then
    return jsonb_build_object('ready', false, 'reason', 'USAGE_BILLING_DISABLED'); end if;
  if not (v_rate.quantity_source = any(v_settings.verified_quantity_sources)) then
    return jsonb_build_object('ready', false, 'reason', 'QUANTITY_SOURCE_UNVERIFIED'); end if;
  return jsonb_build_object('ready', true, 'rateVersion', v_rate.version, 'quantitySource', v_rate.quantity_source,
    'pointsPerUnit', v_rate.points_per_unit::text, 'reasonCode', v_rate.reason_code,
    'timeoutSeconds', v_settings.session_timeout_seconds);
end;
$$;

create function public.point_usage_session_json(p_session public.point_usage_sessions)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rate public.point_billing_rates; v_timeout integer; v_balance bigint;
begin
  select * into strict v_rate from public.point_billing_rates where version = p_session.rate_version;
  select session_timeout_seconds into v_timeout from public.point_billing_settings where id = 1;
  select balance into v_balance from public.point_accounts where user_id = p_session.user_id;
  return jsonb_build_object('id', p_session.id, 'gameId', p_session.game_id, 'liveId', p_session.live_id,
    'state', p_session.state, 'rateVersion', p_session.rate_version, 'quantitySource', v_rate.quantity_source,
    'pointsPerUnit', v_rate.points_per_unit::text, 'startedAt', p_session.started_at,
    'lastSeenAt', p_session.last_seen_at, 'endedAt', p_session.ended_at, 'endReason', p_session.end_reason,
    'timeoutSeconds', v_timeout, 'pointsCharged', p_session.points_charged::text,
    'unitsCharged', p_session.units_charged::text, 'charges', p_session.charges,
    'balance', coalesce(v_balance, 0)::text);
end;
$$;

-- Marks a silent session expired. Returns the (possibly updated) row.
create function public.point_usage_session_touch(p_session public.point_usage_sessions)
returns public.point_usage_sessions language plpgsql security definer set search_path = '' as $$
declare v_timeout integer; v_row public.point_usage_sessions;
begin
  select session_timeout_seconds into v_timeout from public.point_billing_settings where id = 1;
  if p_session.state in ('active', 'paused')
    and p_session.last_seen_at < clock_timestamp() - make_interval(secs => v_timeout) then
    update public.point_usage_sessions set state = 'expired', ended_at = clock_timestamp(), end_reason = 'timeout'
      where id = p_session.id returning * into v_row;
    return v_row;
  end if;
  return p_session;
end;
$$;

-- Idempotent per request ID. Returns {billingEnabled:false, reason} without
-- creating anything when the game is not (yet) billable: the game then runs free.
create function public.start_point_usage_session(p_user_id uuid, p_request_id uuid, p_game_id text, p_live_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ready jsonb; v_session public.point_usage_sessions; v_stale public.point_usage_sessions;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null or p_request_id is null
    then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  if p_game_id is null or p_game_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    or p_live_id is null or p_live_id !~ '^[A-Za-z0-9._-]{1,100}$' then raise exception 'INVALID_USAGE_REQUEST'; end if;
  perform pg_advisory_xact_lock(hashtextextended('usage-session:' || p_user_id::text, 0));
  select * into v_session from public.point_usage_sessions where user_id = p_user_id and request_id = p_request_id;
  if found then
    if v_session.game_id <> p_game_id or v_session.live_id <> p_live_id then raise exception 'POINT_IDEMPOTENCY_CONFLICT'; end if;
    v_session := public.point_usage_session_touch(v_session);
    return jsonb_build_object('billingEnabled', true, 'duplicate', true, 'session', public.point_usage_session_json(v_session));
  end if;
  v_ready := public.point_usage_billing_ready(p_game_id);
  if not (v_ready->>'ready')::boolean then
    return jsonb_build_object('billingEnabled', false, 'reason', v_ready->>'reason');
  end if;
  for v_stale in select * from public.point_usage_sessions where user_id = p_user_id and state in ('active', 'paused') loop
    perform public.point_usage_session_touch(v_stale);
  end loop;
  insert into public.point_usage_sessions(user_id, request_id, game_id, live_id, rate_version, state)
  values (p_user_id, p_request_id, p_game_id, p_live_id, (v_ready->>'rateVersion')::integer, 'active')
  returning * into v_session;
  return jsonb_build_object('billingEnabled', true, 'duplicate', false, 'session', public.point_usage_session_json(v_session));
end;
$$;

-- heartbeat | pause | resume | stop. Stopped and expired sessions are final:
-- the client starts a new session (gift de-duplication spans sessions).
create function public.update_point_usage_session(p_user_id uuid, p_session_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.point_usage_sessions;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  if p_action not in ('heartbeat', 'pause', 'resume', 'stop') then raise exception 'INVALID_USAGE_REQUEST'; end if;
  select * into v_session from public.point_usage_sessions where id = p_session_id and user_id = p_user_id for update;
  if not found then raise exception 'UNKNOWN_USAGE_SESSION'; end if;
  v_session := public.point_usage_session_touch(v_session);
  if v_session.state in ('active', 'paused') then
    update public.point_usage_sessions set
      state = case p_action when 'pause' then 'paused' when 'resume' then 'active' when 'stop' then 'stopped' else state end,
      last_seen_at = clock_timestamp(),
      ended_at = case when p_action = 'stop' then clock_timestamp() else null end,
      end_reason = case when p_action = 'stop' then 'stopped' else null end
      where id = v_session.id returning * into v_session;
  end if;
  return jsonb_build_object('session', public.point_usage_session_json(v_session));
end;
$$;

-- Charges a batch (1..50) of gift reports for ONE session. Each report is
-- {eventKey, giftId, cumulativeCount, occurredAt?}. The client never supplies a
-- Point amount or Diamond quantity: the server prices the gift ID from
-- point_gift_values and the session's rate version. Every report gets its own
-- outcome; one report's failure never undoes another report's charge.
create function public.charge_point_usage(p_user_id uuid, p_session_id uuid, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.point_usage_sessions; v_ready jsonb; v_rate public.point_billing_rates;
  v_event jsonb; v_key text; v_gift bigint; v_count bigint; v_occurred timestamptz; v_existing public.point_usage_events;
  v_watermark bigint; v_increment bigint; v_outcome text; v_value public.point_gift_values; v_units numeric;
  v_points numeric; v_hash text; v_credit jsonb; v_tx uuid; v_results jsonb := '[]'::jsonb; v_balance text;
  v_charged_session uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) not between 1 and 50
    then raise exception 'INVALID_USAGE_REQUEST'; end if;
  select * into v_session from public.point_usage_sessions where id = p_session_id and user_id = p_user_id for update;
  if not found then raise exception 'UNKNOWN_USAGE_SESSION'; end if;
  v_session := public.point_usage_session_touch(v_session);
  -- One streamer's charges are serialized: the account row is the single lock
  -- order for every report, so concurrent sessions cannot deadlock or overspend.
  perform 1 from public.point_accounts where user_id = p_user_id for update;
  v_ready := public.point_usage_billing_ready(v_session.game_id);
  select * into strict v_rate from public.point_billing_rates where version = v_session.rate_version;

  for v_event in select value from jsonb_array_elements(p_events) loop
    v_key := v_event->>'eventKey';
    if jsonb_typeof(v_event) <> 'object' or v_key is null or v_key !~ '^[A-Za-z0-9:._|-]{1,200}$'
      or coalesce(v_event->>'giftId', '') !~ '^[1-9][0-9]{0,17}$'
      or coalesce(v_event->>'cumulativeCount', '') !~ '^[1-9][0-9]{0,8}$' then
      v_results := v_results || jsonb_build_array(jsonb_build_object('eventKey', left(coalesce(v_key, ''), 200),
        'status', 'invalid'));
      continue;
    end if;
    v_gift := (v_event->>'giftId')::bigint;
    v_count := (v_event->>'cumulativeCount')::bigint;
    v_occurred := null;
    if v_event ? 'occurredAt' and jsonb_typeof(v_event->'occurredAt') = 'string' then
      begin v_occurred := (v_event->>'occurredAt')::timestamptz;
      exception when others then v_occurred := null; end;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('usage:' || p_user_id::text || ':' || v_session.live_id || ':' || v_key, 0));

    select * into v_existing from public.point_usage_events where user_id = p_user_id
      and live_id = v_session.live_id and event_key = v_key and cumulative_count = v_count;
    if found then
      v_results := v_results || jsonb_build_array(jsonb_build_object('eventKey', v_key, 'cumulativeCount', v_count::text,
        'status', 'duplicate', 'originalStatus', v_existing.outcome, 'charged', v_existing.outcome = 'charged',
        'chargedInThisSession', v_existing.outcome = 'charged' and v_existing.session_id = v_session.id,
        'points', coalesce(v_existing.points, 0)::text, 'transactionId', v_existing.transaction_id));
      continue;
    end if;
    select max(cumulative_count) into v_watermark from public.point_usage_events where user_id = p_user_id
      and live_id = v_session.live_id and event_key = v_key;
    if v_watermark is not null and v_count < v_watermark then
      v_results := v_results || jsonb_build_array(jsonb_build_object('eventKey', v_key, 'cumulativeCount', v_count::text,
        'status', 'superseded', 'charged', false));
      continue;
    end if;
    v_increment := v_count - coalesce(v_watermark, 0);
    v_value := null; v_units := null; v_points := null; v_tx := null; v_credit := null;

    if v_session.state = 'expired' then v_outcome := 'session_expired';
    elsif v_session.state <> 'active' then v_outcome := 'session_not_active';
    elsif not (v_ready->>'ready')::boolean then v_outcome := 'billing_disabled';
    elsif v_occurred is not null and (v_occurred < v_session.started_at - interval '10 seconds'
      or v_occurred > clock_timestamp() + interval '60 seconds') then v_outcome := 'before_session';
    else
      select * into v_value from public.point_gift_values where quantity_source = v_rate.quantity_source and gift_id = v_gift;
      if not found then v_outcome := 'gift_value_unverified';
      else
        v_units := v_increment::numeric * v_value.units_per_gift::numeric;
        v_points := v_units * v_rate.points_per_unit::numeric;
        if v_points > 9223372036854775807 then raise exception 'POINT_LIMIT_EXCEEDED'; end if;
        v_hash := encode(sha256(convert_to(p_user_id::text || '|' || v_session.live_id || '|' || v_key || '|'
          || v_count::text, 'UTF8')), 'hex');
        begin
          v_credit := public.apply_point_transaction(p_user_id, -(v_points::bigint), 'spend', 'TikTok gift usage',
            'tiktok_diamond_usage', 'evt:' || v_hash, 'usage:' || v_hash,
            jsonb_build_object('reasonCode', v_rate.reason_code, 'gameId', v_session.game_id,
              'sessionId', v_session.id, 'liveId', v_session.live_id, 'eventKey', v_key, 'giftId', v_gift::text,
              'cumulativeCount', v_count::text, 'increment', v_increment::text,
              'quantitySource', v_rate.quantity_source, 'unitsPerGift', v_value.units_per_gift::text,
              'units', v_units::text, 'rateVersion', v_rate.version, 'pointsPerUnit', v_rate.points_per_unit::text),
            null, null);
          v_outcome := 'charged'; v_tx := (v_credit->>'id')::uuid;
        exception when others then
          if sqlerrm = 'INSUFFICIENT_POINTS' then v_outcome := 'insufficient_points'; else raise; end if;
        end;
      end if;
    end if;

    insert into public.point_usage_events(user_id, live_id, event_key, cumulative_count, session_id, game_id, gift_id,
      outcome, increment, quantity_source, units_per_gift, units, rate_version, points, transaction_id, occurred_at)
    values (p_user_id, v_session.live_id, v_key, v_count, v_session.id, v_session.game_id, v_gift, v_outcome, v_increment,
      case when v_value.gift_id is null then null else v_rate.quantity_source end, v_value.units_per_gift,
      case when v_outcome = 'charged' then v_units::bigint end, case when v_outcome = 'charged' then v_rate.version end,
      case when v_outcome = 'charged' then v_points::bigint end, v_tx, v_occurred);
    if v_outcome = 'charged' then
      update public.point_usage_sessions set points_charged = points_charged + v_points::bigint,
        units_charged = units_charged + v_units::bigint, charges = charges + 1
        where id = v_session.id returning * into v_session;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object('eventKey', v_key, 'cumulativeCount', v_count::text,
      'status', v_outcome, 'charged', v_outcome = 'charged', 'chargedInThisSession', v_outcome = 'charged',
      'increment', v_increment::text, 'units', coalesce(v_units, 0)::bigint::text,
      'points', coalesce(v_points, 0)::bigint::text, 'transactionId', v_tx,
      'balanceAfter', v_credit->>'balanceAfter'));
  end loop;
  select balance::text into v_balance from public.point_accounts where user_id = p_user_id;
  return jsonb_build_object('session', public.point_usage_session_json(v_session), 'results', v_results,
    'balance', coalesce(v_balance, '0'));
end;
$$;

create function public.get_point_usage_session(p_user_id uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.point_usage_sessions;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null then raise exception 'POINT_READ_FORBIDDEN'; end if;
  select * into v_session from public.point_usage_sessions where id = p_session_id and user_id = p_user_id for update;
  if not found then return null; end if;
  v_session := public.point_usage_session_touch(v_session);
  return public.point_usage_session_json(v_session);
end;
$$;

-- In-game Point products. Prices are server configuration in this table;
-- no production product or price is seeded. Purchases snapshot the price.
create table public.point_products (
  product_id text primary key check (product_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  game_id text check (game_id is null or game_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  product_type text not null check (product_type in ('overlay', 'game_upgrade', 'premium_feature', 'content', 'digital_product')),
  name text not null check (length(btrim(name)) between 1 and 100),
  price_points bigint not null check (price_points > 0),
  purchase_mode text not null check (purchase_mode in ('one_time', 'consumable', 'timed')),
  duration_seconds integer check (duration_seconds between 60 and 31536000),
  units_per_purchase integer not null default 1 check (units_per_purchase between 1 and 1000000),
  fulfillment text not null check (fulfillment ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  active boolean not null default false,
  price_version integer not null default 1 check (price_version > 0),
  updated_at timestamptz not null default now(),
  check ((purchase_mode = 'timed') = (duration_seconds is not null))
);

-- A price change must come with a new price version.
create function public.point_products_price_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.price_points <> old.price_points and new.price_version <= old.price_version then
    raise exception using errcode = 'P0001', message = 'POINT_PRICE_VERSION_REQUIRED';
  end if;
  if new.product_id <> old.product_id or new.purchase_mode <> old.purchase_mode then
    raise exception using errcode = 'P0001', message = 'POINT_PRODUCT_IMMUTABLE_FIELDS';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger point_products_price_version before update on public.point_products
  for each row execute function public.point_products_price_version();
create trigger point_products_no_delete before delete on public.point_products
  for each row execute function public.point_ledger_immutable();

create table public.point_product_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  product_id text not null references public.point_products(product_id) on delete restrict,
  game_id text,
  purchase_mode text not null,
  price_points bigint not null check (price_points > 0),
  price_version integer not null,
  units bigint not null check (units > 0),
  expires_at timestamptz,
  transaction_id uuid not null unique references public.point_transactions(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, request_id)
);

create table public.point_entitlements (
  user_id uuid not null references auth.users(id) on delete restrict,
  product_id text not null references public.point_products(product_id) on delete restrict,
  game_id text,
  purchase_mode text not null,
  fulfillment text not null,
  units bigint not null default 0 check (units >= 0),
  expires_at timestamptz,
  first_granted_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, product_id)
);

alter table public.point_products enable row level security;
alter table public.point_product_purchases enable row level security;
alter table public.point_entitlements enable row level security;
revoke all on public.point_products, public.point_product_purchases, public.point_entitlements
  from public, anon, authenticated, service_role;
grant select on public.point_products to service_role;
create trigger point_product_purchases_immutable before update or delete on public.point_product_purchases
  for each row execute function public.point_ledger_immutable();

create function public.point_entitlement_json(p_row public.point_entitlements)
returns jsonb language sql stable set search_path = '' as $$
  select case when p_row.product_id is null then null else jsonb_build_object('productId', p_row.product_id,
    'gameId', p_row.game_id, 'mode', p_row.purchase_mode, 'fulfillment', p_row.fulfillment,
    'units', p_row.units::text, 'expiresAt', p_row.expires_at,
    'active', p_row.purchase_mode <> 'timed' or p_row.expires_at > clock_timestamp()) end
$$;

create function public.list_point_products(p_game_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_READ_FORBIDDEN'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('productId', product_id, 'gameId', game_id,
    'type', product_type, 'name', name, 'price', price_points::text, 'priceVersion', price_version,
    'mode', purchase_mode, 'durationSeconds', duration_seconds, 'units', units_per_purchase) order by product_id)
    from public.point_products where active and (game_id is null or game_id = p_game_id)), '[]'::jsonb);
end;
$$;

create function public.list_point_entitlements(p_user_id uuid, p_game_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null then raise exception 'POINT_READ_FORBIDDEN'; end if;
  return coalesce((select jsonb_agg(public.point_entitlement_json(e) order by e.product_id)
    from public.point_entitlements e where e.user_id = p_user_id
      and (p_game_id is null or e.game_id is null or e.game_id = p_game_id)), '[]'::jsonb);
end;
$$;

-- Charges the server price once per request ID and grants the item in the same
-- database transaction. Insufficient Points abort everything: no entitlement.
create function public.purchase_point_product(p_user_id uuid, p_request_id uuid, p_product_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_product public.point_products; v_purchase public.point_product_purchases; v_entitlement public.point_entitlements;
  v_credit jsonb; v_id uuid := gen_random_uuid(); v_expires timestamptz; v_balance bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null or p_request_id is null
    then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtextextended('product-purchase:' || p_user_id::text, 0));
  select * into v_purchase from public.point_product_purchases where user_id = p_user_id and request_id = p_request_id;
  if found then
    if v_purchase.product_id is distinct from p_product_id then raise exception 'POINT_IDEMPOTENCY_CONFLICT'; end if;
    select * into v_entitlement from public.point_entitlements where user_id = p_user_id and product_id = p_product_id;
    select balance into v_balance from public.point_accounts where user_id = p_user_id;
    return jsonb_build_object('status', 'granted', 'duplicate', true, 'purchaseId', v_purchase.id,
      'transactionId', v_purchase.transaction_id, 'price', v_purchase.price_points::text,
      'entitlement', public.point_entitlement_json(v_entitlement), 'balance', coalesce(v_balance, 0)::text);
  end if;
  select * into v_product from public.point_products where product_id = p_product_id and active;
  if not found then raise exception 'PRODUCT_UNAVAILABLE'; end if;
  select * into v_entitlement from public.point_entitlements where user_id = p_user_id and product_id = p_product_id for update;
  if found and v_product.purchase_mode = 'one_time' then
    select balance into v_balance from public.point_accounts where user_id = p_user_id;
    return jsonb_build_object('status', 'already_owned', 'duplicate', false,
      'entitlement', public.point_entitlement_json(v_entitlement), 'balance', coalesce(v_balance, 0)::text);
  end if;
  v_credit := public.apply_point_transaction(p_user_id, -v_product.price_points, 'spend', 'Purchase: ' || v_product.name,
    'product_purchase', v_id::text, 'product:' || p_user_id::text || ':' || p_request_id::text,
    jsonb_build_object('productId', v_product.product_id, 'gameId', v_product.game_id, 'type', v_product.product_type,
      'mode', v_product.purchase_mode, 'priceVersion', v_product.price_version), null, null);
  if v_product.purchase_mode = 'timed' then
    v_expires := greatest(coalesce(v_entitlement.expires_at, clock_timestamp()), clock_timestamp())
      + make_interval(secs => v_product.duration_seconds);
  end if;
  insert into public.point_product_purchases(id, user_id, request_id, product_id, game_id, purchase_mode, price_points,
    price_version, units, expires_at, transaction_id)
  values (v_id, p_user_id, p_request_id, v_product.product_id, v_product.game_id, v_product.purchase_mode,
    v_product.price_points, v_product.price_version, v_product.units_per_purchase, v_expires, (v_credit->>'id')::uuid);
  insert into public.point_entitlements(user_id, product_id, game_id, purchase_mode, fulfillment, units, expires_at)
  values (p_user_id, v_product.product_id, v_product.game_id, v_product.purchase_mode, v_product.fulfillment,
    v_product.units_per_purchase, v_expires)
  on conflict (user_id, product_id) do update set units = public.point_entitlements.units + excluded.units,
    expires_at = excluded.expires_at, updated_at = clock_timestamp()
  returning * into v_entitlement;
  return jsonb_build_object('status', 'granted', 'duplicate', false, 'purchaseId', v_id,
    'transactionId', v_credit->>'id', 'price', v_product.price_points::text,
    'entitlement', public.point_entitlement_json(v_entitlement), 'balance', v_credit->>'balanceAfter');
end;
$$;

revoke all on function public.point_usage_billing_ready(text), public.point_usage_session_json(public.point_usage_sessions),
  public.point_usage_session_touch(public.point_usage_sessions),
  public.start_point_usage_session(uuid,uuid,text,text), public.update_point_usage_session(uuid,uuid,text),
  public.charge_point_usage(uuid,uuid,jsonb), public.get_point_usage_session(uuid,uuid),
  public.point_entitlement_json(public.point_entitlements), public.list_point_products(text),
  public.list_point_entitlements(uuid,text), public.purchase_point_product(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.start_point_usage_session(uuid,uuid,text,text),
  public.update_point_usage_session(uuid,uuid,text), public.charge_point_usage(uuid,uuid,jsonb),
  public.get_point_usage_session(uuid,uuid), public.list_point_products(text),
  public.list_point_entitlements(uuid,text), public.purchase_point_product(uuid,uuid,text)
  to service_role;
commit;
