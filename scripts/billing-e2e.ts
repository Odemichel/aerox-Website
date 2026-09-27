// scripts/billing-e2e.ts
//
// Tests de bout en bout de la facturation bike fitter, en mode test Stripe,
// contre une base Supabase LOCALE et le site lancé en local.
//
// Prérequis (voir BILLING.md, « Tests de bout en bout ») :
//  - `supabase start` + socle + migrations bf_* appliqués ;
//  - `stripe listen --forward-to http://localhost:4399/api/stripe-webhook/` ;
//  - `astro dev --port 4399` avec les variables pointant sur la base locale ;
//  - Stripe Tax actif en mode test (siège + immatriculation FR).
//
//   E2E_SUPABASE_URL=… E2E_SUPABASE_ANON_KEY=… E2E_SUPABASE_SERVICE_KEY=… \
//   E2E_SITE_URL=http://localhost:4399 node --env-file=.env scripts/billing-e2e.ts [s1 s2 …]
//
// Le Stripe CLI est piloté avec la même clé (STRIPE_API_KEY) : son compte par
// défaut peut être un autre environnement que la sandbox du `.env`.
//
// Garde-fous : refuse une clé Stripe live et toute base Supabase qui n'est pas
// locale (127.0.0.1 / localhost). Les objets Stripe créés portent la
// métadonnée `aerox_e2e=1` et sont rattachés à des test clocks.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { BF_AVAILABLE_AT, LAUNCH_OFFER, LOOKUP } from '../src/lib/billing/catalog.ts';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`variable ${k} manquante`);
  return v;
};

const STRIPE_KEY = env('STRIPE_SECRET_KEY');
if (!STRIPE_KEY.startsWith('sk_test_')) throw new Error('Clé Stripe non test : arrêt.');
const SUPABASE_URL = env('E2E_SUPABASE_URL');
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(SUPABASE_URL)) throw new Error('Base Supabase non locale : arrêt.');
const SITE = env('E2E_SITE_URL');

