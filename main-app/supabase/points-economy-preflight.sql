-- READ ONLY. Run against STAGING with a trusted operator connection before and
-- after applying 202610130005_points_lots_refunds.sql and
-- 202610130006_points_usage_products.sql.
-- Prerequisites: 202609190001 ... 202610110004 are applied.

-- 1. Prerequisite tables exist; the new tables do not yet exist (before applying).
select current_database() as database_name,
  to_regclass('public.point_transactions') as ledger,
  to_regclass('public.point_checkout_orders') as checkout_orders,
  to_regclass('public.point_provider_payments') as provider_payments,
  to_regclass('public.point_lots') as lots_new,
  to_regclass('public.point_usage_sessions') as usage_sessions_new,
  to_regclass('public.point_products') as products_new;

-- 2. The migration drops these constraints BY NAME and re-adds wider ones. Every
--    row below must be present with the shown definition, or the migration aborts.
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
  where contype = 'c' and conname in ('point_transactions_type_check', 'point_transactions_check',
    'point_checkout_orders_provider_check', 'point_checkout_orders_store_id_check',
    'point_checkout_orders_variant_id_check', 'point_provider_payments_provider_check',
    'point_provider_payments_provider_order_id_check', 'point_provider_refunds_provider_check',
    'point_provider_refunds_provider_order_id_check', 'point_provider_rejections_provider_check',
    'point_provider_rejections_provider_order_id_check')
  order by 1, 2;

-- 3. History the lot backfill will replay. The migration aborts (changing nothing)
--    if any balance would not equal the sum of its rebuilt lots.
select count(*) as accounts, coalesce(sum(balance), 0) as total_balance from public.point_accounts;
select type, source_type, count(*) as rows, sum(amount) as amount
  from public.point_transactions group by type, source_type order by type, source_type;
select count(*) as accounts_not_reconciling from public.point_accounts
  where balance <> lifetime_earned - lifetime_spent;

-- 4. After applying: the lot invariant holds for every account (expect 0 rows).
--    Run only once point_lots exists.
-- select a.user_id, a.balance, coalesce(sum(l.original - l.consumed - l.revoked), 0) as lots
--   from public.point_accounts a left join public.point_lots l on l.user_id = a.user_id
--   group by a.user_id, a.balance having a.balance <> coalesce(sum(l.original - l.consumed - l.revoked), 0);

-- 5. After applying: billing is OFF until an operator deliberately configures it.
-- select * from public.point_billing_settings;   -- usage_billing_enabled = false, verified_quantity_sources = {}
-- select count(*) from public.point_gift_values;  -- 0
-- select count(*) from public.point_products;     -- 0
