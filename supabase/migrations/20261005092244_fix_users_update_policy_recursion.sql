drop policy if exists user_update_own_row on public.users;

create policy user_update_own_row on public.users for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id and (
    role is not distinct from public.get_my_role()
    or (public.get_my_role() is null and role = any (array['rider', 'pending_bf']))));