const stripe = new Stripe(STRIPE_KEY);
const admin = createClient(SUPABASE_URL, env('E2E_SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } });
const ANON_KEY = env('E2E_SUPABASE_ANON_KEY');

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

const RUN = Date.now().toString(36);
let failures = 0;
const results: string[] = [];

function check(cond: boolean, label: string, detail = '') {
  const line = `${cond ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  results.push(line);
  if (!cond) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`délai dépassé : ${label}`);
    await sleep(1000);
  }
}

type Bf = { id: string; email: string; client: SupabaseClient; token: string };

/** Bike fitter inscrit comme sur le site : création puis confirmation d'e-mail. */
async function createBf(tag: string, verified = true): Promise<Bf> {
  const email = `bf-${tag}-${RUN}@example.com`;
  const password = `Test-${RUN}-A1`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    user_metadata: { profile_type: 'bike-fitter', studio_name: `Studio ${tag}` },
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  // La confirmation déclenche handle_email_confirmed (UPDATE sur auth.users).
  await admin.auth.admin.updateUserById(data.user.id, { email_confirm: true });
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: s, error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2 || !s.session) throw new Error(`signIn: ${e2?.message}`);
  // Entreprise vérifiée (SIRET, TVA ou site validé) : la souscription avec
  // essai est autorisée. S8 et S24 passent par la vraie vérification.
  if (verified) await admin.from('bf_billing').update({ trial_state: 'granted' }).eq('user_id', data.user.id);
  return { id: data.user.id, email, client, token: s.session.access_token };
}

async function createClients(bf: Bf, n: number): Promise<string[]> {
  const rows = Array.from({ length: n }, (_, i) => ({ bf_user_id: bf.id, firstname: `Client ${i + 1}` }));
  const { data, error } = await admin.from('bf_clients').insert(rows).select('id');
  if (error) throw new Error(`bf_clients: ${error.message}`);
  return data.map((r) => r.id as string);
}

async function register(bf: Bf, clientId: string) {
  const { data, error } = await bf.client.rpc('register_analysis', { p_client_id: clientId });
  if (error) throw new Error(`register_analysis: ${error.message}`);
  return data as { status: string; reason?: string; plan?: string; credits_remaining?: number };
}

async function billing(userId: string) {
  const { data } = await admin.from('bf_billing').select('*').eq('user_id', userId).maybeSingle();
  return data as Record<string, string | null> | null;
}

async function priceId(lookup: string) {
  const p = await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 });
  if (!p.data[0]) throw new Error(`prix ${lookup} introuvable (lancer scripts/stripe-catalog.ts)`);
  return p.data[0].id;
}

async function api(path: string, bf: Bf, body: unknown) {
  const res = await fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bf.token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, string | undefined> };
}

/** Client Stripe sur test clock, avec carte et adresse (Stripe Tax), relié au BF. */
async function clockCustomer(bf: Bf, frozenTime: number, pm = 'pm_card_visa') {
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: frozenTime, name: `e2e ${bf.email}` });
  const customer = await stripe.customers.create({
    email: bf.email,
    test_clock: clock.id,
    address: { line1: '1 rue de la Paix', city: 'Paris', postal_code: '75002', country: 'FR' },
    metadata: { userId: bf.id, aerox_e2e: '1' },
  });
  const method = await stripe.paymentMethods.attach(pm, { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: method.id } });
  await admin.from('bf_billing').update({ stripe_customer_id: customer.id }).eq('user_id', bf.id);
  return { clock, customer };
}

async function advance(clockId: string, to: number) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  await waitFor(
    `test clock ${clockId}`,
    async () => {
      const c = await stripe.testHelpers.testClocks.retrieve(clockId);
      return c.status === 'ready';
    },
    180_000
  );
}

/** Avance une horloge par pas de 30 jours max (limite Stripe : 2 intervalles). */
async function advanceStepwise(clockId: string, to: number) {
  let c = await stripe.testHelpers.testClocks.retrieve(clockId);
  while (c.frozen_time < to) {
    const next = Math.min(to, c.frozen_time + 30 * 86400);
    await advance(clockId, next);
    c = await stripe.testHelpers.testClocks.retrieve(clockId);
  }
}

/** Relance l'envoi des meter events en attente (route appelée par pg_net / pg_cron). */
async function reportUsage() {
  const res = await fetch(`${SITE}/api/billing/report-usage/`, {
    method: 'POST',
    headers: { 'x-billing-hook-secret': env('E2E_BILLING_HOOK_SECRET') },
  });
  if (!res.ok) throw new Error(`report-usage: HTTP ${res.status}`);
}

const metadata = (bf: Bf, offer: string) => ({ userId: bf.id, aerox_offer: offer, aerox_e2e: '1' });

// ---------------------------------------------------------------------------
// Scénarios
// ---------------------------------------------------------------------------

/** Abonnement de test (test clock), comme Checkout le créerait. */
async function clockSubscription(
  bf: Bf,
  offer: string,
  lookups: string[],
  start = Math.floor(Date.now() / 1000) - 3600
) {
  const { clock, customer } = await clockCustomer(bf, start);
  const metered = [LOOKUP.essentialUsage] as string[];
  const items = [];
  for (const key of lookups)
    items.push(metered.includes(key) ? { price: await priceId(key) } : { price: await priceId(key), quantity: 1 });
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items,
    metadata: metadata(bf, offer),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
  });
  return { clock, customer, sub };
}

/** Enregistre des analyses, envoie l'usage, puis clôt la période et renvoie la facture. */
async function usageInvoice(bf: Bf, clockId: string, sub: Stripe.Subscription, analyses: number) {
  const clients = await createClients(bf, analyses);
  for (const c of clients) await register(bf, c);
  // Stripe refuse un meter event daté après l'heure du test clock du client :
  // on amène l'horloge à l'heure réelle, puis on relance l'envoi (ce que fait
  // le job pg_cron toutes les 10 minutes en production).
  await advance(clockId, Math.floor(Date.now() / 1000) + 120);
  await reportUsage();
  await waitFor(
    'meter events envoyés',
    async () => {
      const { count: pending } = await admin
        .from('bf_analyses')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', bf.id)
        .is('meter_reported_at', null);
      return pending === 0;
    },
    90_000
  );
  const { data: errors } = await admin
    .from('bf_analyses')
    .select('meter_last_error')
    .eq('user_id', bf.id)
    .not('meter_last_error', 'is', null);
  check(!errors?.length, `${analyses} meter events envoyés sans erreur`, errors?.[0]?.meter_last_error ?? '');
  // Agrégation asynchrone des meter events chez Stripe : la facture de fin de
  // période ne compte que l'usage déjà agrégé (S1 facturé 0 € avec une
  // attente fixe de 20 s). On attend que le meter voie toutes les analyses.
  const meter = (await stripe.billing.meters.list({ status: 'active', limit: 20 })).data.find(
    (m) => m.event_name === 'aerox_analysis'
  )!;
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const clockNow = (await stripe.testHelpers.testClocks.retrieve(clockId)).frozen_time;
  await waitFor(
    'usage agrégé par Stripe',
    async () => {
      const summaries = await stripe.billing.meters.listEventSummaries(meter.id, {
        customer,
        start_time: sub.items.data[0].current_period_start - (sub.items.data[0].current_period_start % 60),
        end_time: clockNow - (clockNow % 60),
      });
      const total = summaries.data.reduce((a, x) => a + x.aggregated_value, 0);
      return total >= analyses;
    },
    180_000
  );
  await advance(clockId, sub.items.data[0].current_period_end + 2 * 3600);
  return waitFor('facture de fin de période', async () => {
    const list = await stripe.invoices.list({ subscription: sub.id, limit: 5 });
    return list.data.find((i) => i.billing_reason === 'subscription_cycle');
  });
}

async function s1Essential() {
  console.log('\nS1 — Essentiel : essai réservé aux entreprises vérifiées ; 3 analyses → 20 € + 3 × 15 € = 65 € HT');
  const unverified = await createBf('essential-unverified', false);
  const b0 = await billing(unverified.id);
  check(
    b0?.plan === 'trial' && b0?.trial_state === 'needs_business_id',
    'inscription : compte actif, identifiant d’entreprise attendu'
  );
  const blocked = await api('/api/billing/checkout/', unverified, { offer: 'essential', lang: 'fr' });
  check(
    blocked.status === 409 && blocked.body.error === 'E_NEEDS_BUSINESS_ID',
    'entreprise non vérifiée : pas de souscription (E_NEEDS_BUSINESS_ID)',
    `HTTP ${blocked.status}`
  );

  const bf = await createBf('essential');
  const r = await api('/api/billing/checkout/', bf, { offer: 'essential', lang: 'fr' });
  check(r.status === 200 && typeof r.body.url === 'string', 'checkout Essentiel créé par la route', `HTTP ${r.status}`);
  const sessionId = new URL(r.body.url ?? 'http://x/').pathname.split('/').pop()?.split('#')[0] ?? '';
  if (sessionId.startsWith('cs_')) {
    const cs = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
    check(
      cs.mode === 'subscription' && cs.line_items?.data.length === 2,
      'session : abonnement, forfait + ligne mesurée'
    );
    check(
      cs.automatic_tax.enabled === true && cs.tax_id_collection?.enabled === true,
      'session : Stripe Tax + n° de TVA'
    );
    check(cs.consent_collection?.terms_of_service === 'required', 'session : acceptation des CGV obligatoire');
    check(
      Boolean(cs.custom_text?.submit?.message?.includes('novembre 2026')),
      'session : fin de l’essai annoncée sous le bouton',
      cs.custom_text?.submit?.message ?? ''
    );
  }

  const { clock, sub } = await clockSubscription(bf, 'essential', [LOOKUP.essentialBase, LOOKUP.essentialUsage]);
  await waitFor('offre Essentiel', async () => (await billing(bf.id))?.plan === 'essential');
  check(true, 'webhook : offre Essentiel active');
  const first = (await stripe.invoices.list({ subscription: sub.id, limit: 1 })).data[0];
  check(first?.subtotal === 2000, 'première facture : forfait 20,00 € HT', `${(first?.subtotal ?? 0) / 100} €`);
  const invoice = await usageInvoice(bf, clock.id, sub, 3);
  check(invoice.subtotal === 6500, 'facture HT : 20 € + 3 × 15 € = 65,00 €', `${invoice.subtotal / 100} € HT`);
  const tax = (invoice.total_taxes ?? []).reduce((a, t) => a + t.amount, 0);
  check(tax === 1300, 'TVA FR 20 % : 13,00 €', `${tax / 100} €`);
}

async function s2Essential14() {
  console.log('\nS2 + S3 — Essentiel : 14 analyses (+ re-tests) → 20 € + 14 × 15 € = 230 € HT');
  const bf = await createBf('essential14');
  const { clock, sub } = await clockSubscription(bf, 'essential', [LOOKUP.essentialBase, LOOKUP.essentialUsage]);
  await waitFor('offre Essentiel', async () => (await billing(bf.id))?.plan === 'essential');
  check(true, 'webhook : offre Essentiel active');

  // S3 : le même client re-testé 3 fois dans les 30 jours → 1 seule analyse.
  const [first] = await createClients(bf, 1);
  await register(bf, first);
  const retests = [await register(bf, first), await register(bf, first), await register(bf, first)];
  check(
    retests.every((r) => r.status === 'already_counted'),
    'S3 : 3 re-tests du même client non comptés'
  );
  const s = (await summary(bf)) as { analyses_in_period?: number; billable_in_period?: number };
  check(s.billable_in_period === 1, 'espace BF : 1 analyse facturable', String(s.billable_in_period));

  const invoice = await usageInvoice(bf, clock.id, sub, 13);
  const { count } = await admin.from('bf_analyses').select('id', { count: 'exact', head: true }).eq('user_id', bf.id);
  check(count === 14, '14 analyses en base');
  check(invoice.subtotal === 23000, 'facture HT : 230,00 €', `${invoice.subtotal / 100} € HT`);
  const tax = (invoice.total_taxes ?? []).reduce((a, t) => a + t.amount, 0);
  check(tax === 4600, 'TVA FR 20 % : 46,00 €', `${tax / 100} €`);
}

async function s4LaunchFull() {
  console.log('\nS4 — 21e souscription à l’offre de lancement refusée, Illimité proposé');
  const { data: before } = await admin.rpc('bf_launch_seats_remaining');
  const fillers: string[] = [];
  for (let i = 0; i < (before as number); i++) {
    const { data } = await admin.auth.admin.createUser({ email: `seat-${i}-${RUN}@example.com` });
    fillers.push(data.user!.id);
  }
  await admin
    .from('bf_billing')
    .upsert(fillers.map((id) => ({ user_id: id, plan: 'unlimited_launch', status: 'active' })));
  const { data: after } = await admin.rpc('bf_launch_seats_remaining');
  check(after === 0, '20 places occupées', `places restantes : ${after}`);

  const bf = await createBf('launch21');
  const r = await api('/api/billing/checkout/', bf, { offer: 'unlimited_launch', lang: 'fr' });
  check(r.status === 409 && r.body.error === 'E_LAUNCH_CLOSED', '21e : refus E_LAUNCH_CLOSED', `HTTP ${r.status}`);
  check(r.body.fallback === 'unlimited', 'offre proposée à la place : Illimité (99 €)');
  const r2 = await api('/api/billing/checkout/', bf, { offer: 'unlimited', lang: 'fr' });
  check(r2.status === 200, 'Illimité reste souscriptible', `HTTP ${r2.status}`);

  await admin.from('bf_billing').delete().in('user_id', fillers);
  for (const id of fillers) await admin.auth.admin.deleteUser(id);
}

async function s5LaunchSwitch() {
  console.log(
    '\nS5 — Lancement souscrit plus d’un mois avant (essai Stripe) : 0 € puis 69 €, passage à 99 € (tarif normal) au 01/01/2027'
  );
  const bf = await createBf('launch');
  const { clock, customer } = await clockCustomer(bf, Math.floor(Date.now() / 1000));
  const availableAt = Math.floor(BF_AVAILABLE_AT / 1000);
  // Comme Checkout plus d'un mois avant le 1er novembre : période d'essai Stripe.
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: await priceId(LOOKUP.unlimitedLaunch), quantity: 1 }],
    metadata: metadata(bf, 'unlimited_launch'),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
    trial_end: availableAt,
  });
  await waitFor('offre de lancement', async () => (await billing(bf.id))?.plan === 'unlimited_launch');
  check((await billing(bf.id))?.status === 'active', 'souscrit avant le 1er novembre : accès ouvert');
  const schedule = await waitFor('schedule configuré par le webhook', async () => {
    const s = await stripe.subscriptions.retrieve(sub.id);
    if (!s.schedule) return null;
    const sch = await stripe.subscriptionSchedules.retrieve(s.schedule as string);
    // Stripe crée d'abord deux phases (essai, puis prix courant) : on attend
    // celle au tarif normal (99 €) posée par le webhook.
    const after = await priceId(LOOKUP.unlimited);
    return sch.phases.some((p) => p.items.some((i) => i.price === after)) ? sch : null;
  });
  const switchAt = Math.floor(LAUNCH_OFFER.switchAt / 1000);
  check(schedule.phases[0].end_date === switchAt, 'phase 1 jusqu’au 01/01/2027 00:00 (Paris)');
  check(schedule.phases[0].trial_end === availableAt, 'le schedule conserve l’essai jusqu’au 1er novembre');
  check(schedule.phases[1]?.items[0]?.price === (await priceId(LOOKUP.unlimited)), 'phase 2 : tarif normal, 99 €');

  const early = await stripe.invoices.list({ subscription: sub.id, limit: 10 });
  check(
    early.data.every((i) => i.total === 0),
    'aucun prélèvement avant le 1er novembre',
    early.data.map((i) => i.total).join(', ')
  );

  await advanceStepwise(clock.id, availableAt + 3 * 3600);
  const nov = await stripe.invoices.list({ subscription: sub.id, limit: 10 });
  const first = nov.data.find((i) => i.subtotal > 0);
  check(first?.subtotal === 6900 && first.created >= availableAt, 'premier prélèvement le 1er novembre : 69,00 € HT');

  await advanceStepwise(clock.id, switchAt + 45 * 86400);
  const after = await stripe.subscriptions.retrieve(sub.id);
  check(after.items.data[0].price.lookup_key === LOOKUP.unlimited, 'abonnement passé au tarif normal, 99 €');
  const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 20 });
  const lines = invoices.data.flatMap((i) => i.lines.data);
  // Avec un premier prélèvement le 1er novembre, les échéances tombent le 1er
  // du mois : la bascule coïncide avec une échéance, sans prorata.
  check(
    !lines.some((l) => l.period.start === switchAt && l.amount < 0),
    'pas de prorata : la bascule tombe sur une échéance'
  );
  check(
    lines.some((l) => l.period.start >= switchAt && l.amount === 9900),
    'échéance de janvier : 99,00 € HT'
  );
  check(
    lines.some((l) => l.period.start < switchAt && l.amount === 6900),
    'échéances 2026 : 69,00 € HT'
  );
  await waitFor('bf_billing après bascule', async () => (await billing(bf.id))?.plan === 'unlimited');
  const b5 = await billing(bf.id);
  check(
    b5?.status === 'active' && b5?.offer === 'unlimited',
    'toujours actif, passé en Illimité (place de lancement libérée)'
  );
}

async function s6PaymentFailure() {
  console.log('\nS6 — Échec de paiement : 7 jours d’accès, puis lecture seule');
  const bf = await createBf('dunning');
  const { clock, customer } = await clockCustomer(bf, Math.floor(Date.now() / 1000));
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: await priceId(LOOKUP.unlimited), quantity: 1 }],
    metadata: metadata(bf, 'unlimited'),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
  });
  await waitFor('offre illimitée', async () => (await billing(bf.id))?.status === 'active');

  const failing = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: failing.id } });
  await stripe.subscriptions.update(sub.id, { default_payment_method: failing.id });
  await advance(clock.id, sub.items.data[0].current_period_end + 3 * 3600);

  const b = await waitFor(
    'passage en past_due',
    async () => {
      const row = await billing(bf.id);
      return row?.status === 'past_due' ? row : null;
    },
    120_000
  );
  const graceDays = (new Date(b.grace_until ?? 0).getTime() - Date.now()) / 86400000;
  check(graceDays > 6.9 && graceDays <= 7, 'grâce de 7 jours ouverte', `${graceDays.toFixed(2)} j`);
  const [c1, c2] = await createClients(bf, 2);
  check((await register(bf, c1)).status === 'counted', 'pendant la grâce : analyses autorisées');

  // Le délai de grâce se mesure en temps réel (base) : on le fait expirer.
  await admin
    .from('bf_billing')
    .update({ grace_until: new Date(Date.now() - 60_000).toISOString() })
    .eq('user_id', bf.id);
  const refused = await register(bf, c2);
  check(refused.status === 'refused' && refused.reason === 'read_only', 'après 7 jours : lecture seule');
  const { data: summary } = await bf.client.rpc('bf_usage_summary');
  check((summary as { access?: string } | null)?.access === 'read_only', 'espace BF : accès « read_only »');

  // Stripe abandonne les relances (réglage « Retries » du compte) : si
  // l'abonnement est résilié pendant la grâce, l'accès reste jusqu'au bout.
  const grace = new Date(Date.now() + 5 * 86400000).toISOString();
  await admin.from('bf_billing').update({ grace_until: grace }).eq('user_id', bf.id);
  const start = (await stripe.testHelpers.testClocks.retrieve(clock.id)).frozen_time;
  let ended: Stripe.Subscription | null = null;
  for (let day = 7; day <= 63 && !ended; day += 7) {
    await advance(clock.id, start + day * 86400);
    const s = await stripe.subscriptions.retrieve(sub.id);
    if (s.status === 'canceled' || s.status === 'unpaid') ended = s;
  }
  if (!ended) {
    check(false, 'Stripe n’a ni résilié ni marqué impayé après 9 semaines de relances');
    return;
  }
  console.log(
    `    (réglage du compte : « ${ended.status} » après relances, motif ${ended.cancellation_details?.reason})`
  );
  if (ended.status === 'canceled') {
    check(ended.cancellation_details?.reason === 'payment_failed', 'motif de résiliation : payment_failed');
    const b2 = await waitFor('grâce conservée', async () => {
      const row = await billing(bf.id);
      return row?.stripe_subscription_id === null ? row : null;
    });
    check(
      b2.status === 'past_due' && new Date(b2.grace_until ?? 0).getTime() === new Date(grace).getTime(),
      'résilié pendant la grâce : accès gardé jusqu’à la fin de la grâce'
    );
    check(b2.plan === 'unlimited', 'offre conservée pendant la grâce');
    const { data: s2 } = await bf.client.rpc('bf_usage_summary');
    check(
      (s2 as { has_subscription?: boolean } | null)?.has_subscription === false,
      'espace BF : plus d’abonnement, réabonnement proposé'
    );
  } else {
    check((await billing(bf.id))?.status === 'past_due', 'marqué impayé : grâce puis lecture seule');
  }
}

async function s7ReverseCharge() {
  console.log('\nS7 — Client B2B UE avec n° de TVA : autoliquidation');
  const customer = await stripe.customers.create({
    email: `b2b-${RUN}@example.com`,
    name: 'Radstudio GmbH',
    address: { line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
    tax_id_data: [{ type: 'eu_vat', value: 'DE123456789' }],
    metadata: { aerox_e2e: '1' },
  });
  const product = (await stripe.prices.retrieve(await priceId(LOOKUP.unlimited))).product as string;
  await stripe.invoiceItems.create({
    customer: customer.id,
    price_data: { currency: 'eur', product, unit_amount: 11900, tax_behavior: 'exclusive' },
  });
  const draft = await stripe.invoices.create({
    customer: customer.id,
    automatic_tax: { enabled: true },
    pending_invoice_items_behavior: 'include',
    collection_method: 'send_invoice',
    days_until_due: 30,
  });
  const invoice = await stripe.invoices.finalizeInvoice(draft.id);
  const taxes = invoice.total_taxes ?? [];
  const tax = taxes.reduce((a, t) => a + t.amount, 0);
  check(invoice.subtotal === 11900 && tax === 0, 'facture 119 € HT, TVA 0 €', `taxe ${tax / 100} €`);
  check(
    taxes.some((t) => t.taxability_reason === 'reverse_charge'),
    'motif : autoliquidation (reverse_charge)',
    taxes.map((t) => t.taxability_reason).join(', ')
  );
  check(
    (invoice.customer_tax_ids ?? []).some((t) => t.value === 'DE123456789'),
    'n° de TVA du client sur la facture'
  );
}

/** Identifiant d'entreprise saisi dans l'espace BF (route réelle, registres officiels). */
async function submitBusinessId(bf: Bf, id: string) {
  return api('/api/billing/business-id/', bf, { id });
}

// Danone SA : SIREN 552 032 534 (actif au registre), TVA FR27552032534.
const DANONE_SIREN = '552 032 534';

async function s8BusinessId() {
  console.log('\nS8 — Numéro d’entreprise vérifié : essai autorisé (il démarre avec l’abonnement), un par entreprise');
  await admin.from('bf_business_ids').delete().neq('id_key', '');
  const bf = await createBf('biz', false);
  const [c1] = await createClients(bf, 1);
  const before = await register(bf, c1);
  check(
    before.status === 'refused' && before.reason === 'needs_card',
    'sans identifiant : analyse refusée (code lu par l’app)'
  );
  check((await billing(bf.id))?.trial_state === 'needs_business_id', 'inscription : identifiant d’entreprise attendu');

  const bad = await submitBusinessId(bf, '552 032 535');
  check(bad.body.result === 'invalid', 'SIREN à la clé fausse : refusé', String(bad.body.result));
  const unknown = await submitBusinessId(bf, '000 000 000');
  check(unknown.body.result === 'not_found', 'SIREN inexistant au registre : refusé', String(unknown.body.result));
  const us = await submitBusinessId(bf, '12-3456789');
  check(
    us.body.result === 'invalid',
    'numéro hors UE : refusé (le site internet est demandé à la place)',
    String(us.body.result)
  );

  const ok = await submitBusinessId(bf, DANONE_SIREN);
  check(
    ok.status === 200 && ok.body.result === 'granted',
    'SIREN actif : entreprise vérifiée',
    `${ok.body.result} ${ok.body.name ?? ''}`
  );
  const b = await billing(bf.id);
  check(b?.trial_state === 'granted' && !b?.trial_ends_at, 'essai autorisé, pas encore démarré (pas d’abonnement)');
  const still = await register(bf, c1);
  check(
    still.status === 'refused' && still.reason === 'needs_card',
    'sans abonnement : analyse refusée (« démarrez votre essai » dans l’app)'
  );
  const go = await api('/api/billing/checkout/', bf, { offer: 'essential', lang: 'fr' });
  check(go.status === 200, 'la souscription avec essai est ouverte', `HTTP ${go.status}`);
  const again = await submitBusinessId(bf, DANONE_SIREN);
  check(again.status === 409, 'entreprise déjà vérifiée : rien de plus', `HTTP ${again.status}`);

  // Même entreprise sous sa forme TVA (VIES), sur un autre compte.
  const other = await createBf('biz-bis', false);
  const dup = await submitBusinessId(other, 'FR27552032534');
  check(
    dup.body.result === 'already_used',
    'même entreprise (n° de TVA), autre compte : refusé',
    String(dup.body.result)
  );
  check(!(await billing(other.id))?.trial_ends_at, 'aucun essai pour le second compte');
}

async function s24ManualReview() {
  console.log('\nS24 — Site internet : contrôles, vérification manuelle, validation par le lien signé');
  await admin.from('bf_business_ids').delete().like('id_key', 'WEB:example.%');
  const bf = await createBf('biz-web', false);
  const social = await submitBusinessId(bf, 'instagram.com/monstudio');
  check(social.body.result === 'invalid', 'réseau social : refusé', String(social.body.result));
  const dead = await submitBusinessId(bf, 'aerox-studio-qui-nexiste-pas-4815.com');
  check(dead.body.result === 'unreachable', 'site qui ne répond pas : refusé', String(dead.body.result));
  // createBf crée des e-mails @example.com : même domaine que le site.
  const r = await submitBusinessId(bf, 'https://www.example.com/');
  check(r.body.result === 'pending_review', 'site qui répond : en vérification', String(r.body.result));
  const { data: row } = await admin.from('bf_business_ids').select('*').eq('user_id', bf.id).single();
  check(
    row?.id_key === 'WEB:example.com' && row?.email_domain_match === true,
    'domaine enregistré, e-mail du même domaine signalé'
  );
  check((await billing(bf.id))?.trial_state === 'pending_review', 'espace BF : « vérification sous 24 h »');
  const [c] = await createClients(bf, 1);
  check((await register(bf, c)).reason === 'needs_card', 'avant validation : analyses fermées');

  const { createHmac } = await import('node:crypto');
  const token = createHmac('sha256', env('E2E_BILLING_HOOK_SECRET')).update(bf.id).digest('hex');
  const link = `${SITE}/api/billing/approve-business/?u=${bf.id}&t=${token}`;
  const forged = await fetch(`${SITE}/api/billing/approve-business/?u=${bf.id}&t=${'0'.repeat(64)}`);
  check(forged.status === 403, 'lien falsifié : refusé', `HTTP ${forged.status}`);
  const view = await fetch(link);
  const html = await view.text();
  check(
    view.status === 200 && html.includes('example.com</a>'),
    'le lien affiche le site à vérifier (rien n’est validé à l’ouverture)'
  );
  check((await billing(bf.id))?.trial_state === 'pending_review', 'ouvrir le lien ne valide rien');
  const post = await fetch(link, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: SITE },
    body: new URLSearchParams({ u: bf.id, t: token }),
  });
  check(
    post.status === 200 && (await post.text()).includes('validé'),
    'bouton « Valider » : studio validé',
    `HTTP ${post.status}`
  );
  const b = await billing(bf.id);
  check(b?.trial_state === 'granted' && !b?.trial_ends_at, 'essai autorisé (il démarre avec l’abonnement)');
  check((await register(bf, c)).status === 'counted', 'analyse comptée après validation');

  const other = await createBf('biz-web-bis');
  const dup = await submitBusinessId(other, 'example.com');
  check(dup.body.result === 'already_used', 'même site, autre compte : refusé', String(dup.body.result));
}

async function s9Downgrade() {
  console.log('\nS9 — Descente Illimité → Essentiel : effective à la fin de la période payée');
  const bf = await createBf('downgrade');
  const { clock, sub } = await clockSubscription(bf, 'unlimited', [LOOKUP.unlimited], Math.floor(Date.now() / 1000));
  await waitFor('offre illimitée', async () => (await billing(bf.id))?.plan === 'unlimited');
  const r = await api('/api/billing/manage/', bf, { action: 'change', offer: 'essential' });
  check(
    r.status === 200 && r.body.effective === 'period_end',
    'descente programmée en fin de période',
    `HTTP ${r.status}`
  );
  await sleep(5000);
  check((await billing(bf.id))?.plan === 'unlimited', 'toujours Illimité jusqu’à la fin de la période');
  const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 5 });
  check(
    !invoices.data.some((i) => i.total < 0 || i.billing_reason === 'subscription_update'),
    'aucun avoir au prorata'
  );

  await advance(clock.id, sub.items.data[0].current_period_end + 3600);
  await waitFor('passage en Essentiel', async () => (await billing(bf.id))?.plan === 'essential', 120_000);
  check(true, 'après l’échéance : offre Essentiel');
  const after = await stripe.subscriptions.retrieve(sub.id);
  check(
    after.items.data
      .map((i) => i.price.lookup_key)
      .sort()
      .join() === [LOOKUP.essentialBase, LOOKUP.essentialUsage].sort().join(),
    'abonnement : forfait Essentiel + ligne mesurée'
  );

  // Remontée : immédiate.
  const up = await api('/api/billing/manage/', bf, { action: 'change', offer: 'unlimited' });
  check(up.status === 200 && up.body.effective === 'now', 'remontée en Illimité immédiate');
  await waitFor('retour en Illimité', async () => (await billing(bf.id))?.plan === 'unlimited');
  check(true, 'webhook : Illimité de nouveau actif');
}

async function s10Annual() {
  console.log('\nS10 — Illimité annuel : 990 € HT / an');
  const bf = await createBf('annual');
  const r = await api('/api/billing/checkout/', bf, { offer: 'unlimited_annual', lang: 'fr' });
  check(r.status === 200, 'checkout annuel créé par la route', `HTTP ${r.status}`);
  const { sub } = await clockSubscription(
    bf,
    'unlimited_annual',
    [LOOKUP.unlimitedYear],
    Math.floor(Date.now() / 1000)
  );
  await waitFor('offre illimitée annuelle', async () => (await billing(bf.id))?.plan === 'unlimited');
  const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 1 });
  check(
    invoices.data[0]?.subtotal === 99000,
    'première facture : 990,00 € HT',
    `${(invoices.data[0]?.subtotal ?? 0) / 100} €`
  );
  const b = await billing(bf.id);
  const days =
    (new Date(b?.current_period_end ?? 0).getTime() - new Date(b?.current_period_start ?? 0).getTime()) / 86400000;
  check(days > 360, 'période d’un an enregistrée', `${Math.round(days)} j`);
}

async function summary(bf: Bf) {
  const { data } = await bf.client.rpc('bf_usage_summary');
  return data as Record<string, unknown>;
}

/** Horloge au 5 octobre 2026 : un ancrage au 1er novembre est accepté pour un mensuel. */
const OCT5 = Math.floor(Date.UTC(2026, 9, 5, 12) / 1000);

/**
 * Abonnement souscrit avant le 1er novembre, comme Checkout le crée à moins
 * d'un mois de la date : facturation ancrée au 1er novembre, sans prorata.
 */
async function preLaunchSubscription(bf: Bf, offer: string, lookup: string, extraItems: string[] = []) {
  const { clock, customer } = await clockCustomer(bf, Math.max(OCT5, Math.floor(Date.now() / 1000)));
  const metered = [LOOKUP.essentialUsage] as string[];
  const items = [];
  for (const key of [lookup, ...extraItems])
    items.push(metered.includes(key) ? { price: await priceId(key) } : { price: await priceId(key), quantity: 1 });
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items,
    metadata: metadata(bf, offer),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
    billing_cycle_anchor: Math.floor(BF_AVAILABLE_AT / 1000),
    proration_behavior: 'none',
  });
  return { clock, customer, sub };
}

/** Aucune facture non nulle avant le 1er novembre. */
async function nothingChargedBeforeLaunch(subId: string) {
  const inv = await stripe.invoices.list({ subscription: subId, limit: 10 });
  return inv.data.filter((i) => i.created < Math.floor(BF_AVAILABLE_AT / 1000)).every((i) => i.total === 0);
}

async function s11LaunchCancel() {
  console.log('\nS11 — Résilier l’offre de lancement : la bascule au tarif normal ne revient pas');
  const bf = await createBf('launch-cancel');
  const { clock, sub } = await preLaunchSubscription(bf, 'unlimited_launch', LOOKUP.unlimitedLaunch);
  await waitFor('schedule de lancement', async () => (await stripe.subscriptions.retrieve(sub.id)).schedule);

  const r = await api('/api/billing/manage/', bf, { action: 'cancel' });
  check(r.status === 200, 'résiliation acceptée', `HTTP ${r.status}`);
  const b = await billing(bf.id);
  check(Boolean(b?.cancel_at), 'base à jour dès la réponse : résiliation programmée', String(b?.cancel_at));
  await sleep(15_000); // laisse passer les webhooks qui recréaient le schedule
  const after = await stripe.subscriptions.retrieve(sub.id);
  check(
    after.cancel_at_period_end === true || after.cancel_at === Math.floor(BF_AVAILABLE_AT / 1000),
    'Stripe : résiliation toujours programmée après les webhooks'
  );
  check(!after.schedule, 'aucun schedule recréé (pas de bascule au tarif normal)');
  check(Boolean((await summary(bf)).cancel_at), 'espace BF : « résiliation programmée »');

  const resume = await api('/api/billing/manage/', bf, { action: 'resume' });
  check(resume.status === 200 && !(await billing(bf.id))?.cancel_at, 'reprise : résiliation levée');
  const sch = await waitFor('bascule reposée', async () => {
    const s2 = await stripe.subscriptions.retrieve(sub.id);
    return s2.schedule ? stripe.subscriptionSchedules.retrieve(s2.schedule as string) : null;
  });
  check(sch.phases.length >= 2, 'reprise : bascule au 01/01/2027 reposée');

  const again = await api('/api/billing/manage/', bf, { action: 'cancel' });
  check(again.status === 200, 'nouvelle résiliation');
  await sleep(10_000);
  await advanceStepwise(clock.id, Math.floor(BF_AVAILABLE_AT / 1000) + 3 * 3600);
  const ended = await stripe.subscriptions.retrieve(sub.id);
  check(ended.status === 'canceled', 'au 1er novembre : abonnement terminé', ended.status);
  const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 10 });
  check(
    invoices.data.every((i) => i.total === 0),
    'aucun prélèvement',
    invoices.data.map((i) => i.total).join(', ')
  );
  const b2 = await waitFor('retour à l’essai', async () => {
    const row = await billing(bf.id);
    return row?.plan === 'trial' ? row : null;
  });
  check(!b2.stripe_subscription_id && !b2.cancel_at && !b2.offer, 'base : abonnement, offre et résiliation effacés');
}

async function s12Duplicate() {
  console.log('\nS12 — Deux abonnements payés pour le même compte : le second est annulé et remboursé');
  const bf = await createBf('duplicate');
  const { customer } = await clockCustomer(bf, Math.floor(Date.now() / 1000));
  const first = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: await priceId(LOOKUP.unlimited), quantity: 1 }],
    metadata: metadata(bf, 'unlimited'),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
  });
  await waitFor('premier abonnement', async () => (await billing(bf.id))?.stripe_subscription_id === first.id);
  const second = await stripe.subscriptions.create({
    customer: customer.id,
    items: [
      { price: await priceId(LOOKUP.essentialBase), quantity: 1 },
      { price: await priceId(LOOKUP.essentialUsage) },
    ],
    metadata: metadata(bf, 'essential'),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
  });
  const dup = await waitFor(
    'doublon annulé',
    async () => {
      const s2 = await stripe.subscriptions.retrieve(second.id);
      return s2.status === 'canceled' ? s2 : null;
    },
    90_000
  );
  check(Boolean(dup), 'second abonnement résilié');
  const inv = (await stripe.invoices.list({ subscription: second.id, limit: 1 })).data[0];
  const refund = await waitFor('remboursement', async () => {
    const payments = await stripe.invoicePayments.list({ invoice: inv.id! });
    const intent = payments.data[0]?.payment?.payment_intent;
    if (!intent) return null;
    const refunds = await stripe.refunds.list({ payment_intent: intent as string });
    return refunds.data[0] ?? null;
  });
  check(
    refund.amount === inv.amount_paid && inv.amount_paid > 0,
    'facture du doublon remboursée',
    `${refund.amount / 100} €`
  );
  const b = await billing(bf.id);
  check(b?.stripe_subscription_id === first.id && b?.plan === 'unlimited', 'base : premier abonnement conservé');
  check((await stripe.subscriptions.retrieve(first.id)).status === 'active', 'premier abonnement toujours actif');
}

async function s13AnnualPreLaunch() {
  console.log('\nS13 — Illimité annuel souscrit avant le 1er novembre : reconnu comme annuel');
  const bf = await createBf('annual-trial');
  const { sub } = await preLaunchSubscription(bf, 'unlimited_annual', LOOKUP.unlimitedYear);
  await waitFor('offre annuelle', async () => (await billing(bf.id))?.offer === 'unlimited_annual');
  const s = await summary(bf);
  check(s.offer === 'unlimited_annual', 'espace BF : offre « Illimité annuel »', String(s.offer));

  const same = await api('/api/billing/manage/', bf, { action: 'change', offer: 'unlimited_annual' });
  check(same.status === 400, 'même offre refusée proprement', `HTTP ${same.status}`);

  const down = await api('/api/billing/manage/', bf, { action: 'change', offer: 'unlimited' });
  check(down.status === 200 && down.body.effective === 'period_end', 'annuel → mensuel : en fin de période');
  const b = await billing(bf.id);
  check(
    b?.scheduled_offer === 'unlimited' && new Date(b?.scheduled_at ?? 0).getTime() === BF_AVAILABLE_AT,
    'changement programmé visible (Illimité mensuel au 1er novembre)',
    `${b?.scheduled_offer} ${b?.scheduled_at}`
  );
  const phases = (
    await stripe.subscriptionSchedules.retrieve((await stripe.subscriptions.retrieve(sub.id)).schedule as string)
  ).phases;
  check(await nothingChargedBeforeLaunch(sub.id), 'rien de prélevé avant le 1er novembre');
  void phases;

  const keep = await api('/api/billing/manage/', bf, { action: 'keep' });
  check(keep.status === 200, 'annulation du changement acceptée');
  const b2 = await billing(bf.id);
  check(!b2?.scheduled_offer && b2?.offer === 'unlimited_annual', 'changement annulé : reste en annuel');
  check(!(await stripe.subscriptions.retrieve(sub.id)).schedule, 'schedule de descente retiré');
}

async function s14SeatRelease() {
  console.log('\nS14 — Place de lancement libérée après une résiliation pour impayé');
  const { data: before } = await admin.rpc('bf_launch_seats_remaining');
  const mk = async (tag: string, row: Record<string, unknown>) => {
    const { data } = await admin.auth.admin.createUser({ email: `seat-${tag}-${RUN}@example.com` });
    await admin.from('bf_billing').upsert({ user_id: data.user!.id, plan: 'unlimited_launch', ...row });
    return data.user!.id;
  };
  const ids = [
    await mk('relance', {
      status: 'past_due',
      stripe_subscription_id: `sub_e2e_${RUN}`,
      grace_until: new Date(Date.now() - 86400000).toISOString(),
    }),
    await mk('grace', { status: 'past_due', grace_until: new Date(Date.now() + 86400000).toISOString() }),
    await mk('expire', { status: 'past_due', grace_until: new Date(Date.now() - 86400000).toISOString() }),
  ];
  const { data: after } = await admin.rpc('bf_launch_seats_remaining');
  check(
    (before as number) - (after as number) === 2,
    'relance en cours et grâce en cours : place prise ; grâce passée : place libre',
    `${before} → ${after}`
  );
  await admin.from('bf_billing').delete().in('user_id', ids);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
}

async function s15ChangeWhileCancelled() {
  console.log('\nS15 — Changer d’offre alors qu’une résiliation est programmée');
  const bf = await createBf('cancel-change');
  const { sub } = await clockSubscription(bf, 'unlimited', [LOOKUP.unlimited], Math.floor(Date.now() / 1000));
  await waitFor('offre illimitée', async () => (await billing(bf.id))?.stripe_subscription_id === sub.id);
  await api('/api/billing/manage/', bf, { action: 'cancel' });
  check(Boolean((await billing(bf.id))?.cancel_at), 'résiliation programmée');
  const down = await api('/api/billing/manage/', bf, { action: 'change', offer: 'essential' });
  check(down.status === 200 && down.body.effective === 'period_end', 'descente acceptée', `HTTP ${down.status}`);
  const b = await billing(bf.id);
  check(!b?.cancel_at && b?.scheduled_offer === 'essential', 'résiliation levée, descente vers Essentiel programmée');
  const up = await api('/api/billing/manage/', bf, { action: 'cancel' });
  check(up.status === 200, 'nouvelle résiliation (schedule détaché)');
  const b2 = await billing(bf.id);
  check(Boolean(b2?.cancel_at) && !b2?.scheduled_offer, 'résiliation programmée, descente abandonnée');
}

async function s16CheckoutExpire() {
  console.log('\nS16 — Une seule page de paiement ouverte : la précédente est expirée');
  const bf = await createBf('expire');
  const a = await api('/api/billing/checkout/', bf, { offer: 'essential', lang: 'fr' });
  const b = await api('/api/billing/checkout/', bf, { offer: 'unlimited', lang: 'fr' });
  check(a.status === 200 && b.status === 200, 'deux sessions créées');
  const idOfUrl = (u?: string) => new URL(u ?? 'http://x/').pathname.split('/').pop()?.split('#')[0] ?? '';
  const first = await stripe.checkout.sessions.retrieve(idOfUrl(a.body.url));
  const second = await stripe.checkout.sessions.retrieve(idOfUrl(b.body.url));
  check(first.status === 'expired', 'première session expirée', first.status ?? '');
  check(second.status === 'open', 'seconde session ouverte', second.status ?? '');
}

/** Remplace la carte par défaut du client (et de l'abonnement). */
async function swapCard(customerId: string, subId: string, pm: string) {
  const method = await stripe.paymentMethods.attach(pm, { customer: customerId });
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: method.id } });
  await stripe.subscriptions.update(subId, { default_payment_method: method.id });
  return method.id;
}

async function s17FirstPaymentDeclined() {
  console.log('\nS17 — Carte refusée au premier paiement : rien n’est ouvert, rien n’est bloqué');
  const bf = await createBf('declined');
  const { clock, customer } = await clockCustomer(bf, Math.floor(Date.now() / 1000), 'pm_card_chargeCustomerFail');
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: await priceId(LOOKUP.unlimited), quantity: 1 }],
    metadata: metadata(bf, 'unlimited'),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
    payment_behavior: 'default_incomplete',
  });
  // default_incomplete ne tente pas le paiement : on le tente comme Checkout.
  const inv = await stripe.invoices.retrieve(sub.latest_invoice as string);
  await stripe.invoices.pay(inv.id!).catch(() => null);
  check((await stripe.subscriptions.retrieve(sub.id)).status === 'incomplete', 'Stripe : abonnement « incomplete »');
  await sleep(10_000);
  const b = await billing(bf.id);
  check(b?.plan === 'trial' && !b?.stripe_subscription_id && !b?.offer, 'base : toujours en essai, aucun abonnement');
  const r = await api('/api/billing/checkout/', bf, { offer: 'essential', lang: 'fr' });
  check(r.status === 200, 'le bike fitter peut réessayer une offre', `HTTP ${r.status}`);

  await advance(clock.id, Math.floor(Date.now() / 1000) + 25 * 3600);
  const expired = await waitFor('incomplete_expired', async () => {
    const x = await stripe.subscriptions.retrieve(sub.id);
    return x.status === 'incomplete_expired' ? x : null;
  });
  check(Boolean(expired), 'après 23 h : abonnement expiré chez Stripe');
  await sleep(10_000);
  const b2 = await billing(bf.id);
  check(
    b2?.plan === 'trial' && b2?.trial_state === 'granted' && !b2?.trial_ends_at,
    'base inchangée après l’expiration (essai intact)'
  );
}

async function s18AuthRequiredThenRecovery() {
  console.log('\nS18 — 3D Secure exigé au renouvellement, puis régularisation avec une autre carte');
  const bf = await createBf('sca');
  const { clock, customer, sub } = await clockSubscription(
    bf,
    'essential',
    [LOOKUP.essentialBase, LOOKUP.essentialUsage],
    Math.floor(Date.now() / 1000)
  );
  await waitFor('offre Essentiel', async () => (await billing(bf.id))?.stripe_subscription_id === sub.id);
  await swapCard(customer.id, sub.id, 'pm_card_authenticationRequired');
  await advance(clock.id, sub.items.data[0].current_period_end + 3 * 3600);
  const b = await waitFor(
    'past_due',
    async () => {
      const row = await billing(bf.id);
      return row?.status === 'past_due' ? row : null;
    },
    120_000
  );
  check(Boolean(b.grace_until), 'renouvellement non authentifié : grâce ouverte', String(b.grace_until));
  const s1 = (await summary(bf)) as { access?: string; status?: string };
  check(s1.access === 'full' && s1.status === 'past_due', 'espace BF : « paiement en échec », accès complet');
  const [c1] = await createClients(bf, 1);
  check((await register(bf, c1)).status === 'counted', 'analyses toujours possibles pendant la grâce');

  // Le bike fitter change de carte (portail) ; Stripe relance la facture ouverte.
  await swapCard(customer.id, sub.id, 'pm_card_visa');
  const open = (await stripe.invoices.list({ subscription: sub.id, status: 'open', limit: 5 })).data;
  check(open.length === 1, 'une facture ouverte à régulariser', String(open.length));
  if (open[0]) await stripe.invoices.pay(open[0].id!);
  const b2 = await waitFor(
    'retour en actif',
    async () => {
      const row = await billing(bf.id);
      return row?.status === 'active' ? row : null;
    },
    120_000
  );
  check(!b2.grace_until, 'régularisé : actif, grâce effacée');
  check((await stripe.subscriptions.retrieve(sub.id)).status === 'active', 'Stripe : abonnement actif');
}

async function s19PreLaunchFirstChargeFails() {
  console.log('\nS19 — Offre de lancement : le premier prélèvement du 1er novembre échoue');
  afterPriceCache = await priceId(LOOKUP.unlimited);
  const bf = await createBf('launch-fail');
  const { clock, customer, sub } = await preLaunchSubscription(bf, 'unlimited_launch', LOOKUP.unlimitedLaunch);
  await waitFor('schedule de lancement', async () => (await stripe.subscriptions.retrieve(sub.id)).schedule);
  await swapCard(customer.id, sub.id, 'pm_card_chargeCustomerFail');
  const { data: seatsBefore } = await admin.rpc('bf_launch_seats_remaining');
  await advanceStepwise(clock.id, Math.floor(BF_AVAILABLE_AT / 1000) + 3 * 3600);
  const b = await waitFor(
    'past_due',
    async () => {
      const row = await billing(bf.id);
      return row?.status === 'past_due' ? row : null;
    },
    120_000
  );
  check(
    Boolean(b.grace_until) && b.plan === 'unlimited_launch',
    'échec au 1er novembre : grâce ouverte, offre conservée'
  );
  const { data: seatsAfter } = await admin.rpc('bf_launch_seats_remaining');
  check(
    seatsAfter === seatsBefore,
    'place de lancement toujours réservée pendant la relance',
    `${seatsBefore} → ${seatsAfter}`
  );
  const s2 = await stripe.subscriptions.retrieve(sub.id);
  const sch = s2.schedule ? await stripe.subscriptionSchedules.retrieve(s2.schedule as string) : null;
  check(
    Boolean(sch?.phases.some((p) => p.items.some((i) => i.price === afterPriceCache))),
    'bascule au tarif normal toujours programmée'
  );
}
let afterPriceCache = '';

async function s20PastDueCancelAndResubscribe() {
  console.log('\nS20 — Impayé : résilier pendant la relance, puis se réabonner');
  const bf = await createBf('pastdue-cancel');
  const { clock, customer, sub } = await clockSubscription(
    bf,
    'unlimited',
    [LOOKUP.unlimited],
    Math.floor(Date.now() / 1000)
  );
  await waitFor('offre illimitée', async () => (await billing(bf.id))?.stripe_subscription_id === sub.id);
  await swapCard(customer.id, sub.id, 'pm_card_chargeCustomerFail');
  await advance(clock.id, sub.items.data[0].current_period_end + 3 * 3600);
  await waitFor('past_due', async () => (await billing(bf.id))?.status === 'past_due', 120_000);

  const r = await api('/api/billing/manage/', bf, { action: 'cancel' });
  check(r.status === 200, 'résiliation acceptée pendant l’impayé', `HTTP ${r.status}`);
  const b = await billing(bf.id);
  check(b?.status === 'past_due' && Boolean(b?.cancel_at), 'base : impayé + résiliation programmée');
  const blocked = await api('/api/billing/checkout/', bf, { offer: 'essential', lang: 'fr' });
  check(
    blocked.status === 409,
    'nouvel abonnement refusé tant que l’ancien existe (pas de doublon)',
    `HTTP ${blocked.status}`
  );

  // Fin de l'abonnement (fin de période ou fin des relances).
  await stripe.subscriptions.cancel(sub.id);
  const b2 = await waitFor('abonnement terminé', async () => {
    const row = await billing(bf.id);
    return row && !row.stripe_subscription_id ? row : null;
  });
  console.log(`    (après la fin : plan ${b2.plan}, statut ${b2.status}, grâce ${b2.grace_until})`);
  check(!b2.cancel_at && !b2.scheduled_offer, 'résiliation programmée effacée');
  const again = await api('/api/billing/checkout/', bf, { offer: 'essential', lang: 'fr' });
  check(again.status === 200, 'réabonnement possible', `HTTP ${again.status}`);
  // Créance : la facture impayée reste due, relancée, réglable depuis l'espace.
  const open = (await stripe.invoices.list({ subscription: sub.id, limit: 5 })).data.filter((i) => i.status === 'open');
  check(open.length === 1, 'facture impayée conservée chez Stripe', String(open.length));
  check(
    b2.unpaid_invoice_id === open[0]?.id &&
      Number(b2.unpaid_amount) === open[0]?.amount_remaining &&
      Boolean(b2.unpaid_invoice_url),
    'créance enregistrée (montant et lien de paiement)',
    `${Number(b2.unpaid_amount) / 100} €`
  );
  const s3 = (await summary(bf)) as { unpaid_amount?: number; unpaid_invoice_url?: string };
  check(Boolean(s3.unpaid_amount && s3.unpaid_invoice_url), 'espace BF : facture impayée et bouton « Régler »');
  const b2b = await billing(bf.id);
  check(
    /^https:\/\/invoice\.stripe\.com\//.test(String(b2b?.unpaid_invoice_url)) && Boolean(b2b?.unpaid_since),
    'relances programmées (lien Stripe, date d’ouverture de la créance)',
    String(b2b?.unpaid_invoice_url).slice(0, 40)
  );

  await swapCard(customer.id, sub.id, 'pm_card_visa').catch(() => null);
  const method = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
  if (open[0]) await stripe.invoices.pay(open[0].id!, { payment_method: method.id });
  const b3 = await waitFor('créance réglée', async () => {
    const row = await billing(bf.id);
    return row && !row.unpaid_invoice_id ? row : null;
  });
  check(!b3.unpaid_amount && !b3.unpaid_invoice_url, 'facture réglée : créance effacée');
}

// ---------------------------------------------------------------------------
// Achats du Diagnostic (cycliste) : achats multiples et sécurités
// ---------------------------------------------------------------------------

/** Cycliste inscrit (profil par défaut). */
async function createRider(tag: string): Promise<Bf> {
  const email = `rider-${tag}-${RUN}@example.com`;
  const password = `Test-${RUN}-A1`;
  const { data, error } = await admin.auth.admin.createUser({ email, password });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  await admin.auth.admin.updateUserById(data.user.id, { email_confirm: true });
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: s, error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2 || !s.session) throw new Error(`signIn: ${e2?.message}`);
  return { id: data.user.id, email, client, token: s.session.access_token };
}

/** Webhook signé : renvoie le code HTTP au lieu de lever. */
async function postSignedStatus(type: string, object: Record<string, unknown>, secret = env('E2E_WEBHOOK_SECRET')) {
  const payload = JSON.stringify({
    id: `evt_e2e_${RUN}_${Math.random().toString(36).slice(2)}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(`${SITE}/api/stripe-webhook/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  return res.status;
}

/** Paiement réel (mode test) du diagnostic, puis la session Checkout correspondante envoyée au webhook. */
async function payDiagnostic(rider: Bf, opts: { recordSession?: boolean; userId?: string } = {}) {
  const intent = await stripe.paymentIntents.create({
    amount: 4900,
    currency: 'eur',
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    metadata: { product: 'diagnostic', userId: opts.userId ?? rider.id, aerox_e2e: '1' },
  });
  const session = {
    id: `cs_e2e_${RUN}_${Math.random().toString(36).slice(2)}`,
    object: 'checkout.session',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 4900,
    currency: 'eur',
    payment_intent: intent.id,
    customer_details: { email: rider.email },
    consent: { terms_of_service: 'accepted' },
    metadata: { product: 'diagnostic', userId: opts.userId ?? rider.id, lang: 'fr' },
  };
  const status = opts.recordSession === false ? 0 : await postSignedStatus('checkout.session.completed', session);
  return { intent, session, status };
}

async function purchases(userId: string) {
  const { data } = await admin.from('diagnostic_purchases').select('*').eq('user_id', userId).order('paid_at');
  return (data ?? []) as Record<string, string | number | null>[];
}

async function p1RouteSecurity() {
  console.log('\nP1 — Route de paiement du diagnostic : prix, compte et retour décidés par le serveur');
  const rider = await createRider('route');
  const other = await createRider('victime');
  const path = '/fr/telechargement/api/create-api-checkout/';
  const post = (body: unknown, token?: string) =>
    fetch(`${SITE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  check((await post({ product: 'diagnostic' })).status === 401, 'sans connexion : refusé (401)');
  check((await post({ product: '__proto__' }, rider.token)).status === 400, 'produit « __proto__ » : refusé (400)');
  check((await post({ product: 'livre' }, rider.token)).status === 400, 'produit hors catalogue : refusé (400)');

  const res = await post(
    {
      product: 'diagnostic',
      priceId: await priceId(LOOKUP.unlimited),
      lookupKey: LOOKUP.unlimited,
      userId: other.id,
      lang: '//evil.com',
      customerEmail: other.email,
    },
    rider.token
  );
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  check(
    res.status === 200 && Boolean(body.url),
    'session créée malgré un corps piégé',
    `HTTP ${res.status} ${body.error ?? ''}`
  );
  const id = new URL(body.url ?? 'http://x/').pathname.split('/').pop()?.split('#')[0] ?? '';
  if (!id.startsWith('cs_')) return;
  const cs = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items'] });
  const price = cs.line_items?.data[0]?.price;
  check(
    price?.lookup_key === 'diagnostic_preorder',
    'prix imposé par le serveur (diagnostic), priceId du corps ignoré',
    String(price?.lookup_key)
  );
  check(cs.metadata?.userId === rider.id, 'compte crédité = celui du jeton, userId du corps ignoré');
  check(cs.customer_email === rider.email, 'e-mail = celui du compte, pas celui du corps');
  check(
    new URL(cs.success_url ?? '').host === new URL(SITE).host,
    'URL de retour sur le site (langue piégée ignorée)',
    cs.success_url ?? ''
  );
  await stripe.checkout.sessions.expire(id);
}

/** Route de paiement du diagnostic, avec le jeton du cycliste : code HTTP. */
async function diagCheckout(rider: Bf) {
  const res = await fetch(`${SITE}/fr/telechargement/api/create-api-checkout/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rider.token}` },
    body: JSON.stringify({ product: 'diagnostic', lang: 'fr' }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  const id = new URL(body.url ?? 'http://x/').pathname.split('/').pop()?.split('#')[0] ?? '';
  if (id.startsWith('cs_')) await stripe.checkout.sessions.expire(id);
  return { status: res.status, error: body.error };
}

/** Termine le diagnostic en cours du cycliste (comme l'application). */
async function completeDiagnostic(rider: Bf) {
  const { error } = await rider.client
    .from('diagnostic_basic')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('user_id', rider.id)
    .eq('status', 'in_progress');
  if (error) throw new Error(`fin du diagnostic : ${error.message}`);
}

async function p2MultiplePurchases() {
  console.log('\nP2 — Un diagnostic à la fois : second achat bloqué, doublon payé remboursé, rejeux sans effet');
  const rider = await createRider('multi');
  const a = await payDiagnostic(rider);
  check(a.status === 200, 'premier achat enregistré');
  const blocked = await diagCheckout(rider);
  check(
    blocked.status === 409 && blocked.error === 'E_ALREADY_OWNED',
    'achat non utilisé : second paiement refusé avant Stripe',
    `HTTP ${blocked.status}`
  );

  // Deux pages de paiement ouvertes avant le blocage, payées l'une après l'autre.
  const b = await payDiagnostic(rider);
  check(b.status === 200, 'second paiement reçu par le webhook (200)');
  const rows = await purchases(rider.id);
  const dup = rows.find((r) => r.stripe_payment_intent_id === b.intent.id);
  check(rows.length === 2 && Boolean(dup?.refunded_at), 'doublon enregistré comme remboursé, jamais utilisable');
  const refunds = await stripe.refunds.list({ payment_intent: b.intent.id });
  check(
    refunds.data[0]?.amount === 4900,
    'doublon remboursé chez Stripe : 49,00 €',
    `${(refunds.data[0]?.amount ?? 0) / 100} €`
  );

  // Rejeux : même événement, événement « async », doublon rejoué.
  check((await postSignedStatus('checkout.session.completed', a.session)) === 200, 'rejeu du webhook : 200');
  check(
    (await postSignedStatus('checkout.session.async_payment_succeeded', a.session)) === 200,
    'événement « async » de la même session : 200'
  );
  check((await postSignedStatus('checkout.session.completed', b.session)) === 200, 'rejeu du doublon : 200');
  const after = await purchases(rider.id);
  check(after.length === 2, 'toujours 2 lignes', String(after.length));
  check(
    (await stripe.refunds.list({ payment_intent: b.intent.id })).data.length === 1,
    'rejeu du doublon : pas de second remboursement'
  );
  check(!after.find((r) => r.stripe_payment_intent_id === a.intent.id)?.refunded_at, 'le premier achat reste intact');
  check(
    after.every((r) => r.withdrawal_waiver_at),
    'renonciation au droit de rétractation tracée'
  );

  // Diagnostic en cours : toujours bloqué ; terminé : rachat possible.
  await rider.client.rpc('start_diagnostic');
  check((await diagCheckout(rider)).status === 409, 'diagnostic en cours : second achat refusé');
  await completeDiagnostic(rider);
  check((await diagCheckout(rider)).status === 200, 'diagnostic terminé : nouvel achat possible');
  const c = await payDiagnostic(rider);
  const cRow = (await purchases(rider.id)).find((r) => r.stripe_payment_intent_id === c.intent.id);
  check(Boolean(cRow) && !cRow?.refunded_at, 'nouvel achat après un diagnostic terminé : valable');

  const unpaid = { ...a.session, id: `cs_e2e_unpaid_${RUN}`, payment_status: 'unpaid', payment_intent: null };
  check((await postSignedStatus('checkout.session.completed', unpaid)) === 200, 'session non payée : acquittée');
  const book = { ...a.session, id: `cs_e2e_book_${RUN}`, payment_intent: null, metadata: { userId: rider.id } };
  check(
    (await postSignedStatus('checkout.session.completed', book)) === 200,
    'achat du livre (sans produit) : acquitté'
  );
  check((await purchases(rider.id)).length === 3, 'ni la session non payée ni le livre ne créent de diagnostic');

  const ghost = {
    ...a.session,
    id: `cs_e2e_ghost_${RUN}`,
    payment_intent: null,
    metadata: { product: 'diagnostic', userId: '00000000-0000-0000-0000-00000000dead' },
  };
  check(
    (await postSignedStatus('checkout.session.completed', ghost)) === 500,
    'compte inconnu : 500 (Stripe rejoue, alerte visible)'
  );
  const forged = await postSignedStatus(
    'checkout.session.completed',
    { ...a.session, id: `cs_e2e_forged_${RUN}` },
    'whsec_faux'
  );
  check(forged === 400, 'signature invalide : refusée (400)');
  check((await purchases(rider.id)).length === 3, 'aucun achat créé par un appel non signé');
}

async function p3Consumption() {
  console.log('\nP3 — Consommation : un seul diagnostic en cours, pas de double consommation');
  const rider = await createRider('conso');
  await payDiagnostic(rider);
  const [first] = await purchases(rider.id);
  const { data: d1, error: e1 } = await rider.client.rpc('start_diagnostic');
  check(
    !e1 && (d1 as { purchase_id?: string })?.purchase_id === first.id,
    'démarrage : consomme l’achat',
    e1?.message ?? ''
  );
  const { data: d2 } = await rider.client.rpc('start_diagnostic');
  check(
    (d2 as { id?: string })?.id === (d1 as { id?: string })?.id,
    'second démarrage : même diagnostic, rien consommé de plus'
  );
  await completeDiagnostic(rider);
  const { error: e2 } = await rider.client.rpc('start_diagnostic');
  check(
    e2?.message === 'no_diagnostic_entitlement',
    'diagnostic terminé, sans nouvel achat : pas de second',
    e2?.message ?? 'ACCEPTÉ'
  );
  await payDiagnostic(rider);
  const { data: d3, error: e3 } = await rider.client.rpc('start_diagnostic');
  const [, second] = await purchases(rider.id);
  check(!e3 && (d3 as { purchase_id?: string })?.purchase_id === second?.id, 'nouvel achat : nouveau diagnostic');

  // Démarrages simultanés sur un compte à un seul achat.
  const solo = await createRider('conso-solo');
  await payDiagnostic(solo);
  const results = await Promise.all([1, 2, 3, 4].map(() => solo.client.rpc('start_diagnostic')));
  const { count } = await admin
    .from('diagnostic_basic')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', solo.id);
  check(
    count === 1,
    '4 démarrages simultanés : un seul diagnostic créé',
    `${count} ; erreurs : ${results
      .filter((r) => r.error)
      .map((r) => r.error?.message)
      .join(', ')}`
  );
  const soloRows = await purchases(solo.id);
  check(soloRows.length === 1 && Boolean(soloRows[0].consumed_at), 'un seul achat consommé');

  const broke = await createRider('conso-none');
  const { error: e4 } = await broke.client.rpc('start_diagnostic');
  check(e4?.message === 'no_diagnostic_entitlement', 'sans achat : démarrage refusé', e4?.message ?? '');
}

async function p4ClientTampering() {
  console.log('\nP4 — Un cycliste ne peut pas se fabriquer de droits depuis le navigateur');
  const rider = await createRider('tamper');
  await payDiagnostic(rider);
  const { data: d } = await rider.client.rpc('start_diagnostic');
  const diagId = (d as { id: string }).id;

  const ins = await rider.client.from('diagnostic_purchases').insert({
    user_id: rider.id,
    stripe_checkout_session_id: `cs_fake_${RUN}`,
    amount_total: 0,
    currency: 'eur',
  });
  check(Boolean(ins.error), 'créer un achat soi-même : refusé', ins.error?.message ?? 'ACCEPTÉ');
  const upd = await rider.client
    .from('diagnostic_purchases')
    .update({ consumed_at: null })
    .eq('user_id', rider.id)
    .select();
  check(
    Boolean(upd.error) || !upd.data?.length,
    'remettre un achat à « non consommé » : refusé',
    upd.error?.message ?? 'ACCEPTÉ'
  );
  const exp = await rider.client
    .from('diagnostic_basic')
    .update({ expires_at: '2099-01-01' })
    .eq('id', diagId)
    .select();
  check(Boolean(exp.error), 'prolonger son diagnostic : refusé', exp.error?.message ?? 'ACCEPTÉ');
  const done = await rider.client
    .from('diagnostic_basic')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', diagId)
    .select();
  check(!done.error, 'terminer son diagnostic : autorisé (usage normal)', done.error?.message ?? '');
  const reopen = await rider.client
    .from('diagnostic_basic')
    .update({ status: 'in_progress' })
    .eq('id', diagId)
    .select();
  check(Boolean(reopen.error), 'rouvrir un diagnostic terminé : refusé', reopen.error?.message ?? 'ACCEPTÉ');
  const rpc = await rider.client.rpc('record_diagnostic_refund', {
    p_payment_intent_id: 'x',
    p_amount_refunded: 0,
    p_fully_refunded: false,
  });
  check(Boolean(rpc.error), 'fonction de remboursement inaccessible au client', rpc.error?.message ?? 'ACCEPTÉ');
  const other = await createRider('tamper-other');
  const { data: seen } = await other.client.from('diagnostic_purchases').select('id').eq('user_id', rider.id);
  check(!seen?.length, 'les achats d’un autre compte sont invisibles');
}

async function p5Refunds() {
  console.log('\nP5 — Remboursements : achat non utilisé, diagnostic en cours, remboursement partiel');
  const rider = await createRider('refund');
  await payDiagnostic(rider);
  await rider.client.rpc('start_diagnostic');
  await completeDiagnostic(rider);

  // Achat non utilisé remboursé dans Stripe → webhook charge.refunded.
  const b = await payDiagnostic(rider);
  await stripe.refunds.create({ payment_intent: b.intent.id });
  await waitFor(
    'B remboursé',
    async () => (await purchases(rider.id)).find((r) => r.stripe_payment_intent_id === b.intent.id)?.refunded_at
  );
  check(true, 'achat non utilisé remboursé : marqué en base');
  const { error } = await rider.client.rpc('start_diagnostic');
  check(
    error?.message === 'no_diagnostic_entitlement',
    'l’achat remboursé ne peut plus être utilisé',
    error?.message ?? 'ACCEPTÉ'
  );
  check((await diagCheckout(rider)).status === 200, 'après remboursement : rachat possible');

  // Remboursement total pendant un diagnostic en cours → révoqué.
  const c = await payDiagnostic(rider);
  const { data: dc } = await rider.client.rpc('start_diagnostic');
  await stripe.refunds.create({ payment_intent: c.intent.id });
  const revoked = await waitFor('diagnostic révoqué', async () => {
    const { data } = await admin
      .from('diagnostic_basic')
      .select('status')
      .eq('id', (dc as { id: string }).id)
      .single();
    return data?.status === 'revoked' ? data : null;
  });
  check(Boolean(revoked), 'remboursement total pendant le diagnostic : accès retiré');

  // Remboursement partiel : l'accès reste.
  const e = await payDiagnostic(rider);
  check(
    e.status === 200 &&
      !(await purchases(rider.id)).find((r) => r.stripe_payment_intent_id === e.intent.id)?.refunded_at,
    'achat après une révocation : valable'
  );
  await stripe.refunds.create({ payment_intent: e.intent.id, amount: 1000 });
  const partial = await waitFor('remboursement partiel tracé', async () => {
    const r = (await purchases(rider.id)).find((x) => x.stripe_payment_intent_id === e.intent.id);
    return r && Number(r.amount_refunded) === 1000 ? r : null;
  });
  check(!partial.refunded_at, 'remboursement partiel : achat toujours utilisable');
  const { error: e2 } = await rider.client.rpc('start_diagnostic');
  check(!e2, 'démarrage possible après un remboursement partiel', e2?.message ?? '');
}

async function p6RefundBeforePurchase() {
  console.log('\nP6 — Remboursement reçu avant l’achat : rejoué, jamais perdu');
  const rider = await createRider('early-refund');
  const { intent, session } = await payDiagnostic(rider, { recordSession: false });
  const refund = await stripe.refunds.create({ payment_intent: intent.id });
  const charge = await stripe.charges.retrieve(refund.charge as string);
  const early = await postSignedStatus('charge.refunded', charge as unknown as Record<string, unknown>);
  check(early === 500, 'remboursement d’un achat pas encore enregistré : 500 (Stripe rejouera)', `HTTP ${early}`);
  check((await postSignedStatus('checkout.session.completed', session)) === 200, 'achat enregistré ensuite');
  check(
    (await postSignedStatus('charge.refunded', charge as unknown as Record<string, unknown>)) === 200,
    'rejeu du remboursement : 200'
  );
  const [row] = await purchases(rider.id);
  check(Boolean(row?.refunded_at), 'achat marqué remboursé : jamais utilisable');
  const { error } = await rider.client.rpc('start_diagnostic');
  check(error?.message === 'no_diagnostic_entitlement', 'aucun diagnostic pour un achat remboursé');
}

async function p7BfMultiple() {
  console.log('\nP7 — Bike fitter : saisies répétées, rôle, corps piégé');
  await admin.from('bf_business_ids').delete().like('id_key', 'WEB:example.%');
  const bf = await createBf('biz-twice');
  const first = await submitBusinessId(bf, 'example.org');
  const second = await submitBusinessId(bf, 'example.net');
  check(
    first.body.result === 'pending_review' && second.body.result === 'pending_review',
    'deux sites saisis, en attente'
  );
  const { data: ids } = await admin.from('bf_business_ids').select('id_key').eq('user_id', bf.id);
  check(
    ids?.length === 1 && ids[0].id_key === 'WEB:example.net',
    'un seul identifiant par compte : la dernière saisie remplace l’autre'
  );
  const rider = await createRider('not-bf');
  const r = await api('/api/billing/checkout/', rider, { offer: 'essential', lang: 'fr' });
  check(r.status === 403, 'un cycliste ne peut pas souscrire une offre bike fitter', `HTTP ${r.status}`);
  const m = await api('/api/billing/manage/', rider, { action: 'cancel' });
  check(m.status === 404, 'ni gérer un abonnement qu’il n’a pas', `HTTP ${m.status}`);
  const forged = await api('/api/billing/checkout/', bf, {
    offer: 'unlimited',
    lang: 'fr',
    price: 'price_x',
    userId: rider.id,
    trial_end: 9999999999,
  });
  const id = new URL(forged.body.url ?? 'http://x/').pathname.split('/').pop()?.split('#')[0] ?? '';
  if (id.startsWith('cs_')) {
    const cs = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items'] });
    check(
      cs.metadata?.userId === bf.id && cs.line_items?.data[0]?.price?.lookup_key === LOOKUP.unlimited,
      'offre BF : prix et compte décidés par le serveur (corps piégé ignoré)'
    );
    await stripe.checkout.sessions.expire(id);
  }
}

async function s21LaunchAnnual() {
  console.log('\nS21 — Illimité annuel de lancement : 690 € la 1re année, puis 990 €/an');
  const bf = await createBf('launch-year');
  const r = await api('/api/billing/checkout/', bf, { offer: 'unlimited_launch_annual', lang: 'fr' });
  const id = new URL(r.body.url ?? 'http://x/').pathname.split('/').pop()?.split('#')[0] ?? '';
  if (id.startsWith('cs_')) {
    const cs = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items'] });
    check(
      cs.line_items?.data[0]?.price?.lookup_key === LOOKUP.unlimitedLaunchYear,
      'checkout : prix annuel de lancement (690 €)'
    );
    await stripe.checkout.sessions.expire(id);
  } else {
    check(false, 'checkout annuel de lancement créé', `HTTP ${r.status} ${r.body.error ?? ''}`);
  }

  const { data: seatsBefore } = await admin.rpc('bf_launch_seats_remaining');
  const { clock, sub } = await preLaunchSubscription(bf, 'unlimited_launch_annual', LOOKUP.unlimitedLaunchYear);
  const b = await waitFor('offre annuelle de lancement', async () => {
    const row = await billing(bf.id);
    return row?.offer === 'unlimited_launch_annual' ? row : null;
  });
  check(b.plan === 'unlimited_launch', 'plan « lancement » (mêmes droits, mêmes places)');
  const { data: seatsAfter } = await admin.rpc('bf_launch_seats_remaining');
  check(
    (seatsBefore as number) - (seatsAfter as number) === 1,
    'une des 20 places prise',
    `${seatsBefore} → ${seatsAfter}`
  );

  const after = await priceId(LOOKUP.unlimitedYear);
  const sch = await waitFor('schedule 690 → 990', async () => {
    const s2 = await stripe.subscriptions.retrieve(sub.id);
    if (!s2.schedule) return null;
    const x = await stripe.subscriptionSchedules.retrieve(s2.schedule as string);
    return x.phases.some((p) => p.items.some((i) => i.price === after)) ? x : null;
  });
  const anniversary = new Date(BF_AVAILABLE_AT);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  check(
    sch.phases[0].end_date === Math.floor(anniversary.getTime() / 1000),
    '690 € jusqu’au premier anniversaire (1er novembre 2027)',
    new Date(sch.phases[0].end_date * 1000).toISOString()
  );
  check(await nothingChargedBeforeLaunch(sub.id), 'rien avant le 1er novembre 2026');

  const availableAt = Math.floor(BF_AVAILABLE_AT / 1000);
  await advanceStepwise(clock.id, availableAt + 3 * 3600);
  const first = (await stripe.invoices.list({ subscription: sub.id, limit: 10 })).data.find((i) => i.subtotal > 0);
  check(
    first?.subtotal === 69000,
    'premier prélèvement le 1er novembre 2026 : 690,00 € HT',
    `${(first?.subtotal ?? 0) / 100} €`
  );

  await advance(clock.id, Math.floor(anniversary.getTime() / 1000) + 3 * 3600);
  const renewal = (await stripe.invoices.list({ subscription: sub.id, limit: 10 })).data.find(
    (i) => i.subtotal > 0 && i.created >= Math.floor(anniversary.getTime() / 1000)
  );
  check(
    renewal?.subtotal === 99000,
    'renouvellement du 1er novembre 2027 : 990,00 € HT',
    `${(renewal?.subtotal ?? 0) / 100} €`
  );
  const s3 = await stripe.subscriptions.retrieve(sub.id);
  check(s3.items.data[0].price.lookup_key === LOOKUP.unlimitedYear, 'abonnement passé au tarif normal, 990 €/an');
  await waitFor('bf_billing après bascule', async () => (await billing(bf.id))?.offer === 'unlimited_annual');
  check((await billing(bf.id))?.status === 'active', 'toujours actif, passé en Illimité annuel');
}

async function s22LaunchAnnualFull() {
  console.log('\nS22 — Places de lancement épuisées : l’annuel à 690 € est refusé aussi');
  const { data: before } = await admin.rpc('bf_launch_seats_remaining');
  const fillers: string[] = [];
  for (let i = 0; i < (before as number); i++) {
    const { data } = await admin.auth.admin.createUser({ email: `seat-y-${i}-${RUN}@example.com` });
    fillers.push(data.user!.id);
  }
  await admin
    .from('bf_billing')
    .upsert(fillers.map((id) => ({ user_id: id, plan: 'unlimited_launch', status: 'active' })));
  const bf = await createBf('launch-year-full');
  const r = await api('/api/billing/checkout/', bf, { offer: 'unlimited_launch_annual', lang: 'fr' });
  check(r.status === 409 && r.body.error === 'E_LAUNCH_CLOSED', 'annuel de lancement refusé', `HTTP ${r.status}`);
  check(r.body.fallback === 'unlimited_annual', 'offre proposée à la place : Illimité annuel (990 €)');
  await admin.from('bf_billing').delete().in('user_id', fillers);
  for (const id of fillers) await admin.auth.admin.deleteUser(id);
}

async function p8RoleSeparation() {
  console.log('\nP8 — Rôles : un bike fitter n’achète pas le Diagnostic, un cycliste pas d’offre BF');
  const bf = await createBf('no-diag');
  const res = await fetch(`${SITE}/fr/telechargement/api/create-api-checkout/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bf.token}` },
    body: JSON.stringify({ product: 'diagnostic', lang: 'fr' }),
  });
  check(res.status === 403, 'bike fitter → Diagnostic : refusé (403)', `HTTP ${res.status}`);
  const rider = await createRider('no-bf');
  for (const offer of ['essential', 'unlimited_launch', 'unlimited_launch_annual']) {
    const r = await api('/api/billing/checkout/', rider, { offer, lang: 'fr' });
    check(r.status === 403, `cycliste → offre BF « ${offer} » : refusé (403)`, `HTTP ${r.status}`);
  }
  const t = await api('/api/billing/business-id/', rider, { id: DANONE_SIREN });
  check(t.status === 403, 'cycliste → analyses offertes BF : refusé (403)', `HTTP ${t.status}`);
}

async function s23AnchoredUsage() {
  console.log('\nS23 — Souscription ancrée au 1er novembre : ce que devient l’usage d’octobre');
  const bf = await createBf('anchored-essential');
  const { clock, sub } = await preLaunchSubscription(bf, 'essential', LOOKUP.essentialBase, [LOOKUP.essentialUsage]);
  await waitFor('offre Essentiel', async () => (await billing(bf.id))?.stripe_subscription_id === sub.id);
  const b = await billing(bf.id);
  check(
    b?.status === 'active' && b?.plan === 'essential',
    'abonné tout de suite (statut actif, pas d’essai)',
    String(sub.status)
  );

  // Deux analyses datées du 10 octobre (horloge avancée au 15).
  const clients = await createClients(bf, 2);
  for (const c of clients) await register(bf, c);
  await admin
    .from('bf_analyses')
    .update({
      counted_at: new Date(Date.UTC(2026, 9, 10, 12)).toISOString(),
      meter_claimed_at: null,
      meter_last_error: null,
    })
    .eq('user_id', bf.id);
  await advance(clock.id, Math.floor(Date.UTC(2026, 9, 15, 12) / 1000));
  await reportUsage();
  await waitFor(
    'meter events envoyés',
    async () => {
      const { count } = await admin
        .from('bf_analyses')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', bf.id)
        .is('meter_reported_at', null);
      return count === 0;
    },
    90_000
  );
  await sleep(30_000);

  await advance(clock.id, Math.floor(BF_AVAILABLE_AT / 1000) + 3 * 3600);
  const invoices = (await stripe.invoices.list({ subscription: sub.id, limit: 10 })).data;
  const nov = invoices.find((i) => i.created >= Math.floor(BF_AVAILABLE_AT / 1000));
  console.log(
    `    (facture du 1er novembre : ${(nov?.subtotal ?? 0) / 100} € HT — lignes : ${nov?.lines.data
      .map(
        (l) =>
          `${l.amount / 100} € ${new Date(l.period.start * 1000).toISOString().slice(0, 10)}→${new Date(l.period.end * 1000).toISOString().slice(0, 10)}`
      )
      .join(', ')})`
  );
  check(Boolean(nov), 'facture émise au 1er novembre');
  check(await nothingChargedBeforeLaunch(sub.id), 'rien de prélevé avant le 1er novembre');
}

/** Abonnement en essai gratuit (test clock), comme Checkout le crée pour un premier abonnement. */
async function trialSubscription(bf: Bf, offer: string, lookups: string[], start: number, trialDays = 14) {
  const { clock, customer } = await clockCustomer(bf, start);
  const metered = [LOOKUP.essentialUsage] as string[];
  const items = [];
  for (const key of lookups)
    items.push(metered.includes(key) ? { price: await priceId(key) } : { price: await priceId(key), quantity: 1 });
  const trialEnd = start + trialDays * 86400;
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items,
    metadata: metadata(bf, offer),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
    trial_end: trialEnd,
  });
  return { clock, customer, sub, trialEnd };
}

async function s25TrialEssential() {
  console.log('\nS25 — Essai de 14 jours (Essentiel) : analyses gratuites, premier prélèvement 20 € à la fin');
  const bf = await createBf('trial-essential');
  const start = Math.floor(Date.now() / 1000) - 3600;
  const { clock, sub, trialEnd } = await trialSubscription(
    bf,
    'essential',
    [LOOKUP.essentialBase, LOOKUP.essentialUsage],
    start
  );
  check(sub.status === 'trialing', 'Stripe : abonnement en essai (trialing)');
  const b = await waitFor('essai enregistré', async () => {
    const row = await billing(bf.id);
    return row?.plan === 'essential' && row?.trial_ends_at ? row : null;
  });
  check(
    new Date(b.trial_ends_at!).getTime() === trialEnd * 1000 && b.status === 'active',
    'base : offre Essentiel, fin de l’essai enregistrée, accès complet',
    String(b.trial_ends_at)
  );

  const clients = await createClients(bf, 3);
  const during = [];
  for (const c of clients) during.push(await register(bf, c));
  check(
    during.every((r) => r.status === 'counted'),
    '3 analyses pendant l’essai : comptées'
  );
  const { data: rows } = await admin
    .from('bf_analyses')
    .select('billing_mode, stripe_meter_event_identifier')
    .eq('user_id', bf.id);
  check(
    (rows ?? []).length === 3 &&
      (rows ?? []).every((r) => r.billing_mode === 'trial' && !r.stripe_meter_event_identifier),
    'analyses de l’essai : gratuites, rien envoyé au meter'
  );
  const sm = (await summary(bf)) as { billable_in_period?: number; analyses_in_period?: number };
  check(sm.billable_in_period === 0 && sm.analyses_in_period === 3, 'espace BF : 3 analyses, 0 facturable');
  const early = await stripe.invoices.list({ subscription: sub.id, limit: 5 });
  check(
    early.data.every((i) => i.total === 0),
    'rien de prélevé pendant l’essai'
  );

  await advance(clock.id, trialEnd + 2 * 3600);
  const first = await waitFor('première facture après l’essai', async () => {
    const list = await stripe.invoices.list({ subscription: sub.id, limit: 5 });
    return list.data.find((i) => i.subtotal > 0 && i.status === 'paid');
  });
  check(
    first.subtotal === 2000,
    'fin de l’essai : premier prélèvement, forfait 20,00 € HT',
    `${first.subtotal / 100} €`
  );
  const live = await stripe.subscriptions.retrieve(sub.id);
  check(live.status === 'active', 'Stripe : abonnement actif après l’essai');
}

async function s26CancelDuringTrial() {
  console.log('\nS26 — Résiliation pendant l’essai : rien de prélevé ; ensuite, plus d’essai');
  const bf = await createBf('trial-cancel');
  const start = Math.floor(Date.now() / 1000) - 3600;
  const { clock, sub, trialEnd } = await trialSubscription(bf, 'unlimited', [LOOKUP.unlimited], start);
  await waitFor('essai enregistré', async () => Boolean((await billing(bf.id))?.trial_ends_at));

  const r = await api('/api/billing/manage/', bf, { action: 'cancel' });
  check(r.status === 200, 'résiliation depuis l’espace', `HTTP ${r.status}`);
  const b = await billing(bf.id);
  check(
    new Date(b?.cancel_at ?? 0).getTime() === trialEnd * 1000,
    'fin programmée à la fin de l’essai',
    String(b?.cancel_at)
  );

  await advance(clock.id, trialEnd + 2 * 3600);
  await waitFor('abonnement terminé', async () => (await stripe.subscriptions.retrieve(sub.id)).status === 'canceled');
  const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 10 });
  check(
    invoices.data.every((i) => (i.amount_paid ?? 0) === 0),
    'aucun prélèvement',
    invoices.data.map((i) => i.amount_paid).join(', ')
  );
  const after = await waitFor('base : plus d’abonnement', async () => {
    const row = await billing(bf.id);
    return row?.plan === 'trial' && !row?.stripe_subscription_id ? row : null;
  });
  check(Boolean(after.trial_ends_at), 'essai marqué utilisé');
  const [c] = await createClients(bf, 1);
  const refused = await register(bf, c);
  check(
    refused.status === 'refused' && refused.reason === 'no_credits',
    'analyse refusée (no_credits : « choisissez une offre » dans l’app)'
  );

  const again = await api('/api/billing/checkout/', bf, { offer: 'essential', lang: 'fr' });
  check(again.status === 200, 'nouvelle souscription possible', `HTTP ${again.status}`);
  const sessionId = new URL(again.body.url ?? 'http://x/').pathname.split('/').pop()?.split('#')[0] ?? '';
  if (sessionId.startsWith('cs_')) {
    const cs = await stripe.checkout.sessions.retrieve(sessionId);
    check(!cs.custom_text?.submit, 'sans nouvel essai (pas d’annonce d’essai au paiement)');
  }
  const biz = await submitBusinessId(bf, DANONE_SIREN);
  check(biz.status === 409, 'pas de second essai par l’identifiant', `HTTP ${biz.status}`);
}

