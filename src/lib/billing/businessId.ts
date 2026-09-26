// src/lib/billing/businessId.ts
//
// Identifiant d'entreprise d'un bike fitter : c'est lui qui ouvre l'essai de
// 14 jours. Trois formes, dans un seul champ :
//   - France : SIREN / SIRET → API Recherche d'entreprises
//     (recherche-entreprises.api.gouv.fr), entreprise active exigée ;
//   - Union européenne : n° de TVA intracommunautaire → VIES ;
//   - sinon le site internet du studio : contrôles automatiques légers
//     (adresse valide, site qui répond, pas une messagerie ni un réseau
//     social), puis validation manuelle par l'admin.
//
// Un identifiant ne sert qu'à un compte : la clé normalisée (`key`) est
// unique en base. SIREN, SIRET et TVA française d'une même entreprise donnent
// la même clé ; un site donne la clé de son domaine (sans « www. »).

export type ParsedBusinessId =
  | { kind: 'siren'; key: string; siren: string; country: 'FR' }
  | { kind: 'eu_vat'; key: string; country: string; number: string }
  | { kind: 'website'; key: string; host: string; url: string }
  | { kind: 'invalid' };

// Préfixes TVA des États membres (EL = Grèce, XI = Irlande du Nord).
const EU_VAT_PREFIXES = new Set([
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'EL',
  'ES',
  'FI',
  'FR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
  'XI',
]);

/** Clé de Luhn, utilisée par le SIREN et le SIRET. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// La Poste : SIRET hors algorithme de Luhn (somme des chiffres multiple de 5).
const LA_POSTE_SIREN = '356000000';

function sirenValid(siren: string): boolean {
  return /^\d{9}$/.test(siren) && luhnValid(siren);
}

function siretValid(siret: string): boolean {
  if (!/^\d{14}$/.test(siret)) return false;
  if (siret.startsWith(LA_POSTE_SIREN)) {
    return [...siret].reduce((a, c) => a + Number(c), 0) % 5 === 0;
  }
  return luhnValid(siret);
}

/** Clé d'un n° de TVA français : (12 + 3 × (SIREN mod 97)) mod 97. */
export function frVatKey(siren: string): string {
  return String((12 + 3 * (Number(siren) % 97)) % 97).padStart(2, '0');
}

// Domaines qui ne désignent pas un studio : messageries, réseaux sociaux,
// pages de liens, hébergeurs de pages génériques.
const GENERIC_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.fr',
  'live.com',
  'yahoo.com',
  'yahoo.fr',
  'icloud.com',
  'orange.fr',
  'free.fr',
  'sfr.fr',
  'laposte.net',
  'wanadoo.fr',
  'gmx.com',
  'gmx.de',
  'proton.me',
  'protonmail.com',
  'facebook.com',
  'fb.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'linktr.ee',
  'beacons.ai',
  'google.com',
  'goo.gl',
  'maps.app.goo.gl',
  'strava.com',
  'whatsapp.com',
  'wa.me',
  't.me',
  'bit.ly',
  'aeroxbefaster.com',
];

/** Domaine générique (ou l'un de ses sous-domaines) : ne désigne pas un studio. */
export function isGenericDomain(host: string): boolean {
  return GENERIC_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Nom d'hôte normalisé : minuscules, sans « www. ». */
function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

/** Le domaine de l'e-mail du compte correspond-il au site ? (paul@monstudio.ch ↔ monstudio.ch) */
export function emailMatchesHost(email: string | null | undefined, host: string): boolean {
  const domain = normalizeHost((email ?? '').split('@')[1] ?? '');
  return Boolean(domain) && !isGenericDomain(domain) && (host === domain || host.endsWith(`.${domain}`));
}

function parseWebsite(input: string): ParsedBusinessId {
  const text = input.trim();
  if (/\s/.test(text) || !/[a-z]/i.test(text) || !text.includes('.')) return { kind: 'invalid' };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { kind: 'invalid' };
  }
  const host = normalizeHost(url.hostname);
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || isGenericDomain(host)) return { kind: 'invalid' };
  return {
    kind: 'website',
    key: `WEB:${host}`,
    host,
    url: `https://${url.hostname}${url.pathname === '/' ? '' : url.pathname}`,
  };
}

