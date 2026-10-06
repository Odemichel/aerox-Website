-- fix-device-logs-upsert
-- Ajoute une policy SELECT sur device_logs pour les users authentifiés.
--
-- Contexte : depuis 2026-04-15 (commit aec4a15), LogUploadService utilise
-- upsert(row, onConflict: 'user_id,trigger'). PostgreSQL exige qu'une
-- policy SELECT soit définie pour que INSERT … ON CONFLICT DO UPDATE
-- puisse évaluer la détection de conflit sous RLS. Sans cette policy,
-- la branche INSERT échoue avec 42501 pour tout nouvel utilisateur
-- (Philippe, William, etc.) — symptôme : aucune row créée post-upsert.
--
-- Cette policy ne donne accès qu'aux propres logs de chaque user ;
-- `admin_read_all_logs` couvre déjà la lecture admin.

DROP POLICY IF EXISTS "user_select_own_logs" ON public.device_logs;

CREATE POLICY "user_select_own_logs"
  ON public.device_logs
  FOR SELECT
  USING (auth.uid() = user_id);
