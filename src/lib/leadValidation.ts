export const LEAD_TOPICS = ['test-period', 'bike-fitter'] as const;
export type LeadTopic = (typeof LEAD_TOPICS)[number];

const MAX_FIELD_LENGTH = 2000;

// Profondeur maximale explorée dans un `hp` imbriqué. Large par rapport à tout
// remplissage plausible, très en deçà de la pile d'appels.
const HONEYPOT_MAX_DEPTH = 8;

// Volontairement strict mais simple : un local, un @, un domaine pointé.
// Le but est d'écarter le bruit, pas de valider la RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Ce qu'un bike-fitter demande, et donc à quel point il est chaud :
 * `demo` et `devis` viennent du formulaire, `inscription` de la création de
 * compte directe. Toute autre valeur retombe sur `demo` plutôt que de rejeter
 * la requête : c'est un champ d'information commerciale, pas un contrôle.
 */
export const LEAD_INTENTS = ['demo', 'devis', 'inscription'] as const;
export type LeadIntent = (typeof LEAD_INTENTS)[number];

export type LeadInput = {
  topic?: unknown;
  name?: unknown;
  email?: unknown;
  message?: unknown;
  availability?: unknown;
  trainer?: unknown;
  webcam?: unknown;
  intent?: unknown;
  phone?: unknown;
  hp?: unknown;
};

export type Lead = {
  topic: LeadTopic;
  name: string;
  email: string;
  message: string;
  availability: string;
  trainer: string;
  webcam: 'oui' | 'non' | '';
  intent: LeadIntent;
  phone: string;
};

export type LeadResult = { ok: true; honeypot: boolean; lead: Lead } | { ok: false; error: string };

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  return value.trim();
}

/**
 * Le champ honeypot est invisible : toute valeur réellement portée par la
 * requête trahit un remplissage automatique.
 *
 * `false` et `0` sont exclus volontairement : ce sont les sérialisations
 * naturelles d'un champ *non* rempli (case décochée, valeur numérique par
 * défaut). Les retenir jetterait des leads légitimes, ce que ce contrôle
 * doit justement éviter — un rejet honeypot est silencieux pour le visiteur.
 */
export function isHoneypotFilled(value: unknown, depth = 0): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) {
    // Profondeur bornée : `value` vient entièrement de la requête, et
    // `validateLead` est appelée avant le limiteur et hors de tout `try`.
    // Une descente non bornée exposerait un `RangeError` non capté.
    // Au-delà de la borne on considère le honeypot déclenché : aucun
    // remplissage légitime n'imbrique un champ caché sur cette profondeur.
    if (depth >= HONEYPOT_MAX_DEPTH) return true;
    // Lambda explicite, et non `value.some(isHoneypotFilled)` : `some` passe
    // l'indice en deuxième argument, qui serait pris pour la profondeur.
    return value.some((entry) => isHoneypotFilled(entry, depth + 1));
  }
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true; // nombre non nul, `true`, bigint, symbole…
}

export function validateLead(input: LeadInput): LeadResult {
  // Garde contre null, undefined, non-objets (primitives, arrays)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid_topic' };
  }

  const topic = input.topic;
  if (typeof topic !== 'string' || !(LEAD_TOPICS as readonly string[]).includes(topic)) {
    return { ok: false, error: 'invalid_topic' };
  }

  const name = asText(input.name);
  if (name === null || name.length === 0) return { ok: false, error: 'invalid_name' };
  if (name.length > MAX_FIELD_LENGTH) return { ok: false, error: 'field_too_long' };

  const rawEmail = asText(input.email);
  if (rawEmail === null) return { ok: false, error: 'invalid_email' };
  const email = rawEmail.toLowerCase();
  if (email.length > MAX_FIELD_LENGTH) return { ok: false, error: 'field_too_long' };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };

  const message = asText(input.message);
  const trainer = asText(input.trainer);
  if (message === null || trainer === null) return { ok: false, error: 'invalid_field' };
  if (message.length > MAX_FIELD_LENGTH || trainer.length > MAX_FIELD_LENGTH) {
    return { ok: false, error: 'field_too_long' };
  }

  let availability = '';
  if (Array.isArray(input.availability)) {
    availability = input.availability.filter((v): v is string => typeof v === 'string').join(', ');
  } else {
    const single = asText(input.availability);
    if (single === null) return { ok: false, error: 'invalid_field' };
    availability = single;
  }
  if (availability.length > MAX_FIELD_LENGTH) return { ok: false, error: 'field_too_long' };

  const webcamRaw = typeof input.webcam === 'string' ? input.webcam.trim().toLowerCase() : '';
  const webcam: Lead['webcam'] = webcamRaw === 'oui' || webcamRaw === 'non' ? webcamRaw : '';

  const intentRaw = typeof input.intent === 'string' ? input.intent.trim().toLowerCase() : '';
  const intent: LeadIntent = (LEAD_INTENTS as readonly string[]).includes(intentRaw)
    ? (intentRaw as LeadIntent)
    : 'demo';

  // Le téléphone est borné comme les autres champs texte, mais jamais validé
  // sur sa forme : les formats varient trop d'un pays à l'autre, et un numéro
  // mal saisi vaut mieux qu'un lead rejeté.
  const phone = asText(input.phone);
  if (phone === null) return { ok: false, error: 'invalid_field' };
  if (phone.length > MAX_FIELD_LENGTH) return { ok: false, error: 'field_too_long' };

  // Le honeypot se déclenche sur toute valeur non vide, quel que soit son type :
  // un bot qui poste `hp: 1` ou `hp: ['x']` ne doit pas passer au travers du
  // filtre simplement parce que ce n'est pas une chaîne.
  const honeypot = isHoneypotFilled(input.hp);

  return {
    ok: true,
    honeypot,
    lead: { topic: topic as LeadTopic, name, email, message, availability, trainer, webcam, intent, phone },
  };
}
