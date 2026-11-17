-- Sondage d'onboarding de fin de 1re séance retiré de l'app (objectif, temps
-- disponible, gênes → recommandation de diagnostic ou de plan). Sa table, ses
-- règles RLS (rider_can_insert_own / read_own / update_own) et ses 5 réponses
-- partent avec lui ; aucune vue, fonction, trigger ni clé étrangère n'en
-- dépend.

DROP TABLE IF EXISTS public.user_onboarding_answers;
