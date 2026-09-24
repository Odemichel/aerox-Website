// src/lib/mailerlite.ts
//
// Mise à jour des champs d'un abonné MailerLite existant ou nouveau
// (l'API `POST /subscribers` est un upsert par e-mail : les champs fournis
// sont écrasés, les autres conservés, les groupes ne sont pas retirés).

const MAILERLITE_TIMEOUT_MS = 8000;

/** Valeurs de `bf_status` : où en est le bike fitter dans le tunnel. */
export type BfStatus = 'lead' | 'trial' | 'active' | 'past_due' | 'read_only' | 'churned';

/**
 * Écrit des champs sur la fiche MailerLite. Ne lève jamais : un CRM
 * indisponible ne doit faire échouer ni une inscription ni un webhook de
 * paiement. Renvoie `false` en cas d'échec (journalisé).
 */
export async function upsertMailerLiteFields(email: string, fields: Record<string, string>): Promise<boolean> {
  const key = import.meta.env.MAILERLITE_API_KEY as string | undefined;
  if (!key) {
    console.error('mailerlite: MAILERLITE_API_KEY absent, champs non mis à jour');
    return false;
  }
  try {
    const res = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ email, fields }),
      signal: AbortSignal.timeout(MAILERLITE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('mailerlite: mise à jour refusée', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('mailerlite: injoignable', err);
    return false;
  }
}

/**
 * Inscrit l'abonné dans un groupe (upsert par e-mail, avec des champs). Une
 * automatisation « rejoint le groupe » peut s'y déclencher. Ne lève jamais,
 * comme `upsertMailerLiteFields`.
 */
export async function addToMailerLiteGroup(
  email: string,
  groupId: string,
  fields: Record<string, string> = {}
): Promise<boolean> {
  const key = import.meta.env.MAILERLITE_API_KEY as string | undefined;
  if (!key) {
    console.error('mailerlite: MAILERLITE_API_KEY absent, groupe non rejoint');
    return false;
  }
  try {
    const res = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ email, fields, groups: [groupId] }),
      signal: AbortSignal.timeout(MAILERLITE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('mailerlite: inscription au groupe refusée', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('mailerlite: injoignable', err);
    return false;
  }
}

/**
 * Retire l'abonné des groupes donnés (ex. : acheteur remboursé, qui ne doit
 * plus recevoir les emails de livraison). Abonné inconnu = rien à retirer.
 * Ne lève jamais.
 */
export async function removeFromMailerLiteGroups(email: string, groupIds: string[]): Promise<boolean> {
  const key = import.meta.env.MAILERLITE_API_KEY as string | undefined;
  if (!key) {
    console.error('mailerlite: MAILERLITE_API_KEY absent, groupes non quittés');
    return false;
  }
  const headers = { Authorization: `Bearer ${key}` };
  try {
    // L'API retire d'un groupe par identifiant d'abonné, pas par e-mail.
    const found = await fetch(`https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`, {
      headers,
      signal: AbortSignal.timeout(MAILERLITE_TIMEOUT_MS),
    });
    if (found.status === 404) return true;
    if (!found.ok) {
      console.error('mailerlite: abonné illisible', found.status, await found.text().catch(() => ''));
      return false;
    }
    const subscriberId = ((await found.json()) as { data?: { id?: string } }).data?.id;
    if (!subscriberId) return false;
    let ok = true;
    for (const groupId of groupIds) {
      const res = await fetch(`https://connect.mailerlite.com/api/subscribers/${subscriberId}/groups/${groupId}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(MAILERLITE_TIMEOUT_MS),
      });
      // 404 : l'abonné n'était pas dans ce groupe.
      if (!res.ok && res.status !== 404) {
        console.error('mailerlite: retrait du groupe refusé', groupId, res.status);
        ok = false;
      }
    }
    return ok;
  } catch (err) {
    console.error('mailerlite: injoignable', err);
    return false;
  }
}
