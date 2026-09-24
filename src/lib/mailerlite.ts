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
