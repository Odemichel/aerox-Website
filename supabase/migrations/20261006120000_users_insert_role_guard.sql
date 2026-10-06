-- supabase/migrations/20261006120000_users_insert_role_guard.sql
--
-- Faille : la règle d'insertion de public.users ne contrôlait que l'id. Un
-- compte confirmé sans ligne public.users pouvait se créer une ligne avec
-- role = 'admin' (ou 'bike-fitter' sans passer par l'essai). Comme pour la
-- mise à jour (user_update_own_row), un utilisateur ne peut désormais créer
-- sa propre ligne qu'avec un rôle de départ : défaut 'user', 'rider' ou
-- 'pending_bf' (onboarding de l'app desktop). Les créations serveur
-- (handle_email_confirmed, security definer) ne sont pas concernées.

drop policy if exists "Allow insert for authenticated users" on public.users;

create policy "Allow insert for authenticated users" on public.users
  for insert to authenticated
  with check (
    auth.uid() = id
    and (role is null or role in ('user', 'rider', 'pending_bf'))
  );
