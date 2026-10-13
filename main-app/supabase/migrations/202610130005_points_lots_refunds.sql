-- Purchase-lot tracking, refund/dispute settlement and the Stripe (sandbox) provider.
-- Additive to the existing ledger: every balance change still goes through
-- public.apply_point_transaction. No existing ledger, order or payment row is
-- changed. Apply to STAGING only, after supabase/points-economy-preflight.sql.
-- Never run Prisma for it.
--
-- Constraint names below are the ones PostgreSQL generated for the earlier
-- migrations. DROP CONSTRAINT deliberately has no IF EXISTS: if a name differs,
-- the whole migration fails and nothing is applied.
begin;

-- 1. New ledger type 'revocation': removes the unused remainder of ONE purchase
--    lot (metadata.lotId) after a provider refund. Never touches other lots.
alter table public.point_transactions drop constraint point_transactions_type_check;
alter table public.point_transactions add constraint point_transactions_type_check
  check (type in ('award', 'spend', 'refund', 'admin_adjustment', 'revocation'));
alter table public.point_transactions drop constraint point_transactions_check;
alter table public.point_transactions add constraint point_transactions_check
  check ((type = 'award' and amount > 0 and reversal_of is null)
    or (type = 'spend' and amount < 0 and reversal_of is null)
    or (type = 'refund' and reversal_of is not null)
    or (type = 'admin_adjustment' and actor_id is not null and reversal_of is null)
    or (type = 'revocation' and amount < 0 and reversal_of is null));

