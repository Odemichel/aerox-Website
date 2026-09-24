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
import { LAUNCH_OFFER, LOOKUP } from '../src/lib/billing/catalog.ts';

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
async function createBf(tag: string): Promise<Bf> {
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
  const metered = [LOOKUP.payg, LOOKUP.studioUsage] as string[];
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
  await sleep(20_000); // agrégation asynchrone des meter events chez Stripe
  await advance(clockId, sub.items.data[0].current_period_end + 2 * 3600);
  return waitFor('facture de fin de période', async () => {
    const list = await stripe.invoices.list({ subscription: sub.id, limit: 5 });
    return list.data.find((i) => i.billing_reason === 'subscription_cycle');
  });
}

async function s1Payg() {
  console.log('\nS1 — À l’usage : 3 analyses → 3 × 20 € = 60 € HT, sans forfait');
  const bf = await createBf('payg');
  const b0 = await billing(bf.id);
  check(
    b0?.plan === 'trial' && b0?.trial_state === 'needs_card',
    'inscription : compte actif, essai en attente de carte'
  );

  const r = await api('/api/billing/checkout/', bf, { offer: 'payg', lang: 'fr' });
  check(r.status === 200 && typeof r.body.url === 'string', 'checkout À l’usage créé par la route', `HTTP ${r.status}`);
  const sessionId = new URL(r.body.url ?? 'http://x/').pathname.split('/').pop()?.split('#')[0] ?? '';
  if (sessionId.startsWith('cs_')) {
    const cs = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
    check(
      cs.mode === 'subscription' && cs.line_items?.data.length === 1,
      'session : abonnement, une seule ligne mesurée'
    );
    check(
      cs.automatic_tax.enabled === true && cs.tax_id_collection?.enabled === true,
      'session : Stripe Tax + n° de TVA'
    );
  }

  const { clock, sub } = await clockSubscription(bf, 'payg', [LOOKUP.payg]);
  await waitFor('offre à l’usage', async () => (await billing(bf.id))?.plan === 'payg');
  check(true, 'webhook : offre À l’usage active');
  const invoice = await usageInvoice(bf, clock.id, sub, 3);
  check(invoice.subtotal === 6000, 'facture HT : 60,00 €', `${invoice.subtotal / 100} € HT`);
  const tax = (invoice.total_taxes ?? []).reduce((a, t) => a + t.amount, 0);
  check(tax === 1200, 'TVA FR 20 % : 12,00 €', `${tax / 100} €`);
}

async function s2Studio() {
  console.log('\nS2 + S3 — Studio : 14 analyses (+ re-tests) → 79 € + 9 × 10 € = 169 € HT');
  const bf = await createBf('studio');
  const { clock, sub } = await clockSubscription(bf, 'studio', [LOOKUP.studioBase, LOOKUP.studioUsage]);
  await waitFor('offre studio', async () => (await billing(bf.id))?.plan === 'studio');
  check(true, 'webhook : offre Studio active');

  // S3 : le même client re-testé 3 fois dans les 30 jours → 1 seule analyse.
  const [first] = await createClients(bf, 1);
  await register(bf, first);
  const retests = [await register(bf, first), await register(bf, first), await register(bf, first)];
  check(
    retests.every((r) => r.status === 'already_counted'),
    'S3 : 3 re-tests du même client non comptés'
  );

  const invoice = await usageInvoice(bf, clock.id, sub, 13);
  const { count } = await admin.from('bf_analyses').select('id', { count: 'exact', head: true }).eq('user_id', bf.id);
  check(count === 14, '14 analyses en base');
  check(invoice.subtotal === 16900, 'facture HT : 169,00 €', `${invoice.subtotal / 100} € HT`);
  const tax = (invoice.total_taxes ?? []).reduce((a, t) => a + t.amount, 0);
  check(tax === 3380, 'TVA FR 20 % : 33,80 €', `${tax / 100} €`);
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
  check(r.body.fallback === 'unlimited', 'offre proposée à la place : Illimité (119 €)');
  const r2 = await api('/api/billing/checkout/', bf, { offer: 'unlimited', lang: 'fr' });
  check(r2.status === 200, 'Illimité reste souscriptible', `HTTP ${r2.status}`);

  await admin.from('bf_billing').delete().in('user_id', fillers);
  for (const id of fillers) await admin.auth.admin.deleteUser(id);
}

