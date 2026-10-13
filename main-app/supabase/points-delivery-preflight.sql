-- READ ONLY. Run against STAGING using a trusted operator connection first.
select current_database() as database_name,
  to_regclass('public.point_accounts') as wallets,
  to_regclass('public.point_transactions') as ledger,
  to_regclass('public.point_purchase_intents') as intents,
  to_regclass('public.point_purchase_receipts') as receipts,
  to_regclass('public.point_verified_purchases') as verified_delivery;
select n.nspname, p.proname, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
  ('create_point_purchase_intent','credit_point_purchase','get_point_purchase',
   'remember_verified_point_purchase','get_verified_point_purchase');
