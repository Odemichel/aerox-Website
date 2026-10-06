-- feat-session-positions-fk
-- Rétablit l'intégrité référentielle sur session_positions.session_id.
--
-- Historique : la colonne était TEXT sans FK → tolérait n'importe quel string.
-- Un bug applicatif (SessionSaveService, fallback `timestamp_ms.toString()`
-- quand l'insert dans sessions échouait) a produit 15 lignes orphelines sur
-- 3 mois. Nettoyage manuel effectué en amont (voir 20260704_diagnostic_basic).
--
-- Objectif : rendre les orphelins physiquement impossibles à insérer.

-- ============================================================================
-- 1. Garde de sécurité : refuse la migration si des orphelins subsistent
-- ============================================================================
DO $$
DECLARE
  orphans INT;
  nulls   INT;
BEGIN
  SELECT count(*) INTO nulls FROM public.session_positions WHERE session_id IS NULL;
  IF nulls > 0 THEN
    RAISE EXCEPTION 'Abort — % NULL session_id trouvés, nettoyer avant migration', nulls;
  END IF;

  SELECT count(*) INTO orphans
  FROM public.session_positions sp
  WHERE NOT EXISTS (
    SELECT 1 FROM public.sessions s WHERE s.id::text = sp.session_id
  );
  IF orphans > 0 THEN
    RAISE EXCEPTION 'Abort — % orphelins trouvés (session_id ne référence aucun sessions.id)', orphans;
  END IF;
END $$;

-- ============================================================================
-- 2. Bascule TEXT → UUID
-- ============================================================================
-- La policy DELETE "Users can delete positions of own sessions" cast
-- explicitement `session_id::uuid` dans son body → bloque l'ALTER COLUMN
-- TYPE. On la DROP, on ALTER, on la RECREATE sans le cast (devenu inutile
-- une fois la colonne native en UUID).
DROP POLICY IF EXISTS "Users can delete positions of own sessions"
  ON public.session_positions;

-- Cast explicite : `session_id::uuid` — safe car préflight validé.
ALTER TABLE public.session_positions
  ALTER COLUMN session_id TYPE UUID USING session_id::uuid;

-- Force NOT NULL au passage (déjà vrai en pratique — sécurité formelle)
ALTER TABLE public.session_positions
  ALTER COLUMN session_id SET NOT NULL;

-- Recréation de la policy DELETE sans le cast (session_id est déjà UUID)
CREATE POLICY "Users can delete positions of own sessions"
  ON public.session_positions
  FOR DELETE
  USING (
    session_id IN (
      SELECT id FROM public.sessions WHERE user_id = auth.uid()
    )
  );

-- ============================================================================
-- 3. Foreign key vers sessions.id
-- ============================================================================
-- ON DELETE CASCADE : supprimer une session supprime automatiquement ses
-- positions. Cohérent avec le pattern déjà utilisé sur
-- diagnostic_basic_positions.
ALTER TABLE public.session_positions
  DROP CONSTRAINT IF EXISTS session_positions_session_fk;

ALTER TABLE public.session_positions
  ADD CONSTRAINT session_positions_session_fk
  FOREIGN KEY (session_id) REFERENCES public.sessions(id)
  ON DELETE CASCADE;

-- Index sur la FK pour accélérer les JOIN et les lookups par session
CREATE INDEX IF NOT EXISTS idx_session_positions_session_id
  ON public.session_positions (session_id);

COMMENT ON CONSTRAINT session_positions_session_fk ON public.session_positions IS
  'Rend les orphelins physiquement impossibles. CASCADE : delete session → delete positions.';
