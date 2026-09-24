// src/lib/billing/server.ts
//
// Accès serveur partagés par les routes de facturation bike fitter et le
// webhook : client Stripe, client Supabase service_role, résolution des prix
// par lookup_key, client Stripe du bike fitter. Jamais importé côté navigateur.

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { SUPPORTED_LOCALES } from '~/lib/i18n';
import { OFFER_LOOKUP_KEYS, type Offer, type Plan, type BillingStatus } from './logic';

let stripeClient: Stripe | null = null;
export function stripe(): Stripe {
  stripeClient ??= new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);
  return stripeClient;
}

/** Client service_role : contourne RLS. Seules les routes serveur l'utilisent. */
export function supabaseAdmin(): SupabaseClient {
  return createClient(import.meta.env.SUPABASE_URL as string, import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });
}

export type BillingRow = {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: Plan;
  status: BillingStatus;
  grace_until: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function loadBilling(db: SupabaseClient, userId: string): Promise<BillingRow | null> {
  const { data, error } = await db.from('bf_billing').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`bf_billing: ${error.message}`);
  return data as BillingRow | null;
}

/** Rôle applicatif (`users.role`) : seuls bike fitters et admins achètent une offre BF. */
export async function loadRole(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db.from('users').select('role').eq('id', userId).maybeSingle();
  if (error) throw new Error(`users: ${error.message}`);
  return (data?.role as string | undefined) ?? null;
}

/** Identifiants de prix actifs d'une offre, dans l'ordre de `OFFER_LOOKUP_KEYS`. */
export async function priceIdsFor(offer: Offer): Promise<string[]> {
  const keys = OFFER_LOOKUP_KEYS[offer];
  const prices = await stripe().prices.list({ lookup_keys: keys, active: true, limit: keys.length });
  return keys.map((k) => {
    const p = prices.data.find((x) => x.lookup_key === k);
    if (!p) throw new Error(`aucun prix actif pour la lookup_key ${k}`);
    return p.id;
  });
}

export async function priceIdForLookup(lookupKey: string): Promise<string> {
  const prices = await stripe().prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (!prices.data[0]) throw new Error(`aucun prix actif pour la lookup_key ${lookupKey}`);
  return prices.data[0].id;
}

/**
 * Client Stripe du bike fitter, créé au premier achat. Un seul client par
 * compte : factures, TVA et portail sont rattachés au même objet. La clé
 * d'idempotence évite deux clients si deux onglets lancent un paiement en
 * même temps.
 */
export async function ensureCustomer(db: SupabaseClient, user: User, billing: BillingRow | null): Promise<string> {
  if (billing?.stripe_customer_id) return billing.stripe_customer_id;

  const customer = await stripe().customers.create(
    { email: user.email ?? undefined, metadata: { userId: user.id } },
    { idempotencyKey: `aerox-bf-customer-${user.id}` }
  );
  // Upsert sur la seule colonne client : une ligne manquante naît avec les
  // valeurs par défaut (essai), une ligne existante garde son offre.
  const { error } = await db
    .from('bf_billing')
    .upsert({ user_id: user.id, stripe_customer_id: customer.id }, { onConflict: 'user_id' });
  if (error) throw new Error(`bf_billing (client Stripe): ${error.message}`);
  return customer.id;
}

export async function launchSeatsRemaining(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc('bf_launch_seats_remaining');
  if (error) throw new Error(`bf_launch_seats_remaining: ${error.message}`);
  return data as number;
}

/** Langue validée : elle entre dans une URL de retour (voir create-api-checkout). */
export function safeLang(raw: unknown): string {
  return typeof raw === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(raw) ? raw : 'fr';
}

/**
 * Base des URL de retour : configuration d'abord, jamais l'en-tête `Host`
 * de l'appelant sauf en local (voir create-api-checkout).
 */
export function siteBase(request: Request, site: URL | undefined): string {
  const envBase = ((import.meta.env.PUBLIC_SITE_URL as string | undefined) || '').split('#')[0];
  return envBase || site?.origin || new URL(request.url).origin;
}

/** Espace bike fitter, où l'on revient après Checkout ou le portail. */
export function accountUrl(base: string, lang: string, billingState?: string): string {
  const url = new URL(`/${lang}/inscription/dashboard/`, base);
  if (billingState) url.searchParams.set('billing', billingState);
  return url.toString();
}

/** Configuration du portail client créée par `scripts/stripe-catalog.ts`. */
let portalConfigId: string | null = null;
export async function portalConfiguration(): Promise<string | undefined> {
  if (portalConfigId) return portalConfigId;
  for await (const c of stripe().billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (c.metadata?.aerox_key === 'bf_portal') {
      portalConfigId = c.id;
      return c.id;
    }
  }
  return undefined;
}