/** Lecture d'un identifiant saisi librement (espaces, points, tirets tolérés). */
export function parseBusinessId(input: unknown): ParsedBusinessId {
  if (typeof input !== 'string') return { kind: 'invalid' };
  // Site internet : un domaine (lettres, point, extension) ou une URL.
  if (
    /^\s*(https?:\/\/)?[^\s/]*[a-z][^\s/]*\.[a-z]{2,}(\/\S*)?\s*$/i.test(input) &&
    !/^\s*[A-Z]{2}[\d\s.]+\s*$/i.test(input)
  ) {
    return parseWebsite(input);
  }
  const raw = input.toUpperCase().replace(/[\s.\-/]/g, '');
  if (raw.length < 4 || raw.length > 20 || !/^[A-Z0-9]+$/.test(raw)) return { kind: 'invalid' };

  if (/^\d{9}$/.test(raw)) {
    return sirenValid(raw) ? { kind: 'siren', key: `FR:${raw}`, siren: raw, country: 'FR' } : { kind: 'invalid' };
  }
  if (/^\d{14}$/.test(raw)) {
    const siren = raw.slice(0, 9);
    return siretValid(raw) ? { kind: 'siren', key: `FR:${siren}`, siren, country: 'FR' } : { kind: 'invalid' };
  }

  const prefix = raw.slice(0, 2);
  if (EU_VAT_PREFIXES.has(prefix) && /\d/.test(raw.slice(2))) {
    const number = raw.slice(2);
    if (prefix === 'FR') {
      // TVA française : clé (2 caractères) + SIREN. Même entreprise, même clé.
      const siren = number.slice(2);
      if (!/^\d{9}$/.test(siren) || !sirenValid(siren)) return { kind: 'invalid' };
      if (/^\d{2}$/.test(number.slice(0, 2)) && number.slice(0, 2) !== frVatKey(siren)) return { kind: 'invalid' };
      return { kind: 'eu_vat', key: `FR:${siren}`, country: 'FR', number };
    }
    return { kind: 'eu_vat', key: `${prefix}:${number}`, country: prefix, number };
  }

  return { kind: 'invalid' };
}

export type Verification =
  | { status: 'verified'; name: string }
  | { status: 'inactive'; name: string }
  | { status: 'not_found' }
  | { status: 'registry_down' }
  | { status: 'unreachable' }
  | { status: 'manual' };

const TIMEOUT_MS = 8000;

async function getJson(url: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

/** Interroge le registre officiel correspondant. Ne lève pas : un registre en panne rend `registry_down`. */
export async function verifyBusinessId(id: ParsedBusinessId): Promise<Verification> {
  try {
    if (id.kind === 'siren' || (id.kind === 'eu_vat' && id.country === 'FR')) {
      const siren = id.kind === 'siren' ? id.siren : id.number.slice(2);
      const r = await getJson(`https://recherche-entreprises.api.gouv.fr/search?q=${siren}&page=1&per_page=1`);
      if (!r.ok) return { status: 'registry_down' };
      const found = (
        (r.body as { results?: { siren?: string; nom_complet?: string; etat_administratif?: string }[] })?.results ?? []
      ).find((e) => e.siren === siren);
      if (!found) return { status: 'not_found' };
      const name = found.nom_complet ?? '';
      return found.etat_administratif === 'A' ? { status: 'verified', name } : { status: 'inactive', name };
    }
    if (id.kind === 'eu_vat') {
      const r = await getJson(
        `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${id.country}/vat/${encodeURIComponent(id.number)}`
      );
      const body = r.body as { isValid?: boolean; userError?: string; name?: string } | null;
      if (!r.ok || !body) return { status: 'registry_down' };
      if (body.isValid) return { status: 'verified', name: body.name && body.name !== '---' ? body.name : '' };
      // VIES distingue « numéro invalide » des indisponibilités d'un État membre.
      return body.userError === 'INVALID' || body.userError === 'INVALID_INPUT'
        ? { status: 'not_found' }
        : { status: 'registry_down' };
    }
    if (id.kind === 'website') {
      // Le site doit répondre (après redirections). Le contenu est jugé par
      // l'admin : un domaine qui existe ne prouve pas encore un studio.
      const res = await fetch(id.url, {
        redirect: 'follow',
        headers: { 'user-agent': 'AeroX-verification/1.0 (+https://aeroxbefaster.com)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => null);
      return res && res.status < 400 ? { status: 'manual' } : { status: 'unreachable' };
    }
    return { status: 'not_found' };
  } catch {
    return { status: 'registry_down' };
  }
}
