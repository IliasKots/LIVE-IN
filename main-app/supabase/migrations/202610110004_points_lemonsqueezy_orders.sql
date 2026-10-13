-- Additive Lemon Squeezy (and development-mock) checkout orders. Reuses the
-- existing ledger: every credit goes through public.apply_point_transaction.
-- No existing wallet, ledger, itch.io intent or receipt row is changed.
-- Apply to STAGING only after the read-only preflight; never run Prisma for it.
begin;

-- Database-level guard. Test-mode and mock payments credit nothing unless the
-- operator of THIS database opts in. Leave false on any production database.
create table public.point_payment_settings (
  id smallint primary key default 1 check (id = 1),
  accept_test_payments boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.point_payment_settings(id) values (1);

create table public.point_checkout_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  provider text not null check (provider in ('lemonsqueezy', 'mock')),
  environment text not null check (environment in ('test', 'live')),
  store_id text not null check (store_id ~ '^[1-9][0-9]{0,19}$'),
  variant_id text not null check (variant_id ~ '^[1-9][0-9]{0,19}$'),
  pack_id text not null check (pack_id ~ '^[a-z0-9][a-z0-9_-]{0,49}$'),
  pack_name text not null check (length(btrim(pack_name)) between 1 and 100),
  points bigint not null check (points > 0),
  price_label text not null check (length(btrim(price_label)) between 1 and 50),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_minor bigint not null check (price_minor > 0),
  checkout_expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (provider <> 'mock' or environment = 'test'),
  check (checkout_expires_at > created_at)
);
create index point_checkout_orders_owner_created on public.point_checkout_orders(user_id, created_at desc);

-- The provider checkout URL is attached once, after the provider API call.
create table public.point_checkout_links (
  order_id uuid primary key references public.point_checkout_orders(id) on delete restrict,
  checkout_id text not null check (length(checkout_id) between 1 and 100),
  url text not null check (url ~ '^https?://' and length(url) <= 2048),
  created_at timestamptz not null default clock_timestamp()
);

