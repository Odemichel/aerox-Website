-- Bike fitter historique (plan `legacy`, accès `full`, sans abonnement
-- Stripe) : installation validée à la main pour que l'app desktop ouvre le
-- fitting. L'accueil BF (`BfStartStep.of`) n'ouvre le fitting qu'avec un
-- abonnement ou une date de fin d'essai ; `legacy` n'y est pas pris en compte.
--
-- trial_ends_at = installed_at = now() : essai considéré comme passé, la
-- carte « Démarrer avec AeroX » disparaît. Le plan reste `legacy` :
-- `bf_register_analysis_for` ignore l'essai pour ce plan et compte les
-- analyses en `legacy` ; le tableau de bord du site affiche le plan
-- `legacy` avant le cas « essai terminé ».
update public.bf_billing
set installed_at = now(),
    trial_ends_at = now(),
    updated_at = now()
where user_id = '1c2b23a0-9681-47de-a40f-b2d386825f33'
  and plan = 'legacy'
  and stripe_subscription_id is null
  and trial_ends_at is null;
