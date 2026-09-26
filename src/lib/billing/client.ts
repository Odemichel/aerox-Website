// src/lib/billing/client.ts
//
// Côté navigateur : appels aux routes /api/billing/* avec le jeton de la
// session Supabase. Le corps ne porte que l'offre et la langue ; le serveur
// décide du prix et de l'utilisateur (voir src/pages/api/billing/checkout.ts).

import { supabase } from '~/config/supabaseClient';
import type { Offer } from './logic';

export type BillingError =
  | 'E_AUTH'
  | 'E_HAS_SUBSCRIPTION'
  | 'E_LAUNCH_CLOSED'
  | 'E_ROLE'
  | 'E_TRIAL_UNAVAILABLE'
  | 'E_SERVER';

/**
 * Inscription bike fitter avec retour prévu. `encodeURIComponent` : un `#`
 * non encodé deviendrait le fragment de l'URL d'inscription au lieu de faire
 * partie du paramètre (voir PricingSection.astro).
 */
export function bikeFitterSignupUrl(lang: string, back: string): string {
  return `/${lang}/inscription/inscription/?profil=bike-fitter&redirect=${encodeURIComponent(back)}`;
}

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token ?? null;
}

async function post(
  path: string,
  body: unknown
): Promise<
  | { ok: true; data: { url?: string; effective?: string; at?: number } & Record<string, unknown> }
  | { ok: false; error: BillingError }
> {
  const token = await accessToken();
  if (!token) return { ok: false, error: 'E_AUTH' };
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return { ok: false, error: 'E_AUTH' };
    if (!res.ok) return { ok: false, error: (data?.error as BillingError) ?? 'E_SERVER' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'E_SERVER' };
  }
}

/** Démarre Checkout. En cas de succès, le navigateur quitte la page. */
export async function startCheckout(offer: Offer, lang: string): Promise<BillingError | null> {
  const r = await post('/api/billing/checkout/', { offer, lang });
  if (r.ok === false) return r.error;
  if (!r.data?.url) return 'E_SERVER';
  window.location.href = r.data.url;
  return null;
}

export type BusinessIdResult =
  | 'granted'
  | 'pending_review'
  | 'already_used'
  | 'already_granted'
  | 'invalid'
  | 'not_found'
  | 'inactive'
  | 'registry_down';

/**
 * Identifiant d'entreprise qui ouvre les analyses offertes (« tester AeroX
 * maintenant »). Vérifié côté serveur auprès du registre officiel.
 */
export async function submitBusinessId(
  id: string
): Promise<{ error: BillingError } | { result: BusinessIdResult; name?: string }> {
  const r = await post('/api/billing/business-id/', { id });
  if (r.ok === false) return { error: r.error };
  const data = r.data as { result?: BusinessIdResult; name?: string };
  return data.result ? { result: data.result, name: data.name } : { error: 'E_SERVER' };
}

export async function openPortal(lang: string): Promise<BillingError | null> {
  const r = await post('/api/billing/portal/', { lang });
  if (r.ok === false) return r.error;
  if (!r.data?.url) return 'E_SERVER';
  window.location.href = r.data.url;
  return null;
}

/**
 * Change d'offre, résilie, reprend un abonnement résilié ou annule une
 * descente programmée (`keep`). `effectiveAt` (secondes) est posé quand le
 * changement est une descente, appliquée à la fin de la période payée.
 */
export async function manageSubscription(
  action: 'change' | 'cancel' | 'resume' | 'keep',
  offer?: Offer
): Promise<{ error: BillingError | null; effectiveAt?: number }> {
  const r = await post('/api/billing/manage/', { action, offer });
  if (r.ok === false) return { error: r.error };
  return { error: null, effectiveAt: r.data.effective === 'period_end' ? r.data.at : undefined };
}
