// src/lib/signupOrigin.ts
//
// Origine d'une inscription, notée dans le champ MailerLite `origine` : par
// où la personne est arrivée sur le site pendant cette visite (lien de DM ou
// de bio Instagram avec la publication, ou famille du site d'origine :
// google, instagram, chatgpt, direct…). Calculée dans la page par
// IgAttribution.astro, gardée en mémoire le temps de la visite (rien sur
// l'appareil), envoyée dans l'en-tête `X-Aerox-Origin` des formulaires
// d'inscription. Ni adresse complète, ni historique.

export const SIGNUP_ORIGIN = /^[a-z0-9][a-z0-9/_-]{0,63}$/;

/** Origine valide lue dans l'en-tête, ou `null`. */
export function signupOrigin(request: Request): string | null {
  const v = (request.headers.get('x-aerox-origin') ?? '').trim().toLowerCase();
  return SIGNUP_ORIGIN.test(v) ? v : null;
}

/** `{ origine }` à fusionner dans les champs MailerLite, ou `{}`. */
export function origineField(request: Request): { origine?: string } {
  const v = signupOrigin(request);
  return v ? { origine: v } : {};
}
