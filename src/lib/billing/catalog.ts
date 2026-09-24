// src/lib/billing/catalog.ts
//
// Catalogue Stripe des offres bike fitter : seule source de vérité des
// produits, prix et du meter. Lu par le script de synchronisation
// (`scripts/stripe-catalog.ts`) et par les routes serveur qui créent les
// sessions Checkout. Aucun identifiant `price_…` ni `prod_…` n'est écrit ici :
// tout passe par des `lookup_key` (prix) et une métadonnée `aerox_key`
// (produits), identiques en test et en live.
//
// Pas d'import dans ce fichier : il est exécuté tel quel par Node (type
// stripping) depuis le script, sans résolution des alias `~/`.

export const METER_EVENT_NAME = 'aerox_analysis';

export type MeterSpec = {
  event_name: string;
  display_name: string;
  // Somme des `value` envoyées : chaque analyse comptée envoie `value: 1`.
  formula: 'sum';
  customer_payload_key: string;
  value_payload_key: string;
};

export const METER: MeterSpec = {
  event_name: METER_EVENT_NAME,
  display_name: 'AeroX — analyses bike fitter',
  formula: 'sum',
  customer_payload_key: 'stripe_customer_id',
  value_payload_key: 'value',
};

// Code taxe Stripe : « Software as a service (SaaS) - electronic download -
// business use ». AeroX est une application téléchargée adossée à un service
// en ligne, vendue à des professionnels. Classification à confirmer par le
// comptable (voir BILLING.md) : la changer ici suffit, le script met à jour
// les produits.
export const PRODUCT_TAX_CODE = 'txcd_10103101';

// Icône AeroX affichée sur Checkout, les factures et le portail : la même que
// celle des autres produits du compte (Diagnostic, Early BikeFitter Program).
export const PRODUCT_IMAGE =
  'https://files.stripe.com/links/MDB8YWNjdF8xUmpIcFdBbXpvS3NCaUNOfGZsX2xpdmVfcXZTaGdVVW5iZ0tIZ0NScG9YcjJpY1Zi00JyhHhjAR';

export type ProductKey = 'bf_payg' | 'bf_studio' | 'bf_studio_usage' | 'bf_unlimited' | 'bf_unlimited_launch';

export type ProductSpec = {
  key: ProductKey;
  name: string;
  description: string;
};

export const PRODUCTS: ProductSpec[] = [
  {
    key: 'bf_payg',
    name: 'AeroX Bike Fit — À l’usage',
    description: 'Sans abonnement fixe : 20 € HT par analyse, facturé en fin de mois.',
  },
  {
    key: 'bf_studio',
    name: 'AeroX Bike Fit — Studio',
    description: 'Abonnement mensuel, 5 analyses incluses chaque mois.',
  },
  {
    key: 'bf_studio_usage',
    name: 'AeroX Bike Fit — Studio, analyses',
    description: 'Analyses du mois : les 5 premières sont incluses, puis 10 € HT l’analyse.',
  },
  {
    key: 'bf_unlimited',
    name: 'AeroX Bike Fit — Illimité',
    description: 'Analyses illimitées, au mois ou à l’année.',
  },
  {
    key: 'bf_unlimited_launch',
    name: 'AeroX Bike Fit — Illimité, offre de lancement',
    description: 'Analyses illimitées, tarif de lancement réservé aux 20 premiers studios.',
  },
];

export type Tier = { up_to: number | 'inf'; unit_amount: number };

export type PriceSpec = {
  lookup_key: string;
  product: ProductKey;
  nickname: string;
  currency: 'eur';
  tax_behavior: 'exclusive';
  // Montant en centimes pour un prix à l'unité ; absent pour un prix à paliers.
  unit_amount?: number;
  recurring?: { interval: 'month' | 'year'; usage_type: 'licensed' | 'metered' };
  // Prix mesuré : rattaché au meter `METER_EVENT_NAME`.
  metered?: boolean;
  tiers?: Tier[];
};

export const LOOKUP = {
  payg: 'aerox_bf_payg',
  studioBase: 'aerox_bf_studio_base',
  studioUsage: 'aerox_bf_studio_usage',
  unlimited: 'aerox_bf_unlimited',
  unlimitedYear: 'aerox_bf_unlimited_year',
  unlimitedLaunch: 'aerox_bf_unlimited_launch',
  // Prix vers lequel bascule l'offre de lancement au 01/01/2027, via le
  // subscription schedule posé par le webhook. Jamais vendu directement.
  unlimitedLaunchAfter: 'aerox_bf_unlimited_launch_after',
} as const;

// Clés d'anciens prix retirés de la grille (Pack) : le script archive les
// prix qui les portent encore. Aucun n'a été vendu.
export const RETIRED_LOOKUP_KEYS = ['aerox_bf_pack10', 'aerox_bf_pack15'];
// Produits retirés, archivés par le script.
export const RETIRED_PRODUCT_KEYS = ['bf_pack'];

