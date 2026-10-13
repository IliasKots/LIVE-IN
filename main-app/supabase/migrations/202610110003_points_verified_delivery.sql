-- Additive recovery inbox. No balance changes or raw provider secrets/proofs.
begin;
create table public.point_verified_purchases (
  provider_purchase_id text primary key check (provider_purchase_id ~ '^[1-9][0-9]{0,19}$'),
  intent_id uuid not null references public.point_purchase_intents(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  claim jsonb not null check (jsonb_typeof(claim) = 'object'),
  verified_at timestamptz not null default clock_timestamp()
);
create index point_verified_purchases_intent on public.point_verified_purchases(intent_id, verified_at);
alter table public.point_verified_purchases enable row level security;
revoke all on public.point_verified_purchases from public, anon, authenticated, service_role;
create trigger point_verified_purchases_immutable before update or delete on public.point_verified_purchases
  for each row execute function public.point_ledger_immutable();

create function public.remember_verified_point_purchase(p_project_url text, p_claim jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.point_purchase_intents; v_existing public.point_verified_purchases;
  v_purchase text := p_claim->>'purchaseId'; v_claim jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  if v_purchase is null or v_purchase !~ '^[1-9][0-9]{0,19}$' then raise exception 'INVALID_PURCHASE'; end if;
  perform pg_advisory_xact_lock(hashtextextended('itch.io:purchase:' || v_purchase, 0));
  select * into v_intent from public.point_purchase_intents where id = (p_claim->>'intentId')::uuid;
  if not found then raise exception 'UNKNOWN_PURCHASE_INTENT'; end if;
  if v_intent.user_id::text is distinct from p_claim->>'userId' then raise exception 'WRONG_ACCOUNT'; end if;
  if v_intent.project_url is distinct from p_project_url
    or v_intent.pack_id is distinct from p_claim->>'packId'
    or v_intent.sub_product_id is distinct from p_claim->>'subProductId'
    or v_intent.points::text is distinct from p_claim->>'points'
    or v_intent.currency is distinct from p_claim->>'currency'
    or v_intent.price_minor::text is distinct from p_claim->>'priceMinor'
    then raise exception 'PACK_MISMATCH'; end if;
  if (p_claim->>'paidCurrency') is not null and v_intent.currency <> p_claim->>'paidCurrency'
    then raise exception 'PACK_MISMATCH'; end if;
  if (p_claim->>'paidMinor') is not null and (p_claim->>'paidMinor')::bigint < v_intent.price_minor
    then raise exception 'PACK_MISMATCH'; end if;
  -- Normalize from the immutable server intent, with only verified paid fields.
  v_claim := jsonb_build_object('purchaseId', v_purchase, 'intentId', v_intent.id::text,
    'userId', v_intent.user_id::text, 'packId', v_intent.pack_id, 'subProductId', v_intent.sub_product_id,
    'points', v_intent.points::text, 'name', v_intent.pack_name, 'currency', v_intent.currency,
    'priceMinor', v_intent.price_minor::text, 'paidCurrency', p_claim->>'paidCurrency', 'paidMinor', p_claim->>'paidMinor');
  select * into v_existing from public.point_verified_purchases where provider_purchase_id = v_purchase;
  if found then
    if v_existing.user_id <> v_intent.user_id or v_existing.intent_id <> v_intent.id
      then raise exception 'WRONG_ACCOUNT'; end if;
    if v_existing.claim is distinct from v_claim then raise exception 'POINT_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('duplicate', true);
  end if;
  insert into public.point_verified_purchases(provider_purchase_id, intent_id, user_id, claim)
    values(v_purchase, v_intent.id, v_intent.user_id, v_claim);
  return jsonb_build_object('duplicate', false);
end;
$$;

create function public.get_verified_point_purchase(p_user_id uuid, p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_claim jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_READ_FORBIDDEN'; end if;
  if not exists(select 1 from public.point_purchase_intents where id = p_intent_id and user_id = p_user_id)
    then raise exception 'UNKNOWN_PURCHASE_INTENT'; end if;
  -- Pending receipts first; once all are credited, retries return an existing
  -- receipt and the ledger's original idempotency key still prevents a new award.
  select v.claim into v_claim from public.point_verified_purchases v
    left join public.point_purchase_receipts r on r.provider_purchase_id = v.provider_purchase_id
    where v.intent_id = p_intent_id and v.user_id = p_user_id
    order by (r.provider_purchase_id is not null), v.verified_at, v.provider_purchase_id limit 1;
  return v_claim;
end;
$$;
revoke all on function public.remember_verified_point_purchase(text,jsonb), public.get_verified_point_purchase(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.remember_verified_point_purchase(text,jsonb), public.get_verified_point_purchase(uuid,uuid)
  to service_role;

-- A newer abandoned checkout must not hide an older verified, undelivered order
-- when a fresh launcher session asks for account recovery without an intent ID.
create or replace function public.get_point_purchase(p_user_id uuid, p_intent_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.point_purchase_intents; v_receipt public.point_purchase_receipts; v_refunded boolean; v_pending boolean;
begin
  if p_user_id is null or (coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from p_user_id)
    then raise exception 'POINT_READ_FORBIDDEN'; end if;
  select i.* into v_intent from public.point_purchase_intents i where i.user_id = p_user_id
    and (p_intent_id is null or i.id = p_intent_id)
    order by exists(select 1 from public.point_verified_purchases v
      where v.intent_id = i.id and not exists(select 1 from public.point_purchase_receipts r
        where r.provider_purchase_id = v.provider_purchase_id)) desc, i.created_at desc, i.id desc limit 1;
  if not found then return null; end if;
  select * into v_receipt from public.point_purchase_receipts where intent_id = v_intent.id
    order by credited_at desc, provider_purchase_id desc limit 1;
  select exists(select 1 from public.point_transactions where reversal_of = v_receipt.transaction_id) into v_refunded;
  select exists(select 1 from public.point_verified_purchases v where v.intent_id = v_intent.id
    and not exists(select 1 from public.point_purchase_receipts r where r.provider_purchase_id = v.provider_purchase_id)) into v_pending;
  return jsonb_build_object('id', v_intent.id, 'userId', v_intent.user_id, 'packId', v_intent.pack_id,
    'name', v_intent.pack_name, 'points', v_intent.points::text, 'projectUrl', v_intent.project_url,
    'subProductId', v_intent.sub_product_id, 'priceLabel', v_intent.price_label, 'currency', v_intent.currency,
    'priceMinor', v_intent.price_minor::text, 'createdAt', v_intent.created_at,
    'status', case when v_pending then 'pending' when v_refunded then 'refunded'
      when v_receipt.transaction_id is not null then 'credited' else 'pending' end,
    'purchaseId', v_receipt.provider_purchase_id, 'transactionId', v_receipt.transaction_id, 'creditedAt', v_receipt.credited_at);
end;
$$;
commit;
