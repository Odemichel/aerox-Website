// src/lib/igDmEvents.ts
//
// Attribution Instagram (table ig_dm_events) : arrivée par un lien de DM ou par
// le lien de la bio (`medium`) et conversions qui suivent, rattachées au reel ou
// au lien (`content`) et à la ressource (`campaign`). Aucune donnée personnelle.

export const IG_DM_KINDS = ['visit', 'calc', 'book', 'signup'] as const;
export const IG_DM_MEDIUMS = ['dm', 'bio'] as const;
export const IG_DM_CAMPAIGNS = ['calculator', 'guide', 'signup', 'bio'] as const;
export const IG_DM_CONTENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type IgDmEvent = {
  medium: (typeof IG_DM_MEDIUMS)[number];
  kind: (typeof IG_DM_KINDS)[number];
  campaign: (typeof IG_DM_CAMPAIGNS)[number];
  content: string;
};

/** Événement valide, ou `null` (corps refusé sans détail). */
export function validateIgDmEvent(input: unknown): IgDmEvent | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { kind, campaign, content } = input as Record<string, unknown>;
  // anciens envois sans `medium` : un DM
  const medium = (input as Record<string, unknown>).medium ?? 'dm';
  if (!(IG_DM_MEDIUMS as readonly unknown[]).includes(medium)) return null;
  if (!(IG_DM_KINDS as readonly unknown[]).includes(kind)) return null;
  if (!(IG_DM_CAMPAIGNS as readonly unknown[]).includes(campaign)) return null;
  if (typeof content !== 'string' || !IG_DM_CONTENT.test(content)) return null;
  return {
    medium: medium as IgDmEvent['medium'],
    kind: kind as IgDmEvent['kind'],
    campaign: campaign as IgDmEvent['campaign'],
    content,
  };
}

/**
 * Robots qui ouvrent les liens (contrôle des liens de bio par Meta, aperçus,
 * navigateurs automatisés) : ils exécutent la page sans être des visiteurs.
 * Vercel Web Analytics les écarte déjà ; on fait de même avant d'écrire.
 */
export const IG_BOT_UA =
  /bot|crawl|spider|slurp|headless|externalhit|external-?agent|facebookcatalog|preview|lighthouse|phantom|puppeteer|playwright|selenium/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  return !ua || IG_BOT_UA.test(ua);
}