async function s27UpgradeNextPeriod() {
  const afterPrice = await priceId(LOOKUP.unlimited);
  console.log('\nS27 — Essentiel au-delà de 7 analyses : Illimité programmé pour la période suivante');
  const bf = await createBf('upgrade');
  const { clock, sub } = await clockSubscription(bf, 'essential', [LOOKUP.essentialBase, LOOKUP.essentialUsage]);
  await waitFor('offre Essentiel', async () => (await billing(bf.id))?.plan === 'essential');
  const clients = await createClients(bf, 7);
  for (const c of clients) await register(bf, c);
  const sm = (await summary(bf)) as { analyses_in_period?: number };
  check(sm.analyses_in_period === 7, 'espace BF : 7 analyses sur la période (proposition affichée)');

  const r = await api('/api/billing/manage/', bf, { action: 'change', offer: 'unlimited_launch', when: 'next_period' });
  check(
    r.status === 200 && r.body.effective === 'period_end',
    'Illimité programmé à la fin de la période',
    `HTTP ${r.status}`
  );
  const b = await billing(bf.id);
  check(
    b?.plan === 'essential' && b?.scheduled_offer === 'unlimited_launch',
    'base : toujours Essentiel, changement programmé',
    `${b?.plan} → ${b?.scheduled_offer}`
  );
  const live = await stripe.subscriptions.retrieve(sub.id);
  const schedule = await stripe.subscriptionSchedules.retrieve(live.schedule as string);
  check(schedule.metadata?.aerox_schedule === 'upgrade', 'schedule « upgrade »');

  await advance(clock.id, Math.floor(Date.now() / 1000) + 120);
  await reportUsage();
  await advance(clock.id, sub.items.data[0].current_period_end + 2 * 3600);
  await waitFor('passage en Illimité', async () => (await billing(bf.id))?.plan === 'unlimited_launch', 120_000);
  check(true, 'à l’échéance : offre de lancement Illimité');
  const after = await stripe.subscriptions.retrieve(sub.id);
  check(
    after.items.data.length === 1 && after.items.data[0].price.lookup_key === LOOKUP.unlimitedLaunch,
    'abonnement : une ligne, Illimité 69 €'
  );
  const cycle = await waitFor('facture de l’échéance', async () => {
    const list = await stripe.invoices.list({ subscription: sub.id, limit: 5 });
    return list.data.find((i) => i.lines.data.some((l) => l.amount === 6900));
  });
  check(Boolean(cycle), 'échéance : Illimité 69,00 € HT facturé');
  const b2 = await waitFor('changement appliqué', async () => {
    const row = await billing(bf.id);
    return row && !row.scheduled_offer ? row : null;
  });
  check(Boolean(b2), 'plus de changement en attente');
  const launch = await waitFor(
    'bascule de lancement posée',
    async () => {
      const x = await stripe.subscriptions.retrieve(sub.id);
      if (!x.schedule) return null;
      const sch = await stripe.subscriptionSchedules.retrieve(x.schedule as string);
      return sch.metadata?.aerox_schedule === 'launch' ? sch : null;
    },
    120_000
  );
  check(
    launch.phases.some((p) => p.items.some((i) => (typeof i.price === 'string' ? i.price : i.price.id) === afterPrice)),
    'bascule au tarif normal (99 €) posée après le changement'
  );
}

