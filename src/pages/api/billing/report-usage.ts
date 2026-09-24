// src/pages/api/billing/report-usage.ts
//
// Envoie à Stripe les meter events des analyses Studio en attente.
//
// Appelée par la base, jamais par un navigateur :
//  - le trigger `trg_bf_analysis_meter_notify` à chaque analyse Studio ;
//  - le job pg_cron `bf-report-usage` toutes les 10 minutes (rejeu).
// Authentifiée par l'en-tête `x-billing-hook-secret` (secret Vault
// `billing_hook_secret` = variable Vercel `BILLING_HOOK_SECRET`).
//
// Idempotence : chaque appel réserve son lot (bf_claim_meter_batch), et
// l'`identifier` du meter event est l'id de l'analyse : même un envoi rejoué
// après une réservation expirée est dédoublonné par Stripe.
export const prerender = false;

import type { APIRoute } from 'astro';
import { METER_EVENT_NAME } from '~/lib/billing/catalog';
import { json, stripe, supabaseAdmin } from '~/lib/billing/server';

const BATCH = 100;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Erreur Stripe signalant un identifier déjà reçu : l'événement est déjà compté. */
function isDuplicateIdentifier(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /identifier/i.test(message) && /already|duplicate|exists/i.test(message);
}

export const POST: APIRoute = async ({ request }) => {
  const expected = import.meta.env.BILLING_HOOK_SECRET as string | undefined;
  const given = request.headers.get('x-billing-hook-secret') ?? '';
  if (!expected || !timingSafeEqual(given, expected)) return json({ error: 'E_AUTH' }, 403);

  const db = supabaseAdmin();
  // Lot réservé à cet appel : les appels concurrents se partagent la file au
  // lieu de la renvoyer chacun en entier (voir bf_claim_meter_batch).
  const { data: pending, error } = await db.rpc('bf_claim_meter_batch', { p_limit: BATCH });
  if (error) {
    console.error('report-usage: réservation impossible —', error.message);
    return json({ error: 'E_DB' }, 500);
  }
  if (!pending?.length) return json({ sent: 0 });

  let sent = 0;
  let failed = 0;
  for (const a of pending as { id: string; counted_at: string; stripe_customer_id: string | null }[]) {
    const customer = a.stripe_customer_id;
    let reportError: string | null = null;
    if (!customer) {
      reportError = 'aucun client Stripe pour ce bike fitter';
    } else {
      try {
        await stripe().billing.meterEvents.create({
          event_name: METER_EVENT_NAME,
          identifier: a.id as string,
          // Horodatage de l'analyse : un rejeu tardif tombe dans la bonne période.
          timestamp: Math.floor(new Date(a.counted_at as string).getTime() / 1000),
          payload: { stripe_customer_id: customer, value: '1' },
        });
      } catch (err) {
        if (!isDuplicateIdentifier(err)) reportError = err instanceof Error ? err.message : String(err);
      }
    }

    const { error: markError } = await db.rpc('bf_mark_meter_reported', { p_id: a.id, p_error: reportError });
    if (markError) console.error('report-usage: marquage impossible —', a.id, markError.message);
    if (reportError) {
      failed++;
      console.error('report-usage: meter event non envoyé —', a.id, reportError);
    } else {
      sent++;
    }
  }
  return json({ sent, failed });
};
