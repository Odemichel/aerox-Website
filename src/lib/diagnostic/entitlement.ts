// src/lib/diagnostic/entitlement.ts
//
// Un seul Diagnostic AeroX à la fois par cycliste : tant qu'un achat payé
// n'est pas utilisé, ou qu'un diagnostic est en cours, on n'en vend pas un
// second. Lu par la route de paiement (refus avant Stripe) et par le webhook
// (filet de sécurité : deux pages de paiement payées en parallèle).
//
// Serveur uniquement : client service_role (lecture des tables du diagnostic,
// migrations du dépôt veloaero).

import type { SupabaseClient } from '@supabase/supabase-js';

export async function hasActiveDiagnostic(db: SupabaseClient, userId: string): Promise<boolean> {
  const [unused, running] = await Promise.all([
    db
      .from('diagnostic_purchases')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('consumed_at', null)
      .is('refunded_at', null),
    db
      .from('diagnostic_basic')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'in_progress')
      .gt('expires_at', new Date().toISOString()),
  ]);
  if (unused.error) throw new Error(`diagnostic_purchases: ${unused.error.message}`);
  if (running.error) throw new Error(`diagnostic_basic: ${running.error.message}`);
  return (unused.count ?? 0) > 0 || (running.count ?? 0) > 0;
}