async function s5LaunchSwitch() {
  console.log('\nS5 — Offre de lancement : bascule à 99 € au 01/01/2027');
  const bf = await createBf('launch');
  const { clock, customer } = await clockCustomer(bf, Math.floor(Date.now() / 1000));
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: await priceId(LOOKUP.unlimitedLaunch), quantity: 1 }],
    metadata: metadata(bf, 'unlimited_launch'),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
  });
  await waitFor('offre de lancement', async () => (await billing(bf.id))?.plan === 'unlimited_launch');
  // Le webhook crée puis configure le schedule : on attend la phase à 99 €.
  const schedule = await waitFor('schedule configuré par le webhook', async () => {
    const s = await stripe.subscriptions.retrieve(sub.id);
    if (!s.schedule) return null;
    const sch = await stripe.subscriptionSchedules.retrieve(s.schedule as string);
    return sch.phases.length >= 2 ? sch : null;
  });
  const switchAt = Math.floor(LAUNCH_OFFER.switchAt / 1000);
  check(schedule.phases[0].end_date === switchAt, 'phase 1 jusqu’au 01/01/2027 00:00 (Paris)');
  const phase2Price = schedule.phases[1]?.items[0]?.price;
  check(phase2Price === (await priceId(LOOKUP.unlimitedLaunchAfter)), 'phase 2 : prix 99 €');

  await advanceStepwise(clock.id, switchAt + 45 * 86400);
  const after = await stripe.subscriptions.retrieve(sub.id);
  check(after.items.data[0].price.lookup_key === LOOKUP.unlimitedLaunchAfter, 'abonnement passé au prix 99 €');
  const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 10 });
  // 99 € dès le 01/01 : la période à cheval est régularisée au prorata
  // (crédit sur le prix à 69 €, débit sur le prix à 99 €, tous deux datés du
  // 01/01) sur l'échéance suivante, qui facture ensuite 99 € plein.
  const lines = invoices.data.flatMap((i) => i.lines.data);
  const prorations = lines.filter((l) => l.period.start === switchAt);
  const prorated = prorations.reduce((a, l) => a + l.amount, 0);
  // Bornes de la période à cheval, à l'heure exacte de l'ancre de facturation.
  const anchor = new Date(sub.billing_cycle_anchor * 1000);
  const boundary = (monthsAfterAnchor: number) => {
    const d = new Date(anchor);
    d.setUTCMonth(d.getUTCMonth() + monthsAfterAnchor);
    return Math.floor(d.getTime() / 1000);
  };
  let k = 0;
  while (boundary(k + 1) <= switchAt) k++;
  const periodStart = boundary(k);
  const periodEnd = boundary(k + 1);
  const expected = Math.round((3000 * (periodEnd - switchAt)) / (periodEnd - periodStart));
  check(prorations.length >= 2, 'prorata au 01/01 : crédit 69 € et débit 99 €', `${prorations.length} ligne(s)`);
  check(
    Math.abs(prorated - expected) <= 2,
    'régularisation = 30 € × jours restants',
    `${prorated / 100} € (attendu ≈ ${expected / 100} €)`
  );
  const full99 = lines.some((l) => l.period.start > switchAt && l.amount === 9900);
  check(full99, 'échéance suivante : 99,00 € HT plein');
  await waitFor('bf_billing après bascule', async () => (await billing(bf.id))?.plan === 'unlimited_launch');
  check((await billing(bf.id))?.status === 'active', 'toujours actif, offre « lancement » conservée');
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

