-- Durable record of VERIFIED provider payments before they are credited, so a
-- paid order can never be forgotten when crediting fails (wallet switched off,
-- temporary database error, provider retries exhausted). Requires 202610110004.
-- Additive: no existing row, table or function changes. Apply to STAGING only;
-- never run Prisma for it.
begin;

create table public.point_provider_payment_queue (
  provider text not null check (provider in ('lemonsqueezy', 'mock', 'stripe')),
  provider_order_id text not null check (length(provider_order_id) between 1 and 220),
  environment text not null check (environment in ('test', 'live')),
  order_id uuid not null references public.point_checkout_orders(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  store_id text not null check (length(store_id) between 1 and 64),
  variant_id text not null check (length(variant_id) between 1 and 120),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  received_at timestamptz not null default clock_timestamp(),
  primary key (provider, provider_order_id)
);
create index point_provider_payment_queue_order on public.point_provider_payment_queue(order_id);

alter table public.point_provider_payment_queue enable row level security;
revoke all on public.point_provider_payment_queue from public, anon, authenticated, service_role;
create trigger point_provider_payment_queue_immutable before update or delete on public.point_provider_payment_queue
  for each row execute function public.point_ledger_immutable();

-- Call ONLY after the webhook signature and the paid-order payload were verified.
-- The same provider order can be queued once; a different account/order is refused.
create function public.queue_point_provider_payment(p_provider text, p_environment text, p_provider_order_id text,
  p_order_id uuid, p_user_id uuid, p_store_id text, p_variant_id text, p_currency text,
  p_subtotal_minor bigint, p_total_minor bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.point_provider_payment_queue; v_order public.point_checkout_orders; v_inserted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  select * into v_order from public.point_checkout_orders where id = p_order_id;
  if not found then raise exception 'UNKNOWN_PURCHASE_INTENT'; end if;
  if v_order.user_id is distinct from p_user_id then raise exception 'WRONG_ACCOUNT'; end if;
  insert into public.point_provider_payment_queue(provider, provider_order_id, environment, order_id, user_id,
    store_id, variant_id, currency, subtotal_minor, total_minor)
  values (p_provider, p_provider_order_id, p_environment, p_order_id, p_user_id, p_store_id, p_variant_id,
    p_currency, p_subtotal_minor, p_total_minor)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select * into v_row from public.point_provider_payment_queue where provider = p_provider
      and provider_order_id = p_provider_order_id;
    if v_row.order_id is distinct from p_order_id or v_row.user_id is distinct from p_user_id
      or v_row.environment is distinct from p_environment then raise exception 'WRONG_ACCOUNT'; end if;
  end if;
  return jsonb_build_object('duplicate', v_inserted = 0);
end;
$$;

-- Credits queued payments that are not yet credited (all, or one order's).
-- Each payment is attempted on its own; one failure never blocks another.
-- Uses the existing credit function, so duplicates and refunds stay safe.
create function public.retry_point_provider_payments(p_order_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.point_provider_payment_queue; v_credited integer := 0; v_failed jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_WRITE_FORBIDDEN'; end if;
  for v_row in select q.* from public.point_provider_payment_queue q
      where (p_order_id is null or q.order_id = p_order_id)
        and not exists(select 1 from public.point_provider_payments p
          where p.provider = q.provider and p.provider_order_id = q.provider_order_id)
      order by q.received_at loop
    begin
      perform public.credit_point_checkout_order(v_row.provider, v_row.environment, v_row.provider_order_id,
        v_row.order_id, v_row.user_id, v_row.store_id, v_row.variant_id, v_row.currency,
        v_row.subtotal_minor, v_row.total_minor);
      v_credited := v_credited + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('provider', v_row.provider,
        'providerOrderId', v_row.provider_order_id, 'orderId', v_row.order_id, 'error', left(sqlerrm, 80)));
    end;
  end loop;
  return jsonb_build_object('credited', v_credited, 'failed', v_failed);
end;
$$;

-- Operator view: verified payments still waiting for credit, and recent
-- signed provider events that were deliberately not credited.
create function public.list_point_payment_exceptions()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'POINT_READ_FORBIDDEN'; end if;
  return jsonb_build_object(
    'uncredited', coalesce((select jsonb_agg(jsonb_build_object('provider', q.provider,
      'providerOrderId', q.provider_order_id, 'environment', q.environment, 'orderId', q.order_id,
      'userId', q.user_id, 'totalMinor', q.total_minor::text, 'currency', q.currency, 'receivedAt', q.received_at)
      order by q.received_at) from public.point_provider_payment_queue q
      where not exists(select 1 from public.point_provider_payments p
        where p.provider = q.provider and p.provider_order_id = q.provider_order_id)), '[]'::jsonb),
    'rejected', coalesce((select jsonb_agg(jsonb_build_object('provider', r.provider,
      'providerOrderId', r.provider_order_id, 'orderId', r.order_id, 'reason', r.reason, 'receivedAt', r.received_at)
      order by r.received_at desc) from (select * from public.point_provider_rejections
        order by received_at desc limit 200) r), '[]'::jsonb));
end;
$$;

revoke all on function public.queue_point_provider_payment(text,text,text,uuid,uuid,text,text,text,bigint,bigint),
  public.retry_point_provider_payments(uuid), public.list_point_payment_exceptions()
  from public, anon, authenticated, service_role;
grant execute on function public.queue_point_provider_payment(text,text,text,uuid,uuid,text,text,text,bigint,bigint),
  public.retry_point_provider_payments(uuid), public.list_point_payment_exceptions()
  to service_role;
commit;
