// scripts/stripe-catalog.ts
//
// Crée ou met à jour le catalogue Stripe des offres bike fitter, décrit dans
// `src/lib/billing/catalog.ts`. Idempotent : relancé sur un compte déjà à jour,
// il ne crée rien.
//
//   node --env-file=.env scripts/stripe-catalog.ts            # applique (clé test)
//   node --env-file=.env scripts/stripe-catalog.ts --dry-run  # affiche seulement
//   node --env-file=.env.live scripts/stripe-catalog.ts --live  # compte live
//
// Garde-fou : une clé `sk_live_` / `rk_live_` est refusée sans `--live`, et
// `--live` est refusé avec une clé de test. On ne bascule pas de mode par
// accident en changeant de fichier d'environnement.
//
// Identification des objets :
//  - produits : métadonnée `aerox_key` (Stripe n'a pas de lookup_key produit) ;
//  - meter    : `event_name`, unique par compte ;
//  - prix     : `lookup_key`. Un prix Stripe est immuable (montant, paliers,
//    récurrence) : en cas d'écart, un nouveau prix est créé avec
//    `transfer_lookup_key` et l'ancien est archivé. Les abonnements existants
//    gardent leur ancien prix, seules les nouvelles souscriptions changent.

import Stripe from 'stripe';
import {
  METER,
  PRICES,
  PRODUCTS,
  PRODUCT_IMAGE,
  PRODUCT_TAX_CODE,
  RETIRED_LOOKUP_KEYS,
  RETIRED_PRODUCT_KEYS,
  priceDiffs,
} from '../src/lib/billing/catalog.ts';
import type { PriceSpec, ProductKey } from '../src/lib/billing/catalog.ts';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const LIVE = args.has('--live');

const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!key) {
  console.error('STRIPE_SECRET_KEY absent. Lancer avec `node --env-file=.env scripts/stripe-catalog.ts`.');
  process.exit(1);
}
const keyIsLive = /^(sk|rk)_live_/.test(key);
if (keyIsLive && !LIVE) {
  console.error('Clé LIVE détectée sans --live : arrêt. Rien n’a été modifié.');
  process.exit(1);
}
if (!keyIsLive && LIVE) {
  console.error('--live demandé avec une clé de test : arrêt.');
  process.exit(1);
}

const stripe = new Stripe(key);
const mode = keyIsLive ? 'LIVE' : 'test';
const log = (msg: string) => console.log(`[${mode}${DRY_RUN ? ' dry-run' : ''}] ${msg}`);

async function syncMeter(): Promise<string | undefined> {
  const meters = await stripe.billing.meters.list({ status: 'active', limit: 100 });
  const existing = meters.data.find((m) => m.event_name === METER.event_name);

  if (existing) {
    // L'agrégation et le mapping sont figés à la création : un écart ne se
    // corrige pas par mise à jour, il faut une intervention manuelle.
    const problems: string[] = [];
    if (existing.default_aggregation.formula !== METER.formula) problems.push('formula');
    if (existing.customer_mapping.event_payload_key !== METER.customer_payload_key) problems.push('customer_mapping');
    if (existing.value_settings.event_payload_key !== METER.value_payload_key) problems.push('value_settings');
    if (problems.length) {
      throw new Error(`Meter ${existing.id} non conforme (${problems.join(', ')}) : correction manuelle requise.`);
    }
    if (existing.display_name !== METER.display_name) {
      log(`meter ${existing.id} : renommage`);
      if (!DRY_RUN) await stripe.billing.meters.update(existing.id, { display_name: METER.display_name });
    } else {
      log(`meter ${existing.id} (${METER.event_name}) : à jour`);
    }
    return existing.id;
  }

  log(`meter ${METER.event_name} : création`);
  if (DRY_RUN) return undefined;
  const created = await stripe.billing.meters.create({
    display_name: METER.display_name,
    event_name: METER.event_name,
    default_aggregation: { formula: METER.formula },
    customer_mapping: { event_payload_key: METER.customer_payload_key, type: 'by_id' },
    value_settings: { event_payload_key: METER.value_payload_key },
  });
  return created.id;
}

async function syncProducts(): Promise<Map<ProductKey, string>> {
  const ids = new Map<ProductKey, string>();
  const all: Stripe.Product[] = [];
  for await (const p of stripe.products.list({ limit: 100 })) all.push(p);

  for (const spec of PRODUCTS) {
    const existing = all.find((p) => p.metadata?.aerox_key === spec.key);
    if (!existing) {
      log(`produit ${spec.key} : création`);
      if (DRY_RUN) {
        ids.set(spec.key, `<nouveau ${spec.key}>`);
        continue;
      }
      const created = await stripe.products.create({
        name: spec.name,
        description: spec.description,
        tax_code: PRODUCT_TAX_CODE,
        images: [PRODUCT_IMAGE],
        metadata: { aerox_key: spec.key },
      });
      ids.set(spec.key, created.id);
      continue;
    }

    ids.set(spec.key, existing.id);
    const taxCode = typeof existing.tax_code === 'string' ? existing.tax_code : existing.tax_code?.id;
    const stale =
      existing.name !== spec.name ||
      existing.description !== spec.description ||
      taxCode !== PRODUCT_TAX_CODE ||
      existing.images?.[0] !== PRODUCT_IMAGE ||
      !existing.active;
    if (stale) {
      log(`produit ${spec.key} (${existing.id}) : mise à jour`);
      if (!DRY_RUN) {
        await stripe.products.update(existing.id, {
          name: spec.name,
          description: spec.description,
          tax_code: PRODUCT_TAX_CODE,
          images: [PRODUCT_IMAGE],
          active: true,
        });
      }
    } else {
      log(`produit ${spec.key} (${existing.id}) : à jour`);
    }
  }
  return ids;
}