/** Webhook signé avec le vrai secret, pour un événement que Stripe ne peut pas produire sans navigateur. */
async function postSignedEvent(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({
    id: `evt_e2e_${RUN}_${Math.random().toString(36).slice(2)}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: env('E2E_WEBHOOK_SECRET') });
  const res = await fetch(`${SITE}/api/stripe-webhook/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  if (!res.ok) throw new Error(`webhook: HTTP ${res.status}`);
}

/** Carte d'essai réelle (SetupIntent confirmé) pour un bike fitter, puis Checkout « setup » simulé. */
async function registerTrialCard(bf: Bf) {
  const customer = await stripe.customers.create({ email: bf.email, metadata: { userId: bf.id, aerox_e2e: '1' } });
  await admin.from('bf_billing').update({ stripe_customer_id: customer.id }).eq('user_id', bf.id);
  const intent = await stripe.setupIntents.create({
    customer: customer.id,
    payment_method: 'pm_card_visa',
    payment_method_types: ['card'],
    usage: 'off_session',
    confirm: true,
  });
  await postSignedEvent('checkout.session.completed', {
    id: `cs_e2e_${RUN}_${bf.id.slice(0, 8)}`,
    object: 'checkout.session',
    mode: 'setup',
    status: 'complete',
    customer: customer.id,
    setup_intent: intent.id,
    metadata: { userId: bf.id, aerox_offer: 'trial_card' },
  });
}

async function s8TrialCard() {
  console.log('\nS8 — Essai : 2 analyses débloquées par une carte, une carte = un essai');
  // Les cartes de test ont une empreinte fixe : on repart d'une table vide
  // (base locale uniquement, voir le garde-fou en tête de script).
  await admin.from('bf_trial_cards').delete().neq('fingerprint', '');
  const bf = await createBf('trial');
  const [c1, c2, c3] = await createClients(bf, 3);
  const before = await register(bf, c1);
  check(before.status === 'refused' && before.reason === 'needs_card', 'sans carte : analyse refusée (needs_card)');

  const r = await api('/api/billing/trial-card/', bf, { lang: 'fr' });
  check(r.status === 200 && typeof r.body.url === 'string', 'route trial-card : Checkout créé', `HTTP ${r.status}`);
  const sessionId = new URL(r.body.url ?? 'http://x/').pathname.split('/').pop()?.split('#')[0] ?? '';
  if (sessionId.startsWith('cs_')) {
    const cs = await stripe.checkout.sessions.retrieve(sessionId);
    check(cs.mode === 'setup' && cs.metadata?.aerox_offer === 'trial_card', 'session en mode setup (0 € débité)');
  }

  await registerTrialCard(bf);
  const b = await waitFor('essai débloqué', async () => {
    const row = await billing(bf.id);
    return row?.trial_state === 'granted' ? row : null;
  });
  check(Boolean(b), 'carte enregistrée : essai débloqué');
  check((await register(bf, c1)).status === 'counted', 'analyse 1 comptée');
  check((await register(bf, c2)).status === 'counted', 'analyse 2 comptée');
  check((await register(bf, c3)).reason === 'no_credits', '3e analyse refusée : essai épuisé');

  // Même carte (même empreinte) sur un second compte : pas de second essai.
  const other = await createBf('trial-bis');
  await registerTrialCard(other);
  const o = await waitFor('carte déjà utilisée', async () => {
    const row = await billing(other.id);
    return row?.trial_state === 'card_already_used' ? row : null;
  });
  check(Boolean(o), 'même carte, autre compte : essai refusé');
  const { count } = await admin.from('bf_credits').select('id', { count: 'exact', head: true }).eq('user_id', other.id);
  check(count === 0, 'aucun crédit pour le second compte');
  const r2 = await api('/api/billing/trial-card/', other, { lang: 'fr' });
  check(r2.status === 409, 'route trial-card refusée une fois la carte utilisée', `HTTP ${r2.status}`);
}

async function s9Downgrade() {
  console.log('\nS9 — Descente Illimité → Studio : effective à la fin de la période payée');
  const bf = await createBf('downgrade');
  const { clock, sub } = await clockSubscription(bf, 'unlimited', [LOOKUP.unlimited], Math.floor(Date.now() / 1000));
  await waitFor('offre illimitée', async () => (await billing(bf.id))?.plan === 'unlimited');
  const r = await api('/api/billing/manage/', bf, { action: 'change', offer: 'studio' });
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
  await waitFor('passage en Studio', async () => (await billing(bf.id))?.plan === 'studio', 120_000);
  check(true, 'après l’échéance : offre Studio');
  const after = await stripe.subscriptions.retrieve(sub.id);
  check(
    after.items.data
      .map((i) => i.price.lookup_key)
      .sort()
      .join() === [LOOKUP.studioBase, LOOKUP.studioUsage].sort().join(),
    'abonnement : forfait Studio + ligne mesurée'
  );

  // Remontée : immédiate.
  const up = await api('/api/billing/manage/', bf, { action: 'change', offer: 'unlimited' });
  check(up.status === 200 && up.body.effective === 'now', 'remontée en Illimité immédiate');
  await waitFor('retour en Illimité', async () => (await billing(bf.id))?.plan === 'unlimited');
  check(true, 'webhook : Illimité de nouveau actif');
}

async function s10Annual() {
  console.log('\nS10 — Illimité annuel : 1 190 € HT / an');
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
    invoices.data[0]?.subtotal === 119000,
    'première facture : 1 190,00 € HT',
    `${(invoices.data[0]?.subtotal ?? 0) / 100} €`
  );
  const b = await billing(bf.id);
  const days =
    (new Date(b?.current_period_end ?? 0).getTime() - new Date(b?.current_period_start ?? 0).getTime()) / 86400000;
  check(days > 360, 'période d’un an enregistrée', `${Math.round(days)} j`);
}

const ALL: Record<string, () => Promise<void>> = {
  s1: s1Payg,
  s2: s2Studio,
  s4: s4LaunchFull,
  s5: s5LaunchSwitch,
  s6: s6PaymentFailure,
  s7: s7ReverseCharge,
  s8: s8TrialCard,
  s9: s9Downgrade,
  s10: s10Annual,
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
