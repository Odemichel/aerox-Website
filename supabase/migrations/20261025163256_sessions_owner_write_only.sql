-- sessions / session_positions : les policies `ALL` ouvraient USING au client
-- (`client_id` / `rider_id`) avec seulement `WITH CHECK (user_id = auth.uid())`.
-- Le client d'un bike fitter pouvait donc SUPPRIMER les séances de fitting du
-- BF (DELETE n'évalue que USING) ou se les approprier (UPDATE posant
-- `user_id = moi` passe le WITH CHECK).
-- Désormais : écriture réservée au propriétaire (`user_id`), lecture seule
-- pour le client / rider. Aucun flux légitime ne change : un UPDATE du client
-- échouait déjà au WITH CHECK (sauf appropriation).
-- (audit sécurité Flutter 2026-10-25)

DROP POLICY IF EXISTS own_sessions ON public.sessions;
CREATE POLICY own_sessions ON public.sessions
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY client_reads_sessions ON public.sessions
  FOR SELECT TO authenticated
  USING (client_id = (SELECT auth.uid()) OR rider_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS own_positions ON public.session_positions;
CREATE POLICY own_positions ON public.session_positions
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY rider_reads_positions ON public.session_positions
  FOR SELECT TO authenticated
  USING (rider_id = (SELECT auth.uid()));