-- One row per verified, credited provider order. The provider order ID is the
-- delivery key: duplicate or concurrent webhooks find this row, and the ledger's
-- unique idempotency key/source independently prevent a second award.
create table public.point_provider_payments (
  provider text not null check (provider in ('lemonsqueezy', 'mock')),
  provider_order_id text not null check (provider_order_id ~ '^[1-9][0-9]{0,19}$'),
  environment text not null check (environment in ('test', 'live')),
  order_id uuid not null references public.point_checkout_orders(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  transaction_id uuid not null unique references public.point_transactions(id) on delete restrict,
  points bigint not null check (points > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  credited_at timestamptz not null default clock_timestamp(),
  primary key (provider, provider_order_id)
);
create index point_provider_payments_order on public.point_provider_payments(order_id, credited_at);

-- Verified refund notifications. Recorded for operator action; no automatic
-- reversal policy exists yet (see POINTS_LEMONSQUEEZY_SETUP.md).
create table public.point_provider_refunds (
  provider text not null check (provider in ('lemonsqueezy', 'mock')),
  provider_order_id text not null check (provider_order_id ~ '^[1-9][0-9]{0,19}$'),
  environment text not null check (environment in ('test', 'live')),
  order_id uuid references public.point_checkout_orders(id) on delete restrict,
  refund_status text not null check (refund_status in ('refunded', 'partial_refund')),
  refunded_minor bigint not null check (refunded_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  received_at timestamptz not null default clock_timestamp(),
  primary key (provider, provider_order_id, refund_status, refunded_minor)
);

-- Signed provider events that were deliberately NOT credited (wrong variant,
-- unpaid, environment mismatch, discount, tampered reference...). Audit only.
create table public.point_provider_rejections (
  dedupe_key text primary key check (length(dedupe_key) between 1 and 300),
  provider text not null check (provider in ('lemonsqueezy', 'mock')),
  provider_order_id text check (provider_order_id ~ '^[1-9][0-9]{0,19}$'),
  order_id uuid references public.point_checkout_orders(id) on delete restrict,
  reason text not null check (reason ~ '^[A-Z][A-Z_]{1,63}$'),
  received_at timestamptz not null default clock_timestamp()
);
create index point_provider_rejections_order on public.point_provider_rejections(order_id) where order_id is not null;

alter table public.point_payment_settings enable row level security;
alter table public.point_checkout_orders enable row level security;
alter table public.point_checkout_links enable row level security;
alter table public.point_provider_payments enable row level security;
alter table public.point_provider_refunds enable row level security;
alter table public.point_provider_rejections enable row level security;
revoke all on public.point_payment_settings, public.point_checkout_orders, public.point_checkout_links,
  public.point_provider_payments, public.point_provider_refunds, public.point_provider_rejections
  from public, anon, authenticated, service_role;
-- Service-only. Customers read their orders through the authenticated API, which
-- derives the owner from the verified session.
grant select on public.point_payment_settings to service_role;

create trigger point_checkout_orders_immutable before update or delete on public.point_checkout_orders
  for each row execute function public.point_ledger_immutable();
create trigger point_checkout_links_immutable before update or delete on public.point_checkout_links
  for each row execute function public.point_ledger_immutable();
create trigger point_provider_payments_immutable before update or delete on public.point_provider_payments
  for each row execute function public.point_ledger_immutable();
create trigger point_provider_refunds_immutable before update or delete on public.point_provider_refunds
  for each row execute function public.point_ledger_immutable();
create trigger point_provider_rejections_immutable before update or delete on public.point_provider_rejections
  for each row execute function public.point_ledger_immutable();

create function public.point_checkout_order_json(p_order public.point_checkout_orders)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_payment public.point_provider_payments; v_count bigint; v_refunded boolean; v_refund_reported boolean;
  v_rejected boolean; v_status text;
begin
  select count(*) into v_count from public.point_provider_payments where order_id = p_order.id;
  select * into v_payment from public.point_provider_payments where order_id = p_order.id
    order by credited_at desc, provider_order_id desc limit 1;
  select exists(select 1 from public.point_provider_payments p join public.point_transactions t
    on t.reversal_of = p.transaction_id where p.order_id = p_order.id) into v_refunded;
  select exists(select 1 from public.point_provider_refunds where order_id = p_order.id) into v_refund_reported;
  select exists(select 1 from public.point_provider_rejections where order_id = p_order.id) into v_rejected;
  v_status := case
    when v_count > 0 and v_refunded then 'refunded'
    when v_count > 0 then 'credited'
    when v_refund_reported then 'refunded'
    when v_rejected then 'rejected'
    when not exists(select 1 from public.point_checkout_links where order_id = p_order.id) then 'failed'
    when p_order.checkout_expires_at <= clock_timestamp() then 'expired'
    else 'pending' end;
  return jsonb_build_object('id', p_order.id, 'userId', p_order.user_id, 'provider', p_order.provider,
    'environment', p_order.environment, 'packId', p_order.pack_id, 'name', p_order.pack_name,
    'points', p_order.points::text, 'priceLabel', p_order.price_label, 'currency', p_order.currency,
    'priceMinor', p_order.price_minor::text, 'status', v_status, 'paymentsCredited', v_count::text,
    'refundReported', v_refund_reported, 'transactionId', v_payment.transaction_id,
    'creditedAt', v_payment.credited_at, 'createdAt', p_order.created_at,
    'checkoutExpiresAt', p_order.checkout_expires_at,
    'checkoutUrl', (select url from public.point_checkout_links where order_id = p_order.id));
end;
$$;

-- Serializes checkout creation per account: a repeated click reuses the open,
-- unpaid checkout for the same pack instead of creating another order.
create function public.create_point_checkout_order(p_user_id uuid, p_provider text, p_environment text,
  p_store_id text, p_variant_id text, p_pack_id text, p_pack_name text, p_points bigint,
  p_price_label text, p_currency text, p_price_minor bigint, p_ttl_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.point_checkout_orders;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 600 and 86400 then raise exception 'INVALID_PURCHASE'; end if;
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_user_id::text, 0));
  select o.* into v_order from public.point_checkout_orders o
    where o.user_id = p_user_id and o.provider = p_provider and o.environment = p_environment
      and o.store_id = p_store_id and o.variant_id = p_variant_id and o.pack_id = p_pack_id
      and o.points = p_points and o.price_minor = p_price_minor and o.currency = p_currency
      and o.created_at > clock_timestamp() - interval '30 minutes'
      and o.checkout_expires_at > clock_timestamp() + interval '10 minutes'
      and exists(select 1 from public.point_checkout_links l where l.order_id = o.id)
      and not exists(select 1 from public.point_provider_payments p where p.order_id = o.id)
      and not exists(select 1 from public.point_provider_refunds r where r.order_id = o.id)
      and not exists(select 1 from public.point_provider_rejections j where j.order_id = o.id)
    order by o.created_at desc limit 1;
  if found then return public.point_checkout_order_json(v_order) || jsonb_build_object('reused', true); end if;
  if exists(select 1 from public.point_checkout_orders o where o.user_id = p_user_id
      and o.created_at > clock_timestamp() - interval '20 seconds'
      and not exists(select 1 from public.point_checkout_links l where l.order_id = o.id)) then
    raise exception 'CHECKOUT_IN_PROGRESS';
  end if;
  insert into public.point_checkout_orders(user_id, provider, environment, store_id, variant_id, pack_id,
    pack_name, points, price_label, currency, price_minor, checkout_expires_at)
  values (p_user_id, p_provider, p_environment, p_store_id, p_variant_id, p_pack_id, p_pack_name, p_points,
    p_price_label, p_currency, p_price_minor, clock_timestamp() + make_interval(secs => p_ttl_seconds))
  returning * into v_order;
  return public.point_checkout_order_json(v_order) || jsonb_build_object('reused', false);
end;
$$;

create function public.attach_point_checkout_link(p_user_id uuid, p_order_id uuid, p_checkout_id text, p_url text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.point_checkout_orders;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  select * into v_order from public.point_checkout_orders where id = p_order_id and user_id = p_user_id;
  if not found then raise exception 'UNKNOWN_PURCHASE_INTENT'; end if;
  insert into public.point_checkout_links(order_id, checkout_id, url) values (p_order_id, p_checkout_id, p_url);
  return public.point_checkout_order_json(v_order);
end;
$$;

-- Owner-scoped read. Another account's order ID returns null (indistinguishable
-- from an unknown order). Without an ID, the account's newest order.
create function public.get_point_checkout_order(p_user_id uuid, p_order_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_order public.point_checkout_orders;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_READ_FORBIDDEN'; end if;
  if p_user_id is null then raise exception 'POINT_READ_FORBIDDEN'; end if;
  select * into v_order from public.point_checkout_orders where user_id = p_user_id
    and (p_order_id is null or id = p_order_id) order by created_at desc, id desc limit 1;
  if not found then return null; end if;
  return public.point_checkout_order_json(v_order);
end;
$$;

-- Service-only internal lookup used by verified webhooks and the mock checkout.
create function public.get_point_checkout_order_for_delivery(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_order public.point_checkout_orders;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_READ_FORBIDDEN'; end if;
  select * into v_order from public.point_checkout_orders where id = p_order_id;
  if not found then return null; end if;
  return public.point_checkout_order_json(v_order) || jsonb_build_object('storeId', v_order.store_id,
    'variantId', v_order.variant_id);
end;
$$;

-- The only path that credits a provider order. Call ONLY after the webhook
-- signature and the paid-order payload were verified by the server.
create function public.credit_point_checkout_order(p_provider text, p_environment text, p_provider_order_id text,
  p_order_id uuid, p_user_id uuid, p_store_id text, p_variant_id text, p_currency text,
  p_subtotal_minor bigint, p_total_minor bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.point_checkout_orders; v_payment public.point_provider_payments; v_credit jsonb;
  v_key text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  if p_provider_order_id is null or p_provider_order_id !~ '^[1-9][0-9]{0,19}$' then raise exception 'INVALID_PURCHASE'; end if;
  if p_environment = 'test' and not coalesce((select accept_test_payments from public.point_payment_settings where id = 1), false)
    then raise exception 'TEST_PAYMENTS_DISABLED'; end if;
  v_key := p_provider || ':order:' || p_environment || ':' || p_provider_order_id;
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
  select * into v_order from public.point_checkout_orders where id = p_order_id;
  if not found then raise exception 'UNKNOWN_PURCHASE_INTENT'; end if;
  if v_order.user_id is distinct from p_user_id then raise exception 'WRONG_ACCOUNT'; end if;
  if v_order.provider is distinct from p_provider or v_order.environment is distinct from p_environment
    then raise exception 'ENVIRONMENT_MISMATCH'; end if;
  if v_order.store_id is distinct from p_store_id or v_order.variant_id is distinct from p_variant_id
    then raise exception 'PACK_MISMATCH'; end if;
  if exists(select 1 from public.point_provider_refunds where provider = p_provider
    and provider_order_id = p_provider_order_id) then raise exception 'PURCHASE_REFUNDED'; end if;
  select * into v_payment from public.point_provider_payments where provider = p_provider
    and provider_order_id = p_provider_order_id;
  if found then
    if v_payment.order_id is distinct from p_order_id or v_payment.user_id is distinct from p_user_id
      or v_payment.environment is distinct from p_environment then raise exception 'WRONG_ACCOUNT'; end if;
    return jsonb_build_object('id', v_payment.transaction_id, 'duplicate', true, 'points', v_payment.points::text);
  end if;
  v_credit := public.apply_point_transaction(p_user_id, v_order.points, 'award',
    case when p_provider = 'mock' then 'Mock points purchase (test only)' else 'Points purchase' end,
    p_provider, p_environment || ':' || p_provider_order_id, v_key,
    jsonb_build_object('orderId', v_order.id, 'packId', v_order.pack_id, 'variantId', v_order.variant_id,
      'points', v_order.points::text, 'environment', p_environment), null, null);
  insert into public.point_provider_payments(provider, provider_order_id, environment, order_id, user_id,
    transaction_id, points, currency, subtotal_minor, total_minor)
  values (p_provider, p_provider_order_id, p_environment, v_order.id, p_user_id, (v_credit->>'id')::uuid,
    v_order.points, p_currency, p_subtotal_minor, p_total_minor);
  return v_credit || jsonb_build_object('points', v_order.points::text);
end;
$$;

create function public.record_point_provider_refund(p_provider text, p_environment text, p_provider_order_id text,
  p_order_id uuid, p_refund_status text, p_refunded_minor bigint, p_currency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_payment public.point_provider_payments; v_inserted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_provider || ':order:' || p_environment || ':' || p_provider_order_id, 0));
  select * into v_payment from public.point_provider_payments where provider = p_provider and provider_order_id = p_provider_order_id;
  insert into public.point_provider_refunds(provider, provider_order_id, environment, order_id, refund_status, refunded_minor, currency)
  values (p_provider, p_provider_order_id, p_environment,
    coalesce(v_payment.order_id, (select id from public.point_checkout_orders where id = p_order_id)),
    p_refund_status, p_refunded_minor, p_currency)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object('duplicate', v_inserted = 0, 'creditedTransactionId', v_payment.transaction_id);
end;
$$;

create function public.record_point_provider_rejection(p_provider text, p_provider_order_id text,
  p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_inserted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  insert into public.point_provider_rejections(dedupe_key, provider, provider_order_id, order_id, reason)
  values (p_provider || ':' || coalesce(p_provider_order_id, '-') || ':' || coalesce(p_order_id::text, '-') || ':' || p_reason,
    p_provider, p_provider_order_id, (select id from public.point_checkout_orders where id = p_order_id), p_reason)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object('duplicate', v_inserted = 0);
end;
$$;

-- Operator review list: verified refunds whose credit has not been reversed.
create function public.list_point_provider_refunds_for_review()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_READ_FORBIDDEN'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('provider', r.provider, 'providerOrderId', r.provider_order_id,
    'environment', r.environment, 'orderId', r.order_id, 'refundStatus', r.refund_status,
    'refundedMinor', r.refunded_minor::text, 'currency', r.currency, 'receivedAt', r.received_at,
    'userId', p.user_id, 'transactionId', p.transaction_id, 'points', p.points::text) order by r.received_at)
    from public.point_provider_refunds r
    left join public.point_provider_payments p on p.provider = r.provider and p.provider_order_id = r.provider_order_id
    where p.transaction_id is not null
      and not exists(select 1 from public.point_transactions t where t.reversal_of = p.transaction_id)), '[]'::jsonb);
end;
$$;

revoke all on function public.point_checkout_order_json(public.point_checkout_orders),
  public.create_point_checkout_order(uuid,text,text,text,text,text,text,bigint,text,text,bigint,integer),
  public.attach_point_checkout_link(uuid,uuid,text,text),
  public.get_point_checkout_order(uuid,uuid),
  public.get_point_checkout_order_for_delivery(uuid),
  public.credit_point_checkout_order(text,text,text,uuid,uuid,text,text,text,bigint,bigint),
  public.record_point_provider_refund(text,text,text,uuid,text,bigint,text),
  public.record_point_provider_rejection(text,text,uuid,text),
  public.list_point_provider_refunds_for_review()
  from public, anon, authenticated, service_role;
grant execute on function public.create_point_checkout_order(uuid,text,text,text,text,text,text,bigint,text,text,bigint,integer),
  public.attach_point_checkout_link(uuid,uuid,text,text),
  public.get_point_checkout_order(uuid,uuid),
  public.get_point_checkout_order_for_delivery(uuid),
  public.credit_point_checkout_order(text,text,text,uuid,uuid,text,text,text,bigint,bigint),
  public.record_point_provider_refund(text,text,text,uuid,text,bigint,text),
  public.record_point_provider_rejection(text,text,uuid,text),
  public.list_point_provider_refunds_for_review()
  to service_role;
commit;
