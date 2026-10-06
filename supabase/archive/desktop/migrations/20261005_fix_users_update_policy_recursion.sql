-- ============================================================================
-- fix — récursion infinie de la policy `user_update_own_row` sur `users`
-- ============================================================================
-- La garde anti-escalade de rôle relisait `public.users` en sous-requête
-- dans son WITH CHECK : Postgres réapplique alors les policies de `users`
-- et lève 42P17 « infinite recursion detected in policy for relation
-- users » sur TOUT update client de sa propre ligne (lang, weight, ftp,
-- onboarding_completed, setup_correction…), quel que soit le rôle.
--
-- `get_my_role()` (SECURITY DEFINER, existante) lit le rôle sans passer par
-- la RLS, donc sans récursion. Elle voit la ligne avant l'update : la
-- comparaison reste « nouveau rôle = rôle actuel ». Sémantique inchangée :
--   - rôle inchangé → OK ;
--   - pas encore de rôle → seulement rider / pending_bf ;
--   - toute autre transition (ex. rider → admin) → refus RLS.
-- Vérifié en transaction annulée sur prod le 2026-10-05 : update lang OK
-- (rider), escalade rider → admin refusée (42501), ligne d'un autre user
-- non touchée (0 ligne), update setup_correction OK (admin).

drop policy if exists user_update_own_row on public.users;

create policy user_update_own_row on public.users for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id and (
    role is not distinct from public.get_my_role()
    or (public.get_my_role() is null and role = any (array['rider', 'pending_bf']))));
