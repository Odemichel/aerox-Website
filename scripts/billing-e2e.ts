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

import { execFileSync } from 'node:child_process';
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

async function s1Pack() {
  console.log('\nS1 — Pack : facture PDF, 10 crédits, 11e analyse refusée');
  const bf = await createBf('pack');
  const b0 = await billing(bf.id);
  check(b0?.plan === 'trial', 'inscription : compte actif en essai');

  // La route du site crée une session valide (paiement unique + facture).
  const r = await api('/api/billing/checkout/', bf, { offer: 'pack', lang: 'fr' });
  check(r.status === 200 && typeof r.body.url === 'string', 'checkout Pack créé par la route', `HTTP ${r.status}`);
  const sessionId = new URL(r.body.url).pathname.split('/').pop()?.split('#')[0] ?? '';
  if (sessionId.startsWith('cs_')) {
    const cs = await stripe.checkout.sessions.retrieve(sessionId);
    check(cs.mode === 'payment' && cs.invoice_creation?.enabled === true, 'session : mode payment + invoice_creation');
    check(
      cs.automatic_tax.enabled === true && cs.tax_id_collection?.enabled === true,
      'session : Stripe Tax + n° de TVA'
    );
  }

  // Paiement simulé par le Stripe CLI (session réelle, carte de test), avec
  // les métadonnées que poserait notre route.
  await admin.from('bf_credits').update({ remaining: 0 }).eq('user_id', bf.id).eq('source', 'trial');
  execFileSync(
    'stripe',
    [
      'trigger',
      'checkout.session.completed',
      '--add',
      `checkout_session:metadata.userId=${bf.id}`,
      '--add',
      'checkout_session:metadata.aerox_offer=pack',
      '--add',
      'checkout_session:invoice_creation.enabled=true',
    ],
    { stdio: 'ignore', env: { ...process.env, STRIPE_API_KEY: STRIPE_KEY } }
  );

  const credit = await waitFor('crédits du pack', async () => {
    const { data } = await admin
      .from('bf_credits')
      .select('*')
      .eq('user_id', bf.id)
      .neq('source', 'trial')
      .maybeSingle();
    return data;
  });
  check(credit.granted === 10 && credit.remaining === 10, '10 crédits crédités par le webhook');
  const months = (new Date(credit.expires_at).getTime() - Date.now()) / (30.4 * 86400 * 1000);
  check(months > 11.8 && months < 12.2, 'crédits valables 12 mois');
  check((await billing(bf.id))?.plan === 'pack', 'offre : pack');

  const cs = await stripe.checkout.sessions.retrieve(credit.source, { expand: ['invoice'] });
  const invoice = cs.invoice as Stripe.Invoice | null;
  check(Boolean(invoice?.invoice_pdf), 'facture PDF générée', invoice?.invoice_pdf ? 'invoice_pdf présent' : 'absente');

  const clients = await createClients(bf, 11);
  let counted = 0;
  for (const c of clients.slice(0, 10)) if ((await register(bf, c)).status === 'counted') counted++;
  check(counted === 10, '10 analyses comptées');
  const eleventh = await register(bf, clients[10]);
  check(eleventh.status === 'refused' && eleventh.reason === 'no_credits', '11e analyse refusée (no_credits)');

  // Idempotence : un rejeu de l'événement ne crédite pas deux fois.
  const events = await stripe.events.list({ type: 'checkout.session.completed', limit: 5 });
  const evt = events.data.find((e) => (e.data.object as Stripe.Checkout.Session).id === credit.source);
  if (evt) {
    execFileSync('stripe', ['events', 'resend', evt.id], {
      stdio: 'ignore',
      env: { ...process.env, STRIPE_API_KEY: STRIPE_KEY },
    });
    await sleep(5000);
    const { count } = await admin
      .from('bf_credits')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', bf.id)
      .neq('source', 'trial');
    check(count === 1, 'rejeu du webhook : pas de double crédit');
  }
}

