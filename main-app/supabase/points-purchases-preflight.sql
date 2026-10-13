-- READ ONLY. Run against the deliberately chosen staging database before the
-- additive purchase-intent migration. Inspect conflicts; do not reset a ledger.
select current_database() as database_name, current_user as database_role;
select name, to_regclass(name) as existing_relation from (values
  ('auth.users'), ('public.point_accounts'), ('public.point_transactions'),
  ('public.point_purchase_intents'), ('public.point_purchase_receipts')) as expected(name);
select table_name, column_name, data_type
from information_schema.columns where table_schema = 'public'
  and table_name in ('point_purchase_intents', 'point_purchase_receipts')
order by table_name, ordinal_position;
select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer, p.proacl as grants
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in
  ('point_ledger_immutable', 'apply_point_transaction', 'create_point_purchase_intent',
   'get_point_purchase', 'credit_point_purchase') order by p.proname;
