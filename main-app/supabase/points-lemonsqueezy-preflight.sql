-- READ ONLY. Run against STAGING with a trusted operator connection before and
-- after applying 202610110004_points_lemonsqueezy_orders.sql.
-- Prerequisite: the ledger migration (202609190001) is applied; the new migration
-- reuses public.apply_point_transaction and public.point_ledger_immutable.
select current_database() as database_name,
  to_regclass('public.point_accounts') as wallets,
  to_regclass('public.point_transactions') as ledger,
  to_regclass('public.point_checkout_orders') as lemonsqueezy_orders,
  to_regclass('public.point_provider_payments') as provider_payments,
  to_regclass('public.point_payment_settings') as payment_settings;
select n.nspname, p.proname, p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('apply_point_transaction', 'point_ledger_immutable',
    'create_point_checkout_order', 'credit_point_checkout_order', 'get_point_checkout_order',
    'record_point_provider_refund', 'list_point_provider_refunds_for_review');
-- After applying: must be false on production. Staging/local opt in deliberately with
--   update public.point_payment_settings set accept_test_payments = true where id = 1;
select to_regclass('public.point_payment_settings') is not null as settings_present;