async function s28LaunchTrialCrossesSwitch() {
  console.log('\nS28 — Lancement mensuel souscrit fin décembre : essai au-delà du 01/01, bascule à la fin de l’essai');
  const bf = await createBf('launch-dec');
  const start = Math.floor(Date.UTC(2026, 11, 25, 12) / 1000);
  const { clock, sub, trialEnd } = await trialSubscription(bf, 'unlimited_launch', [LOOKUP.unlimitedLaunch], start);
  const schedule = await waitFor('schedule de lancement', async () => {
    const s = await stripe.subscriptions.retrieve(sub.id);
    if (!s.schedule) return null;
    const sch = await stripe.subscriptionSchedules.retrieve(s.schedule as string);
    const after = await priceId(LOOKUP.unlimited);
    return sch.phases.some((p) => p.items.some((i) => i.price === after)) ? sch : null;
  });
  check(
    schedule.phases[0].end_date === trialEnd && schedule.phases[0].trial_end === trialEnd,
    'phase de lancement jusqu’à la fin de l’essai (après le 01/01/2027)'
  );
  await advance(clock.id, trialEnd + 2 * 3600);
  const first = await waitFor('première facture', async () => {
    const list = await stripe.invoices.list({ subscription: sub.id, limit: 5 });
    return list.data.find((i) => i.subtotal > 0);
  });
  check(first.subtotal === 9900, 'premier prélèvement au tarif normal : 99,00 € HT', `${first.subtotal / 100} €`);
}