async function s2Studio() {
  console.log('\nS2 + S3 — Studio : 14 analyses (+ re-tests) → 69 € + 4 × 8 € = 101 € HT');
  const bf = await createBf('studio');
  const start = Math.floor(Date.now() / 1000) - 3600;
  const { clock, customer } = await clockCustomer(bf, start);
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: await priceId(LOOKUP.studioBase), quantity: 1 }, { price: await priceId(LOOKUP.studioUsage) }],
    metadata: metadata(bf, 'studio'),
    automatic_tax: { enabled: true },
    billing_mode: { type: 'flexible' },
  });
  await waitFor('offre studio', async () => (await billing(bf.id))?.plan === 'studio');
  check(true, 'webhook : offre Studio active');

  const clients = await createClients(bf, 14);
  for (const c of clients) await register(bf, c);
  // S3 : le même client re-testé 3 fois dans les 30 jours → 1 seule analyse.
  const retests = [await register(bf, clients[0]), await register(bf, clients[0]), await register(bf, clients[0])];
  check(
    retests.every((r) => r.status === 'already_counted'),
    'S3 : 3 re-tests du même client non comptés'
  );
  const { count } = await admin.from('bf_analyses').select('id', { count: 'exact', head: true }).eq('user_id', bf.id);
  check(count === 14, '14 analyses en base');

  // Stripe refuse un meter event daté après l'heure du test clock du client :
  // on amène l'horloge à l'heure réelle, puis on relance l'envoi (ce que fait
  // le job pg_cron toutes les 10 minutes en production).
  await advance(clock.id, Math.floor(Date.now() / 1000) + 120);
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
  check(true, '14 meter events envoyés (trigger → route report-usage)');

  const { data: errors } = await admin
    .from('bf_analyses')
    .select('meter_last_error')
    .eq('user_id', bf.id)
    .not('meter_last_error', 'is', null);
  check(!errors?.length, 'aucune erreur de meter event', errors?.[0]?.meter_last_error ?? '');

  // Stripe agrège les meter events de façon asynchrone.
  await sleep(20_000);
  const periodEnd = sub.items.data[0].current_period_end;
  await advance(clock.id, periodEnd + 2 * 3600);
  const invoice = await waitFor('facture de fin de période', async () => {
    const list = await stripe.invoices.list({ subscription: sub.id, limit: 5 });
    return list.data.find((i) => i.billing_reason === 'subscription_cycle');
  });
  const usagePrice = await priceId(LOOKUP.studioUsage);
  const usageLine = invoice.lines.data.filter((l) => l.pricing?.price_details?.price === usagePrice);
  check(invoice.subtotal === 10100, 'facture HT : 101,00 €', `${invoice.subtotal / 100} € HT`);
  const tax = (invoice.total_taxes ?? []).reduce((a, t) => a + t.amount, 0);
  check(tax === 2020, 'TVA FR 20 % : 20,20 €', `${tax / 100} €`);
  check(usageLine.length > 0, 'ligne d’usage présente sur la facture');
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
  check(r.body.fallback === 'unlimited', 'offre proposée à la place : Illimité (129 €)');
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
  const withSchedule = await waitFor('schedule posé par le webhook', async () => {
    const s = await stripe.subscriptions.retrieve(sub.id);
    return s.schedule ? s : null;
  });
  const schedule = await stripe.subscriptionSchedules.retrieve(withSchedule.schedule as string);
  const switchAt = Math.floor(LAUNCH_OFFER.switchAt / 1000);
  check(schedule.phases[0].end_date === switchAt, 'phase 1 jusqu’au 01/01/2027 00:00 (Paris)');
  const phase2Price = schedule.phases[1]?.items[0]?.price;
  check(phase2Price === (await priceId(LOOKUP.unlimitedLaunchAfter)), 'phase 2 : prix 99 €');

  await advanceStepwise(clock.id, switchAt + 45 * 86400);
  const after = await stripe.subscriptions.retrieve(sub.id);
  check(after.items.data[0].price.lookup_key === LOOKUP.unlimitedLaunchAfter, 'abonnement passé au prix 99 €');
  const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 10 });
  // `invoice.period_*` décrit la période précédente : on lit celle des lignes.
  const post = invoices.data.find(
    (i) => i.billing_reason === 'subscription_cycle' && i.lines.data.every((l) => l.period.start >= switchAt)
  );
  const last69 = invoices.data.find(
    (i) => i.billing_reason === 'subscription_cycle' && i.lines.data.some((l) => l.period.start < switchAt)
  );
  check(last69?.subtotal === 6900, 'échéances avant le 01/01/2027 : 69,00 € HT');
  check(
    post?.subtotal === 9900,
    'première facture après bascule : 99,00 € HT',
    post ? `${post.subtotal / 100} €` : 'absente'
  );
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
  await stripe.invoiceItems.create({ customer: customer.id, pricing: { price: await priceId(LOOKUP.pack10) } });
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
  check(invoice.subtotal === 15000 && tax === 0, 'facture 150 € HT, TVA 0 €', `taxe ${tax / 100} €`);
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

const ALL: Record<string, () => Promise<void>> = {
  s1: s1Pack,
  s2: s2Studio,
  s4: s4LaunchFull,
  s5: s5LaunchSwitch,
  s6: s6PaymentFailure,
  s7: s7ReverseCharge,
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
