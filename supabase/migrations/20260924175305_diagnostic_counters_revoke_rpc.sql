-- Fonctions de compteurs passées SECURITY DEFINER par diagnostic_purchases :
-- elles ne servent que de triggers, jamais d'endpoint /rpc.
revoke execute on function public.recompute_diagnostic_basic_s1_counts() from public, anon, authenticated;
revoke execute on function public.recompute_diagnostic_basic_s2_count() from public, anon, authenticated;
revoke execute on function public.recompute_diagnostic_basic_best_s1() from public, anon, authenticated;
revoke execute on function public.recompute_diagnostic_basic_best_s2() from public, anon, authenticated;
