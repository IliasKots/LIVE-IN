-- Apply to the STAGING Supabase project first. Never run Prisma migrations for
-- these tables: the identity is auth.users.id, not the legacy Prisma User.id.
begin;

create table public.point_accounts (
  user_id uuid primary key references auth.users(id) on delete restrict,
  balance bigint not null default 0 check (balance >= 0),
  lifetime_earned bigint not null default 0 check (lifetime_earned >= 0),
  lifetime_spent bigint not null default 0 check (lifetime_spent >= 0),
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now(),
  constraint point_account_reconciles check (balance = lifetime_earned - lifetime_spent)
);

create table public.point_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.point_accounts(user_id) on delete restrict,
  sequence bigint not null check (sequence > 0),
  amount bigint not null check (amount <> 0 and amount <> '-9223372036854775808'::bigint),
  balance_after bigint not null check (balance_after >= 0),
  type text not null check (type in ('award', 'spend', 'refund', 'admin_adjustment')),
  reason text not null check (length(btrim(reason)) between 1 and 200),
  source_type text not null check (length(source_type) between 1 and 64),
  source_id text not null check (length(source_id) between 1 and 200),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 200),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4096),
  actor_id uuid references auth.users(id) on delete restrict,
  reversal_of uuid unique references public.point_transactions(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, sequence),
  unique (source_type, source_id),
  check ((type = 'award' and amount > 0 and reversal_of is null)
    or (type = 'spend' and amount < 0 and reversal_of is null)
    or (type = 'refund' and reversal_of is not null)
    or (type = 'admin_adjustment' and actor_id is not null and reversal_of is null))
);

alter table public.point_accounts enable row level security;
alter table public.point_transactions enable row level security;
revoke all on public.point_accounts, public.point_transactions from public, anon, authenticated, service_role;
grant select on public.point_accounts to authenticated, service_role;
-- Internal metadata, actor identities, source IDs and idempotency keys are never
-- exposed to customer database clients, even when they bypass the website UI.
grant select (id, user_id, sequence, amount, balance_after, type, reason, created_at)
  on public.point_transactions to authenticated;
grant select on public.point_transactions to service_role;
create policy point_accounts_read_own on public.point_accounts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy point_transactions_read_own on public.point_transactions for select to authenticated
  using ((select auth.uid()) = user_id);

create function public.point_ledger_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'POINT_LEDGER_IMMUTABLE';
end;
$$;
revoke all on function public.point_ledger_immutable() from public, anon, authenticated, service_role;
create trigger point_ledger_immutable before update or delete on public.point_transactions
  for each row execute function public.point_ledger_immutable();

create function public.apply_point_transaction(
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
    or p_type is null or p_type not in ('award', 'spend', 'refund', 'admin_adjustment')
    or p_reason is null or length(btrim(p_reason)) not between 1 and 200
    or p_source_type is null or length(btrim(p_source_type)) not between 1 and 64
    or p_source_id is null or length(btrim(p_source_id)) not between 1 and 200
    or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 200
    or p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or octet_length(p_metadata::text) > 4096
    or (p_type = 'award' and p_amount < 0) or (p_type = 'spend' and p_amount > 0)
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

-- SECURITY INVOKER preserves RLS for browser sessions. Launcher routes call with
-- the service role and supply ONLY the user ID derived from a validated session.
create function public.get_point_account(p_user_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  if p_user_id is null or (current_user <> 'service_role' and
    coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from p_user_id) then
    raise exception using errcode = '42501', message = 'POINT_ACCESS_DENIED';
  end if;
  select jsonb_build_object('balance', balance::text, 'lifetimeEarned', lifetime_earned::text,
    'lifetimeSpent', lifetime_spent::text, 'version', version::text, 'updatedAt', updated_at)
  into v_result from public.point_accounts where user_id = p_user_id;
  return coalesce(v_result, jsonb_build_object('balance', '0', 'lifetimeEarned', '0',
    'lifetimeSpent', '0', 'version', '0', 'updatedAt', null));
end;
$$;
revoke all on function public.get_point_account(uuid) from public, anon;
grant execute on function public.get_point_account(uuid) to authenticated, service_role;

create function public.list_point_transactions(p_user_id uuid, p_limit integer default 20, p_before bigint default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_items jsonb; v_next text;
begin
  if p_user_id is null or (current_user <> 'service_role' and
    coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from p_user_id) then
    raise exception using errcode = '42501', message = 'POINT_ACCESS_DENIED';
  end if;
  if p_limit is null or p_limit not between 1 and 100 or p_before <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_POINT_PAGE';
  end if;
  with candidates as (
    select id, sequence, amount, balance_after, type, reason, created_at
    from public.point_transactions where user_id = p_user_id and (p_before is null or sequence < p_before)
    order by sequence desc limit p_limit + 1
  ), page as (select * from candidates order by sequence desc limit p_limit)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'amount', amount::text,
    'balanceAfter', balance_after::text, 'type', type, 'description', reason, 'createdAt', created_at)
    order by sequence desc), '[]'::jsonb),
    case when (select count(*) from candidates) > p_limit then min(sequence)::text else null end
  into v_items, v_next from page;
  return jsonb_build_object('items', v_items, 'nextCursor', v_next);
end;
$$;
revoke all on function public.list_point_transactions(uuid,integer,bigint) from public, anon;
grant execute on function public.list_point_transactions(uuid,integer,bigint) to authenticated, service_role;

create function public.reverse_point_transaction(p_original_id uuid, p_reason text, p_idempotency_key text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_original public.point_transactions;
begin
  select * into v_original from public.point_transactions where id = p_original_id;
  if not found or v_original.type = 'refund' or p_actor_id is null then
    raise exception using errcode = '22023', message = 'INVALID_POINT_REVERSAL';
  end if;
  return public.apply_point_transaction(v_original.user_id, -v_original.amount, 'refund', p_reason,
    'reversal', p_original_id::text, p_idempotency_key, '{}'::jsonb, p_actor_id, p_original_id);
end;
$$;
revoke all on function public.reverse_point_transaction(uuid,text,text,uuid) from public, anon, authenticated;
grant execute on function public.reverse_point_transaction(uuid,text,text,uuid) to service_role;

commit;