function priceParams(spec: PriceSpec, productId: string, meterId: string | undefined): Stripe.PriceCreateParams {
  const params: Stripe.PriceCreateParams = {
    product: productId,
    currency: spec.currency,
    nickname: spec.nickname,
    lookup_key: spec.lookup_key,
    // Sans effet quand aucun prix ne porte encore la clé ; sinon, retire la
    // clé à l'ancien prix pour la donner au nouveau.
    transfer_lookup_key: true,
    tax_behavior: spec.tax_behavior,
  };
  if (spec.recurring) {
    params.recurring = { interval: spec.recurring.interval, usage_type: spec.recurring.usage_type };
    if (spec.metered) {
      if (!meterId) throw new Error(`Prix ${spec.lookup_key} : meter introuvable.`);
      params.recurring.meter = meterId;
    }
  }
  if (spec.tiers) {
    params.billing_scheme = 'tiered';
    params.tiers_mode = 'graduated';
    params.tiers = spec.tiers.map((t) => ({ up_to: t.up_to, unit_amount: t.unit_amount }));
  } else {
    params.unit_amount = spec.unit_amount;
  }
  return params;
}

async function syncPrices(products: Map<ProductKey, string>, meterId: string | undefined) {
  for (const spec of PRICES) {
    const productId = products.get(spec.product)!;
    const found = await stripe.prices.list({ lookup_keys: [spec.lookup_key], expand: ['data.tiers'], limit: 1 });
    const existing = found.data[0];

    if (existing) {
      const diffs = priceDiffs(existing, spec, productId, meterId);
      if (!diffs.length) {
        if (!existing.active) {
          log(`prix ${spec.lookup_key} (${existing.id}) : réactivation`);
          if (!DRY_RUN) await stripe.prices.update(existing.id, { active: true });
        } else if (existing.nickname !== spec.nickname) {
          log(`prix ${spec.lookup_key} (${existing.id}) : libellé mis à jour`);
          if (!DRY_RUN) await stripe.prices.update(existing.id, { nickname: spec.nickname });
        } else {
          log(`prix ${spec.lookup_key} (${existing.id}) : à jour`);
        }
        continue;
      }
      log(`prix ${spec.lookup_key} (${existing.id}) : écart [${diffs.join(', ')}] → nouveau prix, ancien archivé`);
      if (DRY_RUN) continue;
      const created = await stripe.prices.create(priceParams(spec, productId, meterId));
      await stripe.prices.update(existing.id, { active: false });
      log(`prix ${spec.lookup_key} : ${created.id}`);
      continue;
    }

    log(`prix ${spec.lookup_key} : création`);
    if (DRY_RUN) continue;
    const created = await stripe.prices.create(priceParams(spec, productId, meterId));
    log(`prix ${spec.lookup_key} : ${created.id}`);
  }
}

// Portail client : factures, moyen de paiement, coordonnées et n° de TVA,
// résiliation en fin de période. Pas de changement d'offre ici : le portail
// ne sait pas modifier un abonnement Studio (usage mesuré) ni un abonnement
// piloté par un schedule — c'est /api/billing/manage/ qui s'en charge.
const PORTAL: Stripe.BillingPortal.ConfigurationCreateParams = {
  business_profile: { headline: 'AeroX — votre abonnement bike fitter' },
  features: {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ['name', 'email', 'address', 'tax_id'] },
    subscription_cancel: { enabled: true, mode: 'at_period_end' },
    subscription_update: { enabled: false },
  },
  metadata: { aerox_key: 'bf_portal' },
};

async function syncPortal() {
  let existing: Stripe.BillingPortal.Configuration | undefined;
  for await (const c of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (c.metadata?.aerox_key === 'bf_portal') existing = c;
  }
  if (!existing) {
    log('portail client : création');
    if (!DRY_RUN) log(`portail client : ${(await stripe.billingPortal.configurations.create(PORTAL)).id}`);
    return;
  }
  // La mise à jour est rejouée à chaque passage : elle est sans effet si rien
  // n'a changé, et comparer champ par champ n'apporterait rien.
  log(`portail client (${existing.id}) : réappliqué`);
  if (!DRY_RUN) await stripe.billingPortal.configurations.update(existing.id, PORTAL);
}

async function archiveRetiredPrices() {
  for (const key of RETIRED_LOOKUP_KEYS) {
    const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 10 });
    for (const p of found.data) {
      log(`prix retiré ${key} (${p.id}) : archivage`);
      if (!DRY_RUN) await stripe.prices.update(p.id, { active: false });
    }
  }
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (!RETIRED_PRODUCT_KEYS.includes(product.metadata?.aerox_key ?? '')) continue;
    log(`produit retiré ${product.metadata.aerox_key} (${product.id}) : archivage`);
    if (!DRY_RUN) await stripe.products.update(product.id, { active: false });
  }
}

async function checkTaxSettings() {
  // Lecture seule : Stripe Tax (adresse d'origine, immatriculations) se règle
  // une fois pour toutes, et `automatic_tax` échoue au Checkout tant qu'il
  // n'est pas actif. On signale, on ne configure pas.
  try {
    const settings = await stripe.tax.settings.retrieve();
    if (settings.status === 'active') log('Stripe Tax : actif');
    else log(`⚠ Stripe Tax : statut « ${settings.status} » — à compléter dans le tableau de bord (Réglages > Taxes)`);
  } catch (err) {
    log(`⚠ Stripe Tax : lecture impossible (${err instanceof Error ? err.message : err})`);
  }
}

const meterId = await syncMeter();
const products = await syncProducts();
await syncPrices(products, meterId);
await archiveRetiredPrices();
await syncPortal();
await checkTaxSettings();
log('terminé');
