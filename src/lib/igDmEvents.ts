// src/lib/igDmEvents.ts
//
// Attribution des DM Instagram (table ig_dm_events) : arrivée par un lien de DM
// et conversions qui suivent, rattachées au reel (`content`) et à la ressource
// (`campaign`). Aucune donnée personnelle.

export const IG_DM_KINDS = ['visit', 'calc', 'book', 'signup'] as const;
export const IG_DM_CAMPAIGNS = ['calculator', 'guide', 'signup'] as const;
export const IG_DM_CONTENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type IgDmEvent = {
  kind: (typeof IG_DM_KINDS)[number];
  campaign: (typeof IG_DM_CAMPAIGNS)[number];
  content: string;
};

/** Événement valide, ou `null` (corps refusé sans détail). */
export function validateIgDmEvent(input: unknown): IgDmEvent | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { kind, campaign, content } = input as Record<string, unknown>;
  if (!(IG_DM_KINDS as readonly unknown[]).includes(kind)) return null;
  if (!(IG_DM_CAMPAIGNS as readonly unknown[]).includes(campaign)) return null;
  if (typeof content !== 'string' || !IG_DM_CONTENT.test(content)) return null;
  return { kind: kind as IgDmEvent['kind'], campaign: campaign as IgDmEvent['campaign'], content };
}