export const PRICES: PriceSpec[] = [
  {
    lookup_key: LOOKUP.payg,
    product: 'bf_payg',
    nickname: 'À l’usage — 20 € HT par analyse',
    currency: 'eur',
    tax_behavior: 'exclusive',
    unit_amount: 2000,
    recurring: { interval: 'month', usage_type: 'metered' },
    metered: true,
  },
  {
    lookup_key: LOOKUP.studioBase,
    product: 'bf_studio',
    nickname: 'Studio — 79 € HT / mois',
    currency: 'eur',
    tax_behavior: 'exclusive',
    unit_amount: 7900,
    recurring: { interval: 'month', usage_type: 'licensed' },
  },
  {
    lookup_key: LOOKUP.studioUsage,
    product: 'bf_studio_usage',
    nickname: 'Studio — analyses (5 incluses, puis 10 € HT)',
    currency: 'eur',
    tax_behavior: 'exclusive',
    recurring: { interval: 'month', usage_type: 'metered' },
    metered: true,
    tiers: [
      { up_to: 5, unit_amount: 0 },
      { up_to: 'inf', unit_amount: 1000 },
    ],
  },
  {
    lookup_key: LOOKUP.unlimited,
    product: 'bf_unlimited',
    nickname: 'Illimité — 119 € HT / mois',
    currency: 'eur',
    tax_behavior: 'exclusive',
    unit_amount: 11900,
    recurring: { interval: 'month', usage_type: 'licensed' },
  },
  {
    lookup_key: LOOKUP.unlimitedYear,
    product: 'bf_unlimited',
    nickname: 'Illimité — 1 190 € HT / an (2 mois offerts)',
    currency: 'eur',
    tax_behavior: 'exclusive',
    unit_amount: 119000,
    recurring: { interval: 'year', usage_type: 'licensed' },
  },
  {
    lookup_key: LOOKUP.unlimitedLaunch,
    product: 'bf_unlimited_launch',
    nickname: 'Illimité lancement — 69 € HT / mois jusqu’au 31/12/2026',
    currency: 'eur',
    tax_behavior: 'exclusive',
    unit_amount: 6900,
    recurring: { interval: 'month', usage_type: 'licensed' },
  },
  {
    lookup_key: LOOKUP.unlimitedLaunchAfter,
    product: 'bf_unlimited_launch',
    nickname: 'Illimité lancement — 99 € HT / mois à partir du 01/01/2027',
    currency: 'eur',
    tax_behavior: 'exclusive',
    unit_amount: 9900,
    recurring: { interval: 'month', usage_type: 'licensed' },
  },
];

// Offre de lancement : 20 places, jusqu'au 31/12/2026 inclus (heure de Paris),
// bascule au 01/01/2027 00:00 heure de Paris = 2026-12-31T23:00:00Z.
export const LAUNCH_OFFER = {
  seats: 20,
  switchAt: Date.UTC(2026, 11, 31, 23, 0, 0),
} as const;

/** Forme minimale d'un prix Stripe existant, suffisante pour la comparaison. */
export type ExistingPrice = {
  product: string | { id: string };
  currency: string;
  unit_amount: number | null;
  tax_behavior: string | null;
  billing_scheme: string;
  tiers_mode?: string | null;
  tiers?: { up_to: number | null; unit_amount: number | null; flat_amount: number | null }[] | null;
  recurring: { interval: string; interval_count: number; usage_type: string; meter?: string | null } | null;
};

/**
 * Liste les écarts entre un prix Stripe existant et sa spécification.
 * Vide = le prix est conforme. Un prix Stripe est immuable sur ces champs :
 * tout écart impose d'en créer un nouveau et d'y transférer la `lookup_key`.
 */
export function priceDiffs(existing: ExistingPrice, spec: PriceSpec, productId: string, meterId?: string): string[] {
  const diffs: string[] = [];
  const existingProduct = typeof existing.product === 'string' ? existing.product : existing.product.id;
  if (existingProduct !== productId) diffs.push('product');
  if (existing.currency !== spec.currency) diffs.push('currency');
  if (existing.tax_behavior !== spec.tax_behavior) diffs.push('tax_behavior');

  if (spec.recurring) {
    const r = existing.recurring;
    if (!r || r.interval !== spec.recurring.interval || r.interval_count !== 1) diffs.push('recurring.interval');
    if (r && r.usage_type !== spec.recurring.usage_type) diffs.push('recurring.usage_type');
    if (spec.metered && (r?.meter ?? null) !== (meterId ?? null)) diffs.push('recurring.meter');
  } else if (existing.recurring) {
    diffs.push('recurring');
  }

  if (spec.tiers) {
    if (existing.billing_scheme !== 'tiered' || existing.tiers_mode !== 'graduated') diffs.push('tiers_mode');
    const want = spec.tiers.map((t) => `${t.up_to === 'inf' ? 'inf' : t.up_to}:${t.unit_amount}:0`);
    const got = (existing.tiers ?? []).map((t) => `${t.up_to ?? 'inf'}:${t.unit_amount ?? 0}:${t.flat_amount ?? 0}`);
    if (want.join('|') !== got.join('|')) diffs.push('tiers');
  } else {
    if (existing.billing_scheme !== 'per_unit') diffs.push('billing_scheme');
    if (existing.unit_amount !== spec.unit_amount) diffs.push('unit_amount');
  }
  return diffs;
}