-- Same function as 202609190001, plus the 'revocation' type. Signature,
-- locking, idempotency and balance rules are unchanged.
create or replace function public.apply_point_transaction(
  p_user_id uuid, p_amount bigint, p_type text, p_reason text,
  p_source_type text, p_source_id text, p_idempotency_key text,
  p_metadata jsonb default '{}'::jsonb, p_actor_id uuid default null,
  p_reversal_of uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_account public.point_accounts;
  v_existing public.point_transactions;
  v_original public.point_transactions;
  v_transaction public.point_transactions;
  v_balance numeric;
  v_earned numeric;
  v_spent numeric;
begin
  if p_user_id is null or p_amount is null or p_amount = 0
    or p_amount = '-9223372036854775808'::bigint
    or p_type is null or p_type not in ('award', 'spend', 'refund', 'admin_adjustment', 'revocation')
    or p_reason is null or length(btrim(p_reason)) not between 1 and 200
    or p_source_type is null or length(btrim(p_source_type)) not between 1 and 64
    or p_source_id is null or length(btrim(p_source_id)) not between 1 and 200
    or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 200
    or p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or octet_length(p_metadata::text) > 4096
    or (p_type = 'award' and p_amount < 0) or (p_type = 'spend' and p_amount > 0)
    or (p_type = 'revocation' and p_amount > 0)
    or (p_type = 'admin_adjustment' and p_actor_id is null)
    or ((p_type = 'refund') <> (p_reversal_of is not null)) then
    raise exception using errcode = '22023', message = 'INVALID_POINT_TRANSACTION';
  end if;

  -- Serialize retries across users before inspecting the globally unique key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key, 0));
  select * into v_existing from public.point_transactions where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.user_id is distinct from p_user_id or v_existing.amount is distinct from p_amount
      or v_existing.type is distinct from p_type or v_existing.reason is distinct from btrim(p_reason)
      or v_existing.source_type is distinct from p_source_type or v_existing.source_id is distinct from p_source_id
      or v_existing.metadata is distinct from p_metadata or v_existing.actor_id is distinct from p_actor_id
      or v_existing.reversal_of is distinct from p_reversal_of then
      raise exception using errcode = 'P0001', message = 'POINT_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('id', v_existing.id, 'balanceAfter', v_existing.balance_after::text,
      'amount', v_existing.amount::text, 'duplicate', true);
  end if;

  insert into public.point_accounts(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into strict v_account from public.point_accounts where user_id = p_user_id for update;
  if p_reversal_of is not null then
    select * into v_original from public.point_transactions where id = p_reversal_of;
    if not found or v_original.user_id <> p_user_id or v_original.type = 'refund'
      or p_amount <> -v_original.amount then
      raise exception using errcode = '22023', message = 'INVALID_POINT_REVERSAL';
    end if;
    if exists (select 1 from public.point_transactions where reversal_of = p_reversal_of) then
      raise exception using errcode = 'P0001', message = 'POINT_ALREADY_REVERSED';
    end if;
  end if;

  v_balance := v_account.balance::numeric + p_amount::numeric;
  v_earned := v_account.lifetime_earned::numeric + greatest(p_amount::numeric, 0);
  v_spent := v_account.lifetime_spent::numeric + greatest(-p_amount::numeric, 0);
  if v_balance < 0 then
    raise exception using errcode = 'P0001', message = 'INSUFFICIENT_POINTS';
  end if;
  if greatest(v_balance, v_earned, v_spent) > 9223372036854775807
    or v_account.version = 9223372036854775807 then
    raise exception using errcode = '22003', message = 'POINT_LIMIT_EXCEEDED';
  end if;

  insert into public.point_transactions(user_id, sequence, amount, balance_after, type, reason,
    source_type, source_id, idempotency_key, metadata, actor_id, reversal_of)
  values (p_user_id, v_account.version + 1, p_amount, v_balance::bigint, p_type, btrim(p_reason),
    p_source_type, p_source_id, p_idempotency_key, p_metadata, p_actor_id, p_reversal_of)
  returning * into v_transaction;
  update public.point_accounts set balance = v_balance::bigint, lifetime_earned = v_earned::bigint,
    lifetime_spent = v_spent::bigint, version = v_account.version + 1,
    updated_at = v_transaction.created_at where user_id = p_user_id;
  return jsonb_build_object('id', v_transaction.id, 'balanceAfter', v_transaction.balance_after::text,
    'amount', v_transaction.amount::text, 'duplicate', false);
end;
$$;
revoke all on function public.apply_point_transaction(uuid,bigint,text,text,text,text,text,jsonb,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.apply_point_transaction(uuid,bigint,text,text,text,text,text,jsonb,uuid,uuid)
  to service_role;

-- 2. Purchase lots. Every credit becomes a lot; every debit is allocated to lots.
--    Invariant per account: sum(original - consumed - revoked) = balance.
--    Debit order: promotional lots first, then purchased lots, oldest first (FIFO).
create table public.point_lots (
  transaction_id uuid primary key references public.point_transactions(id) on delete restrict,
  user_id uuid not null references public.point_accounts(user_id) on delete restrict,
  sequence bigint not null check (sequence > 0),
  kind text not null check (kind in ('paid', 'test_paid', 'promotional')),
  source_type text not null check (length(source_type) between 1 and 64),
  source_id text not null check (length(source_id) between 1 and 200),
  original bigint not null check (original > 0),
  consumed bigint not null default 0 check (consumed >= 0),
  revoked bigint not null default 0 check (revoked >= 0),
  created_at timestamptz not null,
  check (consumed + revoked <= original)
);
create index point_lots_open on public.point_lots(user_id, sequence) where original > consumed + revoked;

-- Append-only record of how each debit/credit-back moved points between lots.
create table public.point_lot_allocations (
  id bigint generated always as identity primary key,
  transaction_id uuid not null references public.point_transactions(id) on delete restrict,
  lot_id uuid not null references public.point_lots(transaction_id) on delete restrict,
  user_id uuid not null references public.point_accounts(user_id) on delete restrict,
  kind text not null check (kind in ('consume', 'revoke', 'restore')),
  amount bigint not null check (amount > 0),
  created_at timestamptz not null default clock_timestamp()
);
create index point_lot_allocations_transaction on public.point_lot_allocations(transaction_id);
create index point_lot_allocations_lot on public.point_lot_allocations(lot_id);

alter table public.point_lots enable row level security;
alter table public.point_lot_allocations enable row level security;
revoke all on public.point_lots, public.point_lot_allocations from public, anon, authenticated, service_role;
grant select on public.point_lots, public.point_lot_allocations to service_role;
create trigger point_lot_allocations_immutable before update or delete on public.point_lot_allocations
  for each row execute function public.point_ledger_immutable();

-- Paid = a real provider sale. Test-mode and mock sales are tracked the same
-- way but marked test_paid. Rewards and positive adjustments are promotional.
create function public.point_lot_kind(p_source_type text, p_source_id text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_source_type = 'itch.io' then 'paid'
    when p_source_type in ('lemonsqueezy', 'stripe') and p_source_id like 'live:%' then 'paid'
    when p_source_type in ('lemonsqueezy', 'stripe', 'mock') then 'test_paid'
    else 'promotional' end
$$;

create function public.point_lots_apply(p_tx public.point_transactions, p_backfill boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_need bigint;
  v_take bigint;
  v_restored bigint := 0;
  v_lot public.point_lots;
  v_alloc record;
  v_target uuid;
begin
  if p_tx.amount > 0 then
    if p_tx.type = 'refund' then
      -- Reversal of a debit: give back exactly what that debit took, lot by lot.
      for v_alloc in select lot_id, kind, amount from public.point_lot_allocations
          where transaction_id = p_tx.reversal_of and kind in ('consume', 'revoke') order by id loop
        v_take := least(v_alloc.amount, p_tx.amount - v_restored);
        exit when v_take <= 0;
        if v_alloc.kind = 'consume' then
          update public.point_lots set consumed = consumed - v_take where transaction_id = v_alloc.lot_id;
        else
          update public.point_lots set revoked = revoked - v_take where transaction_id = v_alloc.lot_id;
        end if;
        insert into public.point_lot_allocations(transaction_id, lot_id, user_id, kind, amount)
        values (p_tx.id, v_alloc.lot_id, p_tx.user_id, 'restore', v_take);
        v_restored := v_restored + v_take;
      end loop;
      if v_restored = p_tx.amount then return; end if;
      -- A debit without allocations (cannot happen after the backfill): keep the
      -- invariant by treating the remainder as its own promotional lot.
      insert into public.point_lots(transaction_id, user_id, sequence, kind, source_type, source_id, original, created_at)
      values (p_tx.id, p_tx.user_id, p_tx.sequence, 'promotional', p_tx.source_type, p_tx.source_id,
        p_tx.amount - v_restored, p_tx.created_at);
      return;
    end if;
    insert into public.point_lots(transaction_id, user_id, sequence, kind, source_type, source_id, original, created_at)
    values (p_tx.id, p_tx.user_id, p_tx.sequence, public.point_lot_kind(p_tx.source_type, p_tx.source_id),
      p_tx.source_type, p_tx.source_id, p_tx.amount, p_tx.created_at);
    return;
  end if;

  v_need := -p_tx.amount;
  if p_tx.type in ('refund', 'revocation') then
    -- Reversal/revocation of a credit: only that credit's own unused points.
    -- Taking the shortfall from unrelated purchases is refused (POINT_LOT_CONSUMED).
    begin
      v_target := case when p_tx.type = 'refund' then p_tx.reversal_of else (p_tx.metadata->>'lotId')::uuid end;
    exception when invalid_text_representation then v_target := null;
    end;
    select * into v_lot from public.point_lots where transaction_id = v_target and user_id = p_tx.user_id for update;
    if not found then
      if p_tx.type = 'revocation' then
        raise exception using errcode = 'P0001', message = 'POINT_LOT_NOT_FOUND';
      end if;
    else
      v_take := least(v_need, v_lot.original - v_lot.consumed - v_lot.revoked);
      if v_take < v_need and not p_backfill then
        raise exception using errcode = 'P0001', message = 'POINT_LOT_CONSUMED';
      end if;
      if v_take > 0 then
        update public.point_lots set revoked = revoked + v_take where transaction_id = v_lot.transaction_id;
        insert into public.point_lot_allocations(transaction_id, lot_id, user_id, kind, amount)
        values (p_tx.id, v_lot.transaction_id, p_tx.user_id, 'revoke', v_take);
        v_need := v_need - v_take;
      end if;
      if v_need = 0 then return; end if;
    end if;
  end if;

  for v_lot in select * from public.point_lots where user_id = p_tx.user_id and original > consumed + revoked
      order by case kind when 'promotional' then 0 else 1 end, sequence, transaction_id for update loop
    v_take := least(v_need, v_lot.original - v_lot.consumed - v_lot.revoked);
    update public.point_lots set consumed = consumed + v_take where transaction_id = v_lot.transaction_id;
    insert into public.point_lot_allocations(transaction_id, lot_id, user_id, kind, amount)
    values (p_tx.id, v_lot.transaction_id, p_tx.user_id, 'consume', v_take);
    v_need := v_need - v_take;
    exit when v_need = 0;
  end loop;
  if v_need > 0 then
    raise exception using errcode = 'P0001', message = 'POINT_LOT_INVARIANT';
  end if;
end;
$$;
revoke all on function public.point_lots_apply(public.point_transactions, boolean) from public, anon, authenticated, service_role;

-- Backfill existing history in ledger order, then keep lots current in the same
-- database transaction as every new ledger row.
do $$
declare v_tx public.point_transactions; v_mismatch bigint;
begin
  for v_tx in select * from public.point_transactions order by user_id, sequence loop
    perform public.point_lots_apply(v_tx, true);
  end loop;
  select count(*) into v_mismatch from public.point_accounts a
    where a.balance <> coalesce((select sum(l.original - l.consumed - l.revoked) from public.point_lots l
      where l.user_id = a.user_id), 0);
  if v_mismatch > 0 then
    raise exception 'POINT_LOT_BACKFILL_MISMATCH: % account(s)', v_mismatch;
  end if;
end;
$$;

create function public.point_lots_on_transaction() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.point_lots_apply(new, false);
  return null;
end;
$$;
revoke all on function public.point_lots_on_transaction() from public, anon, authenticated, service_role;
create trigger point_lots_track after insert on public.point_transactions
  for each row execute function public.point_lots_on_transaction();

-- 3. Stripe as a separate provider on the existing order/payment tables.
--    Sandbox only: the database refuses live Stripe credits until a later,
--    explicitly approved migration removes the STRIPE_LIVE_DISABLED guard.
--    Stripe store_id is the constant 'stripe'; variant_id is a Price ID; the
--    provider order ID is the Checkout Session ID.
alter table public.point_checkout_orders drop constraint point_checkout_orders_provider_check;
alter table public.point_checkout_orders add constraint point_checkout_orders_provider_check
  check (provider in ('lemonsqueezy', 'mock', 'stripe'));
alter table public.point_checkout_orders drop constraint point_checkout_orders_store_id_check;
alter table public.point_checkout_orders add constraint point_checkout_orders_store_id_check
  check ((provider <> 'stripe' and store_id ~ '^[1-9][0-9]{0,19}$') or (provider = 'stripe' and store_id = 'stripe'));
alter table public.point_checkout_orders drop constraint point_checkout_orders_variant_id_check;
alter table public.point_checkout_orders add constraint point_checkout_orders_variant_id_check
  check ((provider <> 'stripe' and variant_id ~ '^[1-9][0-9]{0,19}$')
    or (provider = 'stripe' and variant_id ~ '^price_[A-Za-z0-9]{1,100}$'));
alter table public.point_checkout_orders add constraint point_checkout_orders_stripe_test_only
  check (provider <> 'stripe' or environment = 'test');

alter table public.point_provider_payments drop constraint point_provider_payments_provider_check;
alter table public.point_provider_payments add constraint point_provider_payments_provider_check
  check (provider in ('lemonsqueezy', 'mock', 'stripe'));
alter table public.point_provider_payments drop constraint point_provider_payments_provider_order_id_check;
alter table public.point_provider_payments add constraint point_provider_payments_provider_order_id_check
  check (provider_order_id ~ '^[1-9][0-9]{0,19}$' or provider_order_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,200}$');

alter table public.point_provider_refunds drop constraint point_provider_refunds_provider_check;
alter table public.point_provider_refunds add constraint point_provider_refunds_provider_check
  check (provider in ('lemonsqueezy', 'mock', 'stripe'));
alter table public.point_provider_refunds drop constraint point_provider_refunds_provider_order_id_check;
alter table public.point_provider_refunds add constraint point_provider_refunds_provider_order_id_check
  check (provider_order_id ~ '^[1-9][0-9]{0,19}$' or provider_order_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,200}$');

alter table public.point_provider_rejections drop constraint point_provider_rejections_provider_check;
alter table public.point_provider_rejections add constraint point_provider_rejections_provider_check
  check (provider in ('lemonsqueezy', 'mock', 'stripe'));
alter table public.point_provider_rejections drop constraint point_provider_rejections_provider_order_id_check;
alter table public.point_provider_rejections add constraint point_provider_rejections_provider_order_id_check
  check (provider_order_id ~ '^[1-9][0-9]{0,19}$' or provider_order_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,200}$');

-- Stripe refunds and disputes reference the PaymentIntent, not the Checkout
-- Session, so the link is stored when the verified session is credited.
create table public.point_stripe_payment_intents (
  payment_intent_id text primary key check (payment_intent_id ~ '^pi_[A-Za-z0-9]{1,200}$'),
  provider_order_id text not null unique check (provider_order_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,200}$'),
  environment text not null check (environment in ('test', 'live')),
  order_id uuid not null references public.point_checkout_orders(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.point_stripe_payment_intents enable row level security;
revoke all on public.point_stripe_payment_intents from public, anon, authenticated, service_role;
create trigger point_stripe_payment_intents_immutable before update or delete on public.point_stripe_payment_intents
  for each row execute function public.point_ledger_immutable();

-- Same function as 202610110004 with the wider provider/order-ID rules and the
-- Stripe sandbox guard. Crediting logic is unchanged.
create or replace function public.credit_point_checkout_order(p_provider text, p_environment text, p_provider_order_id text,
  p_order_id uuid, p_user_id uuid, p_store_id text, p_variant_id text, p_currency text,
  p_subtotal_minor bigint, p_total_minor bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.point_checkout_orders; v_payment public.point_provider_payments; v_credit jsonb;
  v_key text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  if p_provider_order_id is null or (p_provider_order_id !~ '^[1-9][0-9]{0,19}$'
    and p_provider_order_id !~ '^cs_(test|live)_[A-Za-z0-9]{1,200}$') then raise exception 'INVALID_PURCHASE'; end if;
  if p_provider = 'stripe' and (p_environment <> 'test' or p_provider_order_id !~ '^cs_test_')
    then raise exception 'STRIPE_LIVE_DISABLED'; end if;
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

create function public.link_point_stripe_payment_intent(p_provider_order_id text, p_payment_intent_id text,
  p_environment text, p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_inserted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  insert into public.point_stripe_payment_intents(payment_intent_id, provider_order_id, environment, order_id)
  values (p_payment_intent_id, p_provider_order_id, p_environment, p_order_id)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 and not exists(select 1 from public.point_stripe_payment_intents
      where payment_intent_id = p_payment_intent_id and provider_order_id = p_provider_order_id and order_id = p_order_id)
    then raise exception 'WRONG_ACCOUNT'; end if;
  return jsonb_build_object('duplicate', v_inserted = 0);
end;
$$;

create function public.get_point_stripe_payment_intent(p_payment_intent_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_row public.point_stripe_payment_intents;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_READ_FORBIDDEN'; end if;
  select * into v_row from public.point_stripe_payment_intents where payment_intent_id = p_payment_intent_id;
  if not found then return null; end if;
  return jsonb_build_object('providerOrderId', v_row.provider_order_id, 'environment', v_row.environment,
    'orderId', v_row.order_id);
end;
$$;

-- 4. Refund and dispute settlement, review flags and customer refund requests.
create table public.point_review_flags (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique check (length(dedupe_key) between 1 and 300),
  user_id uuid references auth.users(id) on delete restrict,
  lot_id uuid references public.point_lots(transaction_id) on delete restrict,
  provider text check (provider is null or provider ~ '^[a-z][a-z0-9.]{1,31}$'),
  provider_order_id text check (provider_order_id is null or length(provider_order_id) between 1 and 220),
  reason text not null check (reason ~ '^[A-Z][A-Z_]{1,63}$'),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 4096),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete restrict,
  resolution text check (resolution is null or length(btrim(resolution)) between 1 and 500),
  check ((resolved_at is null) = (resolution is null))
);
create index point_review_flags_open on public.point_review_flags(created_at) where resolved_at is null;

-- One row per distinct provider notification outcome; duplicates find it.
create table public.point_refund_settlements (
  dedupe_key text primary key check (length(dedupe_key) between 1 and 300),
  provider text not null check (provider in ('lemonsqueezy', 'mock', 'stripe')),
  environment text not null check (environment in ('test', 'live')),
  provider_order_id text not null check (length(provider_order_id) between 1 and 220),
  event_kind text not null check (event_kind in ('refund', 'dispute_opened', 'dispute_won', 'dispute_lost')),
  refund_status text check (refund_status in ('refunded', 'partial_refund')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  lot_id uuid references public.point_lots(transaction_id) on delete restrict,
  outcome text not null check (outcome in ('reversed_unused', 'revoked_remaining', 'fully_consumed',
    'already_reversed', 'partial_refund_review', 'no_credit', 'dispute_review', 'dispute_closed_won',
    'review_only')),
  points_removed bigint not null default 0 check (points_removed >= 0),
  transaction_id uuid references public.point_transactions(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);

create table public.point_refund_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  lot_id uuid not null references public.point_lots(transaction_id) on delete restrict,
  evaluation text not null check (evaluation in ('eligible_unused', 'manual_review_partially_consumed',
    'manual_review_fully_consumed')),
  points_original bigint not null check (points_original > 0),
  points_consumed bigint not null check (points_consumed >= 0),
  points_remaining bigint not null check (points_remaining >= 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  resolution text check (resolution is null or length(btrim(resolution)) between 1 and 500),
  check ((status = 'closed') = (closed_at is not null))
);
create unique index point_refund_requests_one_open on public.point_refund_requests(lot_id) where status = 'open';
create index point_refund_requests_owner on public.point_refund_requests(user_id, created_at desc);

alter table public.point_review_flags enable row level security;
alter table public.point_refund_settlements enable row level security;
alter table public.point_refund_requests enable row level security;
revoke all on public.point_review_flags, public.point_refund_settlements, public.point_refund_requests
  from public, anon, authenticated, service_role;
create trigger point_refund_settlements_immutable before update or delete on public.point_refund_settlements
  for each row execute function public.point_ledger_immutable();

create function public.flag_point_review(p_dedupe_key text, p_user_id uuid, p_lot_id uuid, p_provider text,
  p_provider_order_id text, p_reason text, p_details jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.point_review_flags(dedupe_key, user_id, lot_id, provider, provider_order_id, reason, details)
  values (p_dedupe_key, p_user_id, p_lot_id, p_provider, p_provider_order_id, p_reason, coalesce(p_details, '{}'::jsonb))
  on conflict (dedupe_key) do nothing;
end;
$$;
revoke all on function public.flag_point_review(text,uuid,uuid,text,text,text,jsonb) from public, anon, authenticated, service_role;

-- Settles one VERIFIED provider refund or dispute notification. Policy:
--  * full refund / lost dispute, purchase unused       -> full ledger reversal of that purchase
--  * full refund / lost dispute, partly used            -> revoke only that purchase's unused rest + review flag
--  * full refund / lost dispute, fully used             -> no ledger change + review flag
--  * partial refund                                     -> no automatic point change + review flag
--  * dispute opened                                     -> review flag only (outcome still pending)
--  * dispute won                                        -> recorded only
-- Never touches other purchases, never makes a balance negative, never deletes
-- history. Repeated notifications return the first outcome. With p_apply_points
-- false (refund automation switched off) a full refund or lost dispute changes
-- no balance: it is recorded as review_only and flagged for the operator.
create function public.settle_point_provider_refund(p_provider text, p_environment text, p_provider_order_id text,
  p_event_kind text, p_refund_status text, p_amount_minor bigint, p_currency text, p_apply_points boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text; v_existing public.point_refund_settlements; v_payment public.point_provider_payments;
  v_lot public.point_lots; v_remaining bigint; v_outcome text; v_removed bigint := 0; v_tx uuid; v_result jsonb;
  v_full boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  if p_event_kind not in ('refund', 'dispute_opened', 'dispute_won', 'dispute_lost')
    or (p_event_kind = 'refund') <> (p_refund_status is not null)
    or p_amount_minor is null or p_amount_minor < 0 or p_apply_points is null then raise exception 'INVALID_PURCHASE'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_provider || ':order:' || p_environment || ':' || p_provider_order_id, 0));
  v_key := p_provider || ':' || p_environment || ':' || p_provider_order_id || ':' || p_event_kind || ':'
    || coalesce(p_refund_status, '-') || ':' || p_amount_minor::text;
  select * into v_existing from public.point_refund_settlements where dedupe_key = v_key;
  if found then
    return jsonb_build_object('duplicate', true, 'outcome', v_existing.outcome,
      'pointsRemoved', v_existing.points_removed::text, 'transactionId', v_existing.transaction_id);
  end if;

  select * into v_payment from public.point_provider_payments
    where provider = p_provider and provider_order_id = p_provider_order_id and environment = p_environment;
  if not found then
    v_outcome := 'no_credit';
  else
    select * into strict v_lot from public.point_lots where transaction_id = v_payment.transaction_id for update;
    v_full := (p_event_kind = 'refund' and p_refund_status = 'refunded') or p_event_kind = 'dispute_lost';
    if v_full then
      v_remaining := v_lot.original - v_lot.consumed - v_lot.revoked;
      if exists(select 1 from public.point_transactions where reversal_of = v_lot.transaction_id) then
        v_outcome := 'already_reversed';
      elsif not p_apply_points then
        v_outcome := 'review_only';
      elsif v_lot.consumed = 0 and v_lot.revoked = 0 then
        v_result := public.apply_point_transaction(v_payment.user_id, -v_lot.original, 'refund',
          'Refunded points purchase', 'reversal', v_lot.transaction_id::text, 'settle:' || md5(v_key),
          '{}'::jsonb, null, v_lot.transaction_id);
        v_outcome := 'reversed_unused'; v_removed := v_lot.original; v_tx := (v_result->>'id')::uuid;
      elsif v_remaining > 0 then
        v_result := public.apply_point_transaction(v_payment.user_id, -v_remaining, 'revocation',
          'Refunded purchase: unused points removed', 'revocation', 'settle:' || md5(v_key), 'settle:' || md5(v_key),
          jsonb_build_object('lotId', v_lot.transaction_id, 'provider', p_provider, 'providerOrderId', p_provider_order_id,
            'consumed', v_lot.consumed::text), null, null);
        v_outcome := 'revoked_remaining'; v_removed := v_remaining; v_tx := (v_result->>'id')::uuid;
      else
        v_outcome := 'fully_consumed';
      end if;
      if v_outcome in ('revoked_remaining', 'fully_consumed', 'review_only') then
        perform public.flag_point_review('consumed:' || v_key, v_payment.user_id, v_lot.transaction_id, p_provider,
          p_provider_order_id, case
            when v_outcome = 'review_only' and p_event_kind = 'dispute_lost' then 'DISPUTE_LOST_REVIEW'
            when v_outcome = 'review_only' then 'REFUND_REVIEW'
            when p_event_kind = 'dispute_lost' then 'DISPUTE_LOST_AFTER_CONSUMPTION'
            else 'REFUND_AFTER_CONSUMPTION' end,
          jsonb_build_object('consumed', v_lot.consumed::text, 'original', v_lot.original::text,
            'removed', v_removed::text, 'amountMinor', p_amount_minor::text, 'currency', p_currency));
      end if;
    elsif p_event_kind = 'refund' then
      v_outcome := 'partial_refund_review';
      perform public.flag_point_review('partial:' || v_key, v_payment.user_id, v_lot.transaction_id, p_provider,
        p_provider_order_id, 'PARTIAL_REFUND_REVIEW', jsonb_build_object('consumed', v_lot.consumed::text,
          'original', v_lot.original::text, 'refundedMinor', p_amount_minor::text, 'currency', p_currency));
    elsif p_event_kind = 'dispute_opened' then
      v_outcome := 'dispute_review';
      perform public.flag_point_review('dispute:' || v_key, v_payment.user_id, v_lot.transaction_id, p_provider,
        p_provider_order_id, 'DISPUTE_OPENED', jsonb_build_object('consumed', v_lot.consumed::text,
          'original', v_lot.original::text, 'amountMinor', p_amount_minor::text, 'currency', p_currency));
    else
      v_outcome := 'dispute_closed_won';
    end if;
  end if;

  insert into public.point_refund_settlements(dedupe_key, provider, environment, provider_order_id, event_kind,
    refund_status, amount_minor, currency, lot_id, outcome, points_removed, transaction_id)
  values (v_key, p_provider, p_environment, p_provider_order_id, p_event_kind, p_refund_status, p_amount_minor,
    p_currency, v_lot.transaction_id, v_outcome, v_removed, v_tx);
  return jsonb_build_object('duplicate', false, 'outcome', v_outcome, 'pointsRemoved', v_removed::text,
    'transactionId', v_tx);
end;
$$;

create function public.point_lot_json(p_lot public.point_lots)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_request public.point_refund_requests; v_reversed boolean;
begin
  select * into v_request from public.point_refund_requests where lot_id = p_lot.transaction_id
    order by created_at desc limit 1;
  select exists(select 1 from public.point_transactions where reversal_of = p_lot.transaction_id) into v_reversed;
  return jsonb_build_object('transactionId', p_lot.transaction_id, 'kind', p_lot.kind,
    'source', p_lot.source_type, 'original', p_lot.original::text, 'consumed', p_lot.consumed::text,
    'removed', p_lot.revoked::text, 'remaining', (p_lot.original - p_lot.consumed - p_lot.revoked)::text,
    'usage', case when p_lot.consumed = 0 then 'unused' when p_lot.consumed >= p_lot.original - p_lot.revoked
      then 'fully_consumed' else 'partially_consumed' end,
    'refunded', v_reversed or p_lot.revoked > 0, 'createdAt', p_lot.created_at,
    'refundRequest', case when v_request.id is null then null else jsonb_build_object('id', v_request.id,
      'evaluation', v_request.evaluation, 'status', v_request.status, 'createdAt', v_request.created_at) end);
end;
$$;

create function public.list_point_purchase_lots(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null then raise exception 'POINT_READ_FORBIDDEN'; end if;
  return coalesce((select jsonb_agg(public.point_lot_json(l) order by l.sequence desc)
    from public.point_lots l where l.user_id = p_user_id and l.kind in ('paid', 'test_paid')), '[]'::jsonb);
end;
$$;

-- Discretionary refund request for one purchase. Evaluates usage of THAT
-- purchase only; it never moves money and never changes the balance. The
-- provider refund (executed by an operator) is settled by the verified webhook.
create function public.request_point_refund(p_user_id uuid, p_transaction_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lot public.point_lots; v_request public.point_refund_requests; v_evaluation text; v_remaining bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtextextended('refund-request:' || p_user_id::text, 0));
  select * into v_lot from public.point_lots where transaction_id = p_transaction_id and user_id = p_user_id
    and kind in ('paid', 'test_paid');
  if not found then raise exception 'UNKNOWN_PURCHASE'; end if;
  if v_lot.revoked > 0 or exists(select 1 from public.point_transactions where reversal_of = v_lot.transaction_id)
    then raise exception 'ALREADY_REFUNDED'; end if;
  select * into v_request from public.point_refund_requests where lot_id = v_lot.transaction_id and status = 'open';
  if found then
    return jsonb_build_object('duplicate', true, 'request', jsonb_build_object('id', v_request.id,
      'evaluation', v_request.evaluation, 'status', v_request.status, 'createdAt', v_request.created_at),
      'lot', public.point_lot_json(v_lot));
  end if;
  v_remaining := v_lot.original - v_lot.consumed - v_lot.revoked;
  v_evaluation := case when v_lot.consumed = 0 then 'eligible_unused'
    when v_remaining > 0 then 'manual_review_partially_consumed' else 'manual_review_fully_consumed' end;
  insert into public.point_refund_requests(user_id, lot_id, evaluation, points_original, points_consumed, points_remaining)
  values (p_user_id, v_lot.transaction_id, v_evaluation, v_lot.original, v_lot.consumed, v_remaining)
  returning * into v_request;
  return jsonb_build_object('duplicate', false, 'request', jsonb_build_object('id', v_request.id,
    'evaluation', v_request.evaluation, 'status', v_request.status, 'createdAt', v_request.created_at),
    'lot', public.point_lot_json(v_lot));
end;
$$;

create function public.list_point_review_queue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_READ_FORBIDDEN'; end if;
  return jsonb_build_object(
    'flags', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'userId', user_id, 'lotId', lot_id,
      'provider', provider, 'providerOrderId', provider_order_id, 'reason', reason, 'details', details,
      'createdAt', created_at) order by created_at) from public.point_review_flags where resolved_at is null), '[]'::jsonb),
    'refundRequests', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'userId', user_id, 'lotId', lot_id,
      'evaluation', evaluation, 'original', points_original::text, 'consumed', points_consumed::text,
      'remaining', points_remaining::text, 'createdAt', created_at) order by created_at)
      from public.point_refund_requests where status = 'open'), '[]'::jsonb));
end;
$$;

create function public.resolve_point_review(p_kind text, p_id uuid, p_actor_id uuid, p_resolution text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_actor_id is null
    or p_resolution is null or length(btrim(p_resolution)) not between 1 and 500 then raise exception 'INVALID_PURCHASE'; end if;
  if p_kind = 'flag' then
    update public.point_review_flags set resolved_at = clock_timestamp(), resolved_by = p_actor_id,
      resolution = btrim(p_resolution) where id = p_id and resolved_at is null;
  elsif p_kind = 'refund-request' then
    update public.point_refund_requests set status = 'closed', closed_at = clock_timestamp(),
      resolution = btrim(p_resolution) where id = p_id and status = 'open';
  else raise exception 'INVALID_PURCHASE';
  end if;
  get diagnostics v_count = row_count;
  return jsonb_build_object('resolved', v_count = 1);
end;
$$;

revoke all on function public.link_point_stripe_payment_intent(text,text,text,uuid),
  public.get_point_stripe_payment_intent(text),
  public.settle_point_provider_refund(text,text,text,text,text,bigint,text,boolean),
  public.point_lot_json(public.point_lots),
  public.list_point_purchase_lots(uuid),
  public.request_point_refund(uuid,uuid),
  public.list_point_review_queue(),
  public.resolve_point_review(text,uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.link_point_stripe_payment_intent(text,text,text,uuid),
  public.get_point_stripe_payment_intent(text),
  public.settle_point_provider_refund(text,text,text,text,text,bigint,text,boolean),
  public.list_point_purchase_lots(uuid),
  public.request_point_refund(uuid,uuid),
  public.list_point_review_queue(),
  public.resolve_point_review(text,uuid,uuid,text)
  to service_role;
commit;
