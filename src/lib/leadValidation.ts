export const LEAD_TOPICS = ['test-period', 'bike-fitter'] as const;
export type LeadTopic = (typeof LEAD_TOPICS)[number];

const MAX_FIELD_LENGTH = 2000;

// Volontairement strict mais simple : un local, un @, un domaine pointé.
// Le but est d'écarter le bruit, pas de valider la RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export type LeadInput = {
  topic?: unknown;
  name?: unknown;
  email?: unknown;
  message?: unknown;
  availability?: unknown;
  trainer?: unknown;
  webcam?: unknown;
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
};

export type LeadResult = { ok: true; honeypot: boolean; lead: Lead } | { ok: false; error: string };

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  return value.trim();
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

  const honeypot = typeof input.hp === 'string' && input.hp.trim().length > 0;

  return {
    ok: true,
    honeypot,
    lead: { topic: topic as LeadTopic, name, email, message, availability, trainer, webcam },
  };
}
