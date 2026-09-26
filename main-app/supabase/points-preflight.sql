-- READ ONLY: run in the intended STAGING project's SQL editor before migration.
-- If existing point/wallet tables or grant/deduct functions appear, reconcile
-- them before deployment. Do not overwrite or abandon an existing funded ledger.

select current_database() as database_name, current_user as database_role;

select table_schema, table_name, column_name, data_type
from information_schema.columns
where (table_schema = 'auth' and table_name = 'users' and column_name = 'id')
   or (table_schema = 'public' and table_name in ('profiles', 'launcher_sessions')
       and column_name in ('id', 'user_id', 'access_token_hash', 'access_expires_at', 'revoked_at'))
order by table_schema, table_name, ordinal_position;

select table_schema, table_name
from information_schema.tables
where table_schema = 'public' and table_name ~* '(point|wallet|credit|ledger)'
order by table_name;

select n.nspname as function_schema, p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname ~* '(point|wallet|credit|ledger)'
order by p.proname;
