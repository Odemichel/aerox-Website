update supabase_migrations.schema_migrations
set statements = array['-- secrets Vault billing_hook_secret et bf_notify_secret posés ; valeurs retirées de l''historique']
where name = 'bf_vault_secrets';
