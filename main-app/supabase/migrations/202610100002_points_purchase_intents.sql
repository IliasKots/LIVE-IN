-- Additive purchase tracking. Apply only after read-only preflight/reconciliation.
-- Does not replace or update any existing wallet or ledger entry.
begin;
create table public.point_purchase_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  pack_id text not null check (pack_id ~ '^[a-z0-9][a-z0-9_-]{0,49}$'),
  pack_name text not null check (length(btrim(pack_name)) between 1 and 100),
  points bigint not null check (points > 0),
  project_url text not null,
  sub_product_id text not null check (sub_product_id ~ '^[1-9][0-9]{0,19}$'),
  price_label text not null check (length(btrim(price_label)) between 1 and 50),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_minor bigint not null check (price_minor > 0),
  created_at timestamptz not null default clock_timestamp()
);
create table public.point_purchase_receipts (
  provider_purchase_id text primary key check (provider_purchase_id ~ '^[1-9][0-9]{0,19}$'),
  intent_id uuid not null references public.point_purchase_intents(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  transaction_id uuid not null unique references public.point_transactions(id) on delete restrict,
  credited_at timestamptz not null default clock_timestamp()
);
create index point_purchase_intents_owner_created on public.point_purchase_intents(user_id, created_at desc);
create index point_purchase_receipts_intent on public.point_purchase_receipts(intent_id, credited_at desc);
alter table public.point_purchase_intents enable row level security;
alter table public.point_purchase_receipts enable row level security;
revoke all on public.point_purchase_intents, public.point_purchase_receipts from public, anon, authenticated, service_role;
grant select on public.point_purchase_intents, public.point_purchase_receipts to authenticated, service_role;
create policy point_purchase_intents_read_own on public.point_purchase_intents for select to authenticated
  using ((select auth.uid()) = user_id);
create policy point_purchase_receipts_read_own on public.point_purchase_receipts for select to authenticated
  using ((select auth.uid()) = user_id);
create trigger point_purchase_intents_immutable before update or delete on public.point_purchase_intents
  for each row execute function public.point_ledger_immutable();
create trigger point_purchase_receipts_immutable before update or delete on public.point_purchase_receipts
  for each row execute function public.point_ledger_immutable();

create function public.create_point_purchase_intent(p_user_id uuid, p_pack_id text, p_pack_name text,
  p_points bigint, p_project_url text, p_sub_product_id text, p_price_label text, p_currency text, p_price_minor bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.point_purchase_intents;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  insert into public.point_purchase_intents(user_id, pack_id, pack_name, points, project_url,
    sub_product_id, price_label, currency, price_minor)
  values(p_user_id, p_pack_id, p_pack_name, p_points, p_project_url, p_sub_product_id, p_price_label, p_currency, p_price_minor)
  returning * into v_intent;
  return jsonb_build_object('id', v_intent.id);
end;
$$;

create function public.get_point_purchase(p_user_id uuid, p_intent_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.point_purchase_intents; v_receipt public.point_purchase_receipts; v_refunded boolean;
begin
  if p_user_id is null or (coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from p_user_id)
    then raise exception 'POINT_READ_FORBIDDEN'; end if;
  select * into v_intent from public.point_purchase_intents where user_id = p_user_id
    and (p_intent_id is null or id = p_intent_id) order by created_at desc, id desc limit 1;
  if not found then return null; end if;
  select * into v_receipt from public.point_purchase_receipts where intent_id = v_intent.id
    order by credited_at desc, provider_purchase_id desc limit 1;
  select exists(select 1 from public.point_transactions where reversal_of = v_receipt.transaction_id) into v_refunded;
  return jsonb_build_object('id', v_intent.id, 'userId', v_intent.user_id, 'packId', v_intent.pack_id,
    'name', v_intent.pack_name, 'points', v_intent.points::text, 'projectUrl', v_intent.project_url,
    'subProductId', v_intent.sub_product_id, 'priceLabel', v_intent.price_label, 'currency', v_intent.currency,
    'priceMinor', v_intent.price_minor::text, 'createdAt', v_intent.created_at,
    'status', case when v_refunded then 'refunded' when v_receipt.transaction_id is not null then 'credited' else 'pending' end,
    'purchaseId', v_receipt.provider_purchase_id, 'transactionId', v_receipt.transaction_id, 'creditedAt', v_receipt.credited_at);
end;
$$;

create function public.credit_point_purchase(p_user_id uuid, p_intent_id uuid, p_purchase_id text,
  p_project_url text, p_sub_product_id text, p_pack_id text, p_points bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.point_purchase_intents; v_receipt public.point_purchase_receipts; v_credit jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  if p_purchase_id is null or p_purchase_id !~ '^[1-9][0-9]{0,19}$' then raise exception 'INVALID_PURCHASE'; end if;
  -- Serialize a provider purchase even when claims arrive through different intents/accounts.
  perform pg_advisory_xact_lock(hashtextextended('itch.io:purchase:' || p_purchase_id, 0));
  select * into v_intent from public.point_purchase_intents where id = p_intent_id;
  if not found then raise exception 'UNKNOWN_PURCHASE_INTENT'; end if;
  if v_intent.user_id is distinct from p_user_id then raise exception 'WRONG_ACCOUNT'; end if;
  if v_intent.project_url is distinct from p_project_url or v_intent.sub_product_id is distinct from p_sub_product_id
    or v_intent.pack_id is distinct from p_pack_id or v_intent.points is distinct from p_points then raise exception 'PACK_MISMATCH'; end if;
  select * into v_receipt from public.point_purchase_receipts where provider_purchase_id = p_purchase_id;
  if found then
    if v_receipt.user_id is distinct from p_user_id or v_receipt.intent_id is distinct from p_intent_id then raise exception 'WRONG_ACCOUNT'; end if;
    if exists(select 1 from public.point_transactions where reversal_of = v_receipt.transaction_id) then raise exception 'PURCHASE_REFUNDED'; end if;
    return jsonb_build_object('id', v_receipt.transaction_id, 'duplicate', true);
  end if;
  v_credit := public.apply_point_transaction(p_user_id, v_intent.points, 'award', 'itch.io points purchase',
    'itch.io', p_purchase_id, 'itch.io:purchase:' || p_purchase_id,
    jsonb_build_object('intentId', v_intent.id, 'packId', v_intent.pack_id, 'subProductId', v_intent.sub_product_id,
      'points', v_intent.points::text, 'name', v_intent.pack_name), null, null);
  insert into public.point_purchase_receipts(provider_purchase_id, intent_id, user_id, transaction_id)
    values(p_purchase_id, v_intent.id, p_user_id, (v_credit->>'id')::uuid);
  return v_credit;
end;
$$;
revoke all on function public.create_point_purchase_intent(uuid,text,text,bigint,text,text,text,text,bigint),
  public.credit_point_purchase(uuid,uuid,text,text,text,text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.create_point_purchase_intent(uuid,text,text,bigint,text,text,text,text,bigint),
  public.credit_point_purchase(uuid,uuid,text,text,text,text,bigint) to service_role;
revoke all on function public.get_point_purchase(uuid,uuid) from public, anon;
grant execute on function public.get_point_purchase(uuid,uuid) to authenticated, service_role;
commit;
