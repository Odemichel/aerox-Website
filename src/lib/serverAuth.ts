// src/lib/serverAuth.ts
import { createClient, type User } from '@supabase/supabase-js';

/**
 * Utilisateur derrière la requête, ou `null`.
 *
 * Le jeton est lu dans l'en-tête `Authorization` et vérifié par Supabase :
 * `auth.getUser(jwt)` valide la signature et l'expiration côté serveur
 * d'authentification. La session du site vit dans `localStorage` (voir
 * `src/config/supabaseClient.ts`) et non dans un cookie : il n'y a rien à
 * lire d'autre que cet en-tête, que le client doit poser explicitement.
 *
 * `logTag` préfixe les journaux pour savoir quelle route a refusé.
 */
export async function authenticatedUser(request: Request, logTag: string): Promise<User | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token || token === header.trim()) return null;

  const url = (import.meta.env.PUBLIC_SUPABASE_URL || import.meta.env.SUPABASE_URL) as string | undefined;
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) {
    console.error(`${logTag}: configuration Supabase absente, authentification impossible`);
    return null;
  }

  // Clé anon, jamais la clé service_role : on veut vérifier un jeton, pas
  // obtenir un pouvoir d'administration dans une route publique.
  const supabase = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    console.error(`${logTag}: jeton refusé —`, error?.message ?? 'aucun utilisateur');
    return null;
  }
  return data.user;
}