const ALL: Record<string, () => Promise<void>> = {
  s1: s1Essential,
  s2: s2Essential14,
  s4: s4LaunchFull,
  s5: s5LaunchSwitch,
  s6: s6PaymentFailure,
  s7: s7ReverseCharge,
  s8: s8BusinessId,
  s9: s9Downgrade,
  s10: s10Annual,
  s11: s11LaunchCancel,
  s12: s12Duplicate,
  s13: s13AnnualPreLaunch,
  s14: s14SeatRelease,
  s15: s15ChangeWhileCancelled,
  s16: s16CheckoutExpire,
  s17: s17FirstPaymentDeclined,
  s18: s18AuthRequiredThenRecovery,
  s19: s19PreLaunchFirstChargeFails,
  s20: s20PastDueCancelAndResubscribe,
  s21: s21LaunchAnnual,
  s22: s22LaunchAnnualFull,
  s23: s23AnchoredUsage,
  s24: s24ManualReview,
  s25: s25TrialEssential,
  s26: s26CancelDuringTrial,
  s27: s27UpgradeNextPeriod,
  s28: s28LaunchTrialCrossesSwitch,
  p1: p1RouteSecurity,
  p2: p2MultiplePurchases,
  p3: p3Consumption,
  p4: p4ClientTampering,
  p5: p5Refunds,
  p6: p6RefundBeforePurchase,
  p7: p7BfMultiple,
  p8: p8RoleSeparation,
};

const wanted = process.argv.slice(2).filter((a) => a in ALL);
for (const name of wanted.length ? wanted : Object.keys(ALL)) {
  try {
    await ALL[name]();
  } catch (err) {
    check(false, `${name} interrompu`, err instanceof Error ? err.message : String(err));
  }
}
console.log(`\n${failures ? `✘ ${failures} échec(s)` : '✔ tous les contrôles passent'}`);
process.exit(failures ? 1 : 0);
