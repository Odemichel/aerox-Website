# Tarifs & chaîne Stripe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Réafficher une section tarifs achetable — Diagnostic AeroX à 79 € TTC payable par Stripe, entrée B2B sur devis — et brancher la chaîne complète du clic au déblocage de `users.diagnostic_basic_paid`.

**Architecture :** Le garde-fou de redirection après connexion est un module pur testé par vitest ; la route de checkout existante est réparée puis réutilisée telle quelle via le `lookup_key` Stripe ; un webhook SSR dédié vérifie la signature Stripe et écrit en base avec la clé service role. Aucune table nouvelle : le déblocage passe par les deux colonnes déjà présentes sur `public.users`.

**Tech Stack :** Astro 5.12 (`output: 'server'`, adaptateur Vercel), TypeScript, `stripe@^18.5.0`, `@supabase/supabase-js@^2.57.4`, vitest.

**Spec :** `docs/superpowers/specs/2026-09-22-periode-test-et-tarifs-design.md`

**Prérequis :** la Task 1 du plan `2026-09-22-periode-test-et-cta.md` (harnais vitest + fallback i18n) doit être faite. Les autres tâches de ce plan-là sont indépendantes, à une exception près signalée en Task 5.

## Global Constraints

- Branche : `main`. Ne pas toucher à `v3-produits`.
- Registre : **tutoiement** dans les copies françaises.
- 9 langues, dictionnaires `src/locales/{lang}.json`. Le français et l'anglais sont rédigés à la main ; les sept autres s'appuient sur le fallback anglais implémenté par la Task 1 de l'autre plan.
- Toute route API : `export const prerender = false;`.
- `trailingSlash: 'always'` — **tout appel interne et toute URL d'endpoint Stripe doit finir par `/`**.
- La clé service role ne sort jamais du serveur.
- Vérification de chaque tâche : `npm test`, `npm run check`, `npm run build`.

## État Stripe constaté et déjà mis en place (2026-09-22)

Deux comptes Stripe **distincts**, pas deux modes d'un même compte :

| Compte | ID | Produit « Diagnostic AeroX » | Prix 79 € TTC |
|---|---|---|---|
| Sandbox (clés du `.env`) | `acct_1RjHpdPNYbroGsVd` | `prod_VJ1bwEqIyHlJQq` | `price_1UIPYCPNYbroGsVd3aqiYETh` |
| Live | `acct_1RjHpWAmzoKsBiCN` | `prod_VJ1ft6Mgt4Ec4p` | `price_1UIPcJAmzoKsBiCN96WVY4uZ` |

Les deux prix sont `one_time`, `currency: eur`, `unit_amount: 7900`, **`tax_behavior: inclusive`**, `lookup_key: diagnostic_basic`. **Le code ne référence jamais un identifiant de prix : il résout par `lookup_key`.** La bascule sandbox → live se fait en décommentant les clés du `.env`, sans toucher au code.

Aucune immatriculation TVA n'est déclarée sur le compte live (`GET /v1/tax/registrations` renvoie une liste vide) : Stripe Tax ne collecte rien aujourd'hui, le client paie 79 € et AeroX encaisse 79 €. Le marquage `inclusive` garantit que le montant affiché restera 79 € le jour d'une immatriculation, au lieu de grimper seul à 94,80 €.

## File Structure

| Fichier | Responsabilité |
|---|---|
| `src/lib/safeRedirect.ts` (créer) | Garde-fou anti-redirection ouverte |
| `test/safeRedirect.test.ts` (créer) | Tests du garde-fou |
| `src/pages/[lang]/inscription/connexion.astro` (modifier) | Prise en charge de `?redirect=` |
| `src/pages/[lang]/telechargement/api/create-api-checkout.ts` (modifier) | Retrait de `subscription_data`, ajout de `product` |
| `src/pages/api/stripe-webhook.ts` (créer) | Vérifie la signature, débloque le diagnostic |
| `src/components/widgets/Pricing.astro` (modifier) | Purge des décomptes, prix optionnel |
| `src/types.d.ts` (modifier) | Retrait des props `countdownTarget*`, ajout de `priceLabel` |
| `src/components/widgets/PricingSection.astro` (créer) | Section tarifs partagée : 2 cartes + script d'achat |
| `src/pages/[lang]/index.astro` (modifier) | Section tarifs réactivée |
| `src/pages/[lang]/inscription/dashboard.astro` (modifier) | Même section, purge du décompte et des anciens packs |
| `src/pages/[lang]/telechargement/success.astro` (modifier) | Message adapté à `?product=diagnostic` |
| `src/pages/[lang]/paiement.astro` (supprimer) | Remplacée par une 301 |
| `astro.config.mjs` (modifier) | Redirection 301 de `paiement` |
| `src/locales/*.json` (modifier ×9) | Clés `pricing.*`, purge des anciens packs |

---

### Task 1 : Garde-fou de redirection après connexion

**Files:**
- Create: `src/lib/safeRedirect.ts`
- Create: `test/safeRedirect.test.ts`
- Modify: `src/pages/[lang]/inscription/connexion.astro:97-99`

**Interfaces:**
- Consumes: rien.
- Produces: `export function safeRedirect(raw: string | null | undefined, fallback: string): string;`

**Pourquoi c'est un prérequis du reste :** `connexion.astro:99` redirige aujourd'hui en dur vers `/{lang}/inscription/dashboard/` et ne lit aucun paramètre. Sans ce travail, l'acheteur qui clique « Je commande » sans être connecté atterrit sur le dashboard et perd son intention d'achat.

- [ ] **Step 1 : Écrire les tests qui échouent**

Créer `test/safeRedirect.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { safeRedirect } from '../src/lib/safeRedirect';

const FALLBACK = '/fr/inscription/dashboard/';

describe('safeRedirect', () => {
  it('accepte un chemin relatif simple', () => {
    expect(safeRedirect('/fr/#pricing', FALLBACK)).toBe('/fr/#pricing');
  });

  it('accepte un chemin avec query', () => {
    expect(safeRedirect('/fr/telechargement/success/?product=diagnostic', FALLBACK))
      .toBe('/fr/telechargement/success/?product=diagnostic');
  });

  it('retombe sur le fallback si absent', () => {
    expect(safeRedirect(null, FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse une URL absolue', () => {
    expect(safeRedirect('https://evil.example/phish', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('http://evil.example', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse une URL protocol-relative', () => {
    expect(safeRedirect('//evil.example/phish', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse les doubles slashs même encodés ou échappés', () => {
    expect(safeRedirect('/\\evil.example', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('/%2F%2Fevil.example', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('/a//b', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse un chemin qui ne commence pas par /', () => {
    expect(safeRedirect('fr/#pricing', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('../admin', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse les schémas exotiques', () => {
    expect(safeRedirect('javascript:alert(1)', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('data:text/html,<script>', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse les caractères de contrôle et les retours à la ligne', () => {
    expect(safeRedirect('/fr/\nSet-Cookie: x=1', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('/fr/\tadmin', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse un chemin trop long', () => {
    expect(safeRedirect('/' + 'a'.repeat(2048), FALLBACK)).toBe(FALLBACK);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour les voir échouer**

Run: `npm test -- test/safeRedirect.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter le module**

Créer `src/lib/safeRedirect.ts` :

```ts
const MAX_LENGTH = 512;

/**
 * N'autorise qu'un chemin interne. Toute valeur qui pourrait désigner un
 * autre hôte — URL absolue, protocol-relative, backslash, double slash même
 * encodé — est rejetée au profit du fallback.
 */
export function safeRedirect(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;

  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;

  // Caractères de contrôle : jamais légitimes dans un chemin.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) return fallback;

  if (!value.startsWith('/')) return fallback;

  // '//host' et '/\host' désignent un autre hôte.
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;

  // Un double slash n'importe où, y compris après décodage, sort du site.
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (decoded.includes('//') || decoded.includes('\\')) return fallback;

  return value;
}
```

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- test/safeRedirect.test.ts`
Expected: PASS, tous les cas.

- [ ] **Step 5 : Brancher le module dans la page de connexion**

Dans `src/pages/[lang]/inscription/connexion.astro`, à l'intérieur du `<script>`, ajouter l'import en tête (juste après `import { supabase } from '~/config/supabaseClient';`) :

```ts
    import { safeRedirect } from '~/lib/safeRedirect';
```

Puis remplacer la ligne de redirection :

```ts
          window.location.href = `/${lang}/inscription/dashboard/`;
```

par :

```ts
          const requested = new URLSearchParams(window.location.search).get('redirect');
          window.location.href = safeRedirect(requested, `/${lang}/inscription/dashboard/`);
```

- [ ] **Step 6 : Vérifier le comportement réel**

Run: `npm run dev`, puis, avec un compte de test :
- ouvrir `http://localhost:4321/fr/inscription/connexion/` → après connexion, arrivée sur le dashboard (comportement inchangé) ;
- ouvrir `http://localhost:4321/fr/inscription/connexion/?redirect=%2Ffr%2F%23pricing` → après connexion, arrivée sur `/fr/#pricing` ;
- ouvrir `http://localhost:4321/fr/inscription/connexion/?redirect=https%3A%2F%2Fexample.com` → après connexion, arrivée sur le **dashboard**, pas sur example.com.

- [ ] **Step 7 : Commit**

```bash
git add src/lib/safeRedirect.ts test/safeRedirect.test.ts "src/pages/[lang]/inscription/connexion.astro"
git commit -m "feat connexion : prise en charge de ?redirect= avec garde-fou anti-redirection ouverte"
```

---

### Task 2 : Réparation de la route de checkout

**Files:**
- Modify: `src/pages/[lang]/telechargement/api/create-api-checkout.ts`

**Interfaces:**
- Consumes: `STRIPE_SECRET_KEY` du `.env`.
- Produces: `POST /{lang}/telechargement/api/create-api-checkout/` avec le corps `{ lookupKey?, priceId?, customerEmail?, userId?, product?, lang? }` → `{ url }`.

**Le bug à corriger, et pourquoi il est urgent :** la ligne `subscription_data: { metadata }` est illégale dans une session `mode: 'payment'` — l'API répond `You can not pass 'subscription_data' in 'payment' mode.` La route fonctionne pourtant aujourd'hui, parce qu'aucun appelant ne fournit `userId` : `metadata` reste `{}`, et le SDK Stripe n'émet rien pour un objet vide, si bien que `subscription_data` disparaît du corps HTTP. **Cette tâche est précisément celle qui arme le bug** — elle introduit `metadata.userId`. La ligne doit sauter dans le même commit.

- [ ] **Step 1 : Reproduire le bug avant de le corriger**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
K=$(grep -m1 '^STRIPE_SECRET_KEY=' .env | cut -d= -f2- | tr -d '"'"'"' \r')
curl -s https://api.stripe.com/v1/checkout/sessions -u "$K:" \
  -d "mode=payment" \
  -d "line_items[0][price]=price_1UIPYCPNYbroGsVd3aqiYETh" -d "line_items[0][quantity]=1" \
  -d "success_url=https://aeroxbefaster.com/fr/telechargement/success/" \
  -d "cancel_url=https://aeroxbefaster.com/fr/telechargement/cancel/" \
  -d "metadata[userId]=demo" -d "subscription_data[metadata][userId]=demo" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['error']['message'] if 'error' in d else 'PAS DE REFUS ?!')"
```

Expected: `You can not pass 'subscription_data' in 'payment' mode.` — le bug est confirmé, on peut corriger.

- [ ] **Step 2 : Réécrire la route**

Remplacer intégralement `src/pages/[lang]/telechargement/api/create-api-checkout.ts` par :

```ts
// /src/pages/[lang]/telechargement/api/create-api-checkout.ts
export const prerender = false;

import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);

type Body = {
  priceId?: string;
  lookupKey?: string;
  customerEmail?: string;
  userId?: string;
  product?: string;
  lang?: string;
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;

    // --- Détection de la langue ---
    let lang = body.lang;
    if (!lang) {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/([a-z]{2})(\/|$)/);
      lang = match?.[1] || 'fr';
    }

    // --- Prix : le lookup_key prime, pour que la bascule sandbox → live
    // --- se fasse en changeant les clés du .env et rien d'autre.
    let priceId = '';
    const key = body.lookupKey ?? import.meta.env.STRIPE_LOOKUP_KEY;
    if (key) {
      const prices = await stripe.prices.list({ lookup_keys: [key], active: true });
      if (!prices.data.length) throw new Error(`No active price for lookupKey "${key}"`);
      priceId = prices.data[0].id;
    }
    if (!priceId) priceId = (body.priceId ?? import.meta.env.STRIPE_PRICE_ID ?? '').trim();
    if (!priceId) throw new Error('Missing priceId');

    // --- Base site ---
    const reqOrigin = new URL(request.url).origin;
    const envBase = (import.meta.env.PUBLIC_SITE_URL || '').split('#')[0];
    const base = envBase || reqOrigin;

    // trailingSlash: 'always' → les chemins internes finissent par '/'
    const successPath = `/${lang}/telechargement/success/`;
    const cancelPath = `/${lang}/telechargement/cancel/`;

    const successUrl = new URL(successPath, base);
    if (body.product) successUrl.searchParams.set('product', body.product);
    const cancelUrl = new URL(cancelPath, base);

    const looksHttp = (u: string) => /^https?:\/\//i.test(u);
    if (!looksHttp(successUrl.toString()) || !looksHttp(cancelUrl.toString())) {
      throw new Error(`Invalid success/cancel URL (${successUrl} | ${cancelUrl})`);
    }

    const metadata: Record<string, string> = {};
    if (body.userId) metadata.userId = body.userId;
    if (body.product) metadata.product = body.product;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      allow_promotion_codes: false,
      billing_address_collection: 'auto',
      automatic_tax: { enabled: true },
      customer_email: body.customerEmail,
      customer_creation: 'if_required',
      metadata,
      // Pas de `subscription_data` ici : l'API Stripe l'interdit en mode
      // 'payment'. Il passait inaperçu tant que `metadata` restait vide.
      payment_intent_data: { metadata },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('create-api-checkout', message);
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
};
```

- [ ] **Step 3 : Vérifier que la route crée bien une session avec userId**

Run: `npm run dev`, puis :

```bash
curl -s -X POST 'http://localhost:4321/fr/telechargement/api/create-api-checkout/' \
  -H 'Content-Type: application/json' \
  -d '{"lookupKey":"diagnostic_basic","userId":"11111111-1111-1111-1111-111111111111","customerEmail":"test@example.com","product":"diagnostic"}' \
  | python3 -m json.tool
```

Expected: `{"url": "https://checkout.stripe.com/c/pay/cs_test_..."}` — **plus d'erreur `subscription_data`** alors que `userId` est fourni.

- [ ] **Step 4 : Vérifier le montant et les métadonnées de la session créée**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
K=$(grep -m1 '^STRIPE_SECRET_KEY=' .env | cut -d= -f2- | tr -d '"'"'"' \r')
curl -s "https://api.stripe.com/v1/checkout/sessions?limit=1" -u "$K:" \
  | python3 -c "
import sys,json
s=json.load(sys.stdin)['data'][0]
print('amount_total =',s['amount_total'],s['currency'])
print('metadata     =',s['metadata'])
print('success_url  =',s['success_url'])
print('mode         =',s['mode'])
"
```

Expected: `amount_total = 7900 eur`, `metadata = {'product': 'diagnostic', 'userId': '1111...'}`, `success_url` finissant par `/fr/telechargement/success/?product=diagnostic`, `mode = payment`.

- [ ] **Step 5 : Vérifier que la vente du livre n'a pas régressé**

La route `create-api-livre-checkout.ts` est indépendante et n'a jamais contenu `subscription_data`. Vérifier qu'elle compile et que la page du livre fonctionne toujours :

```bash
grep -n "subscription_data" "src/pages/[lang]/telechargement/api/create-api-livre-checkout.ts" || echo "route livre saine"
npm run check
```

Expected: `route livre saine`, check vert.

- [ ] **Step 6 : Commit**

```bash
git add "src/pages/[lang]/telechargement/api/create-api-checkout.ts"
git commit -m "fix stripe : retrait de subscription_data en mode payment, résolution par lookup_key"
```

---

### Task 3 : Webhook Stripe de déblocage

**Files:**
- Create: `src/pages/api/stripe-webhook.ts`
- Modify: `.env`

**Interfaces:**
- Consumes: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (créé à cette tâche), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (déjà présents dans le `.env`).
- Produces: `POST /api/stripe-webhook/` → 200. Effet de bord : `public.users.diagnostic_basic_paid = true` et `diagnostic_basic_paid_at = now()`.

**Colonnes vérifiées en base le 2026-09-22** sur le projet `agvksgrjqskpetokudda` : `diagnostic_basic_paid` `boolean NOT NULL DEFAULT false`, `diagnostic_basic_paid_at` `timestamptz NULL`. Aucune migration nécessaire.

**Piège de routage :** `astro.config.mjs` impose `trailingSlash: 'always'`. L'URL d'endpoint déclarée chez Stripe **doit** être `https://aeroxbefaster.com/api/stripe-webhook/` avec le slash final, sinon Astro répond une redirection que Stripe compte comme un échec de livraison.

- [ ] **Step 1 : Écrire la route**

Créer `src/pages/api/stripe-webhook.ts` :

```ts
export const prerender = false;

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);

export const POST: APIRoute = async ({ request }) => {
  const signature = request.headers.get('stripe-signature');
  const secret = import.meta.env.STRIPE_WEBHOOK_SECRET as string | undefined;

  if (!signature || !secret) {
    console.error('stripe-webhook: signature ou secret manquant');
    return new Response('Bad request', { status: 400 });
  }

  // Le corps brut est indispensable : toute désérialisation invaliderait la signature.
  const raw = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, secret);
  } catch (err) {
    console.error('stripe-webhook: signature invalide', err);
    return new Response('Invalid signature', { status: 400 });
  }

  if (event.type !== 'checkout.session.completed') {
    return new Response('ignored', { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  if (session.payment_status !== 'paid') {
    return new Response('not paid', { status: 200 });
  }

  // Seul l'identifiant signé par Stripe fait foi : rien n'est lu de la requête brute.
  const userId = session.metadata?.userId;
  const product = session.metadata?.product;

  if (!userId || product !== 'diagnostic') {
    return new Response('nothing to unlock', { status: 200 });
  }

  const supabase = createClient(
    import.meta.env.SUPABASE_URL as string,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string,
    { auth: { persistSession: false } },
  );

  // Idempotent par nature : un rejeu réécrit les mêmes valeurs.
  const { error } = await supabase
    .from('users')
    .update({ diagnostic_basic_paid: true, diagnostic_basic_paid_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) {
    console.error('stripe-webhook: échec de la mise à jour', userId, error.message);
    // 500 : Stripe rejouera l'événement.
    return new Response('update failed', { status: 500 });
  }

  console.log('stripe-webhook: diagnostic débloqué pour', userId);
  return new Response('ok', { status: 200 });
};
```

- [ ] **Step 2 : Vérifier que la Stripe CLI est authentifiée**

```bash
stripe --version
stripe config --list 2>/dev/null | head -5 || echo "non authentifiée"
```

Si la sortie indique une clé expirée ou absente, demander à l'utilisateur de lancer `! stripe login` dans sa session — c'est une authentification interactive qui ne peut pas être automatisée.

- [ ] **Step 3 : Écouter les webhooks en local et relever le secret**

```bash
stripe listen --forward-to 'http://localhost:4321/api/stripe-webhook/'
```

Expected: la commande affiche `Ready! Your webhook signing secret is whsec_...`. **Laisser tourner dans un terminal dédié** et copier le `whsec_`.

- [ ] **Step 4 : Renseigner le secret**

Ajouter au `.env`, à côté des autres variables Stripe :

```
STRIPE_WEBHOOK_SECRET=whsec_<valeur affichée par stripe listen>
```

Redémarrer `npm run dev` pour que la variable soit lue.

- [ ] **Step 5 : Vérifier le rejet d'une signature invalide**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'http://localhost:4321/api/stripe-webhook/' \
  -H 'Content-Type: application/json' -H 'stripe-signature: t=1,v1=nimportequoi' \
  -d '{"type":"checkout.session.completed"}'
```

Expected: `400`. Une requête sans en-tête `stripe-signature` doit aussi renvoyer `400` :

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'http://localhost:4321/api/stripe-webhook/' \
  -H 'Content-Type: application/json' -d '{}'
```

Expected: `400`.

- [ ] **Step 6 : Relever un identifiant utilisateur réel pour le test**

Via l'outil MCP Supabase `execute_sql` sur le projet `agvksgrjqskpetokudda` :

```sql
select id, email, diagnostic_basic_paid, diagnostic_basic_paid_at
from public.users
where email = '<ton email de test>';
```

Noter l'`id`. S'il est déjà à `true`, le remettre à `false` via `apply_migration` avant de tester (`execute_sql` est en lecture seule sur ce projet) :

```sql
update public.users
set diagnostic_basic_paid = false, diagnostic_basic_paid_at = null
where id = '<id>';
```

- [ ] **Step 7 : Payer de bout en bout avec une carte de test**

Créer une session pour cet utilisateur, ouvrir l'URL et payer avec `4242 4242 4242 4242`, date future, CVC quelconque :

```bash
curl -s -X POST 'http://localhost:4321/fr/telechargement/api/create-api-checkout/' \
  -H 'Content-Type: application/json' \
  -d '{"lookupKey":"diagnostic_basic","userId":"<id relevé>","customerEmail":"<ton email de test>","product":"diagnostic"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['url'])"
```

Expected pendant le paiement : la page Stripe affiche **79,00 €** et non 94,80 €. Dans le terminal `stripe listen` : `checkout.session.completed → 200`.

- [ ] **Step 8 : Vérifier le déblocage en base**

Via `execute_sql` :

```sql
select id, diagnostic_basic_paid, diagnostic_basic_paid_at
from public.users where id = '<id relevé>';
```

Expected: `diagnostic_basic_paid = true`, `diagnostic_basic_paid_at` à l'instant du paiement.

- [ ] **Step 9 : Vérifier l'idempotence**

Dans le terminal où tourne `stripe listen`, relancer l'événement :

```bash
stripe events resend <evt_id affiché par stripe listen>
```

Expected: `200`, et `diagnostic_basic_paid_at` **change** de valeur sans que rien ne casse — le rejeu est sans danger. Si tu préfères figer la date du premier paiement, remplacer le `.eq('id', userId)` par un filtre supplémentaire `.eq('diagnostic_basic_paid', false)` ; ce n'est pas requis par la spec.

- [ ] **Step 10 : Commit**

```bash
git add src/pages/api/stripe-webhook.ts
git commit -m "feat stripe : webhook de déblocage du diagnostic, signature vérifiée"
```

**Note de déploiement, à faire au moment de la mise en ligne :** déclarer l'endpoint `https://aeroxbefaster.com/api/stripe-webhook/` dans le dashboard Stripe (événement `checkout.session.completed` uniquement), relever le `whsec_` de production et le poser dans les variables d'environnement Vercel. Le secret de `stripe listen` n'est valable que pour l'écoute locale.

---

### Task 4 : Purge des décomptes dans le widget Pricing

**Files:**
- Modify: `src/components/widgets/Pricing.astro` (lignes 5-6, 58-60, 145-160, 270-275, 164-200)
- Modify: `src/types.d.ts:184-186`

**Interfaces:**
- Consumes: rien.
- Produces: le type `Price` perd `countdownTarget`, `countdownTarget1`, `countdownTarget2` et gagne `priceLabel?: string`. Une carte sans `price` affiche `priceLabel` au lieu d'un `€` orphelin.

**Pourquoi `priceLabel` :** le bloc de prix rend aujourd'hui le symbole `€` en dur (`Pricing.astro:170`). La carte B2B de la Task 5, qui n'a pas de prix, afficherait un `€` seul suivi de rien. Ce prop est le minimum nécessaire pour que la carte « sur devis » soit présentable.

- [ ] **Step 1 : Retirer les imports du décompte**

Dans `src/components/widgets/Pricing.astro`, supprimer les lignes 5 et 6 :

```astro
import CountDown from './CountDown.astro';
import { COUNTDOWN_TARGET } from '~/config/countdown';
```

- [ ] **Step 2 : Retirer les props déstructurées**

Dans le bloc de déstructuration `const { … } = plan;`, supprimer les trois lignes :

```ts
              countdownTarget1,
              countdownTarget,
              countdownTarget2,
```

et ajouter à la place :

```ts
              priceLabel,
```

- [ ] **Step 3 : Supprimer les deux blocs de rendu du décompte**

Supprimer intégralement le bloc commenté `{/* ----- Countdown (optionnel) ----- */}` et son contenu `{hasChoice && (<> … </>)}` (aujourd'hui lignes 145-160).

Supprimer aussi le bloc en fin de carte (aujourd'hui lignes 270-274) :

```astro
                  {countdownTarget && (
                    <p class="mt-1 text-sm font-medium text-primary" data-v="1">
                      {t(dict, 'pricing.remaining')} <CountDown targetDate={new Date(COUNTDOWN_TARGET)} /> <br />
                      {t(dict, 'pricing.offer')}
                    </p>
                  )}
```

- [ ] **Step 4 : Rendre le prix optionnel**

Dans le bloc `{/* ----- Prix ----- */}`, remplacer la branche `!hasChoice` par :

```astro
                      {!hasChoice ? (
                        <div class="flex flex-col items-center justify-center text-center mb-1">
                          {price !== undefined && price !== '' ? (
                            <div class="flex items-center justify-center">
                              <span class="text-5xl">€</span>
                              <span class="text-6xl font-extrabold">{price}</span>
                            </div>
                          ) : (
                            <div class="flex items-center justify-center">
                              <span class="text-4xl font-extrabold">{priceLabel}</span>
                            </div>
                          )}
                          <span class="text-base leading-6 lowercase text-gray-600 dark:text-slate-400">
                            {period}
                          </span>
                        </div>
                      ) : (
```

Le reste du bloc `hasChoice` est inchangé.

- [ ] **Step 5 : Mettre à jour le type**

Dans `src/types.d.ts`, dans l'interface qui décrit un prix, supprimer les trois lignes :

```ts
  countdownTarget?:targetDate ;
  countdownTarget1?:targetDate ;
  countdownTarget2?:targetDate ;
```

et ajouter, juste après `price?: number | string;` :

```ts
  priceLabel?: string;
```

- [ ] **Step 6 : Vérifier qu'aucune référence ne subsiste**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
grep -rn "countdownTarget" src/ || echo "aucune référence à countdownTarget"
grep -rn "CountDown\|COUNTDOWN" src/components/widgets/Pricing.astro || echo "Pricing.astro purgé"
npm run check
```

Expected: les deux messages de confirmation, puis check vert. **`CountDown.astro` et `countdown.ts` ne sont pas supprimés ici** : c'est la Task 10 Step 7 du plan Période de test qui s'en charge, une fois cette tâche faite.

- [ ] **Step 7 : Commit**

```bash
git add src/components/widgets/Pricing.astro src/types.d.ts
git commit -m "refacto pricing : purge des décomptes, prix optionnel pour les offres sur devis"
```

---

### Task 5 : Section tarifs partagée (accueil + dashboard)

**Files:**
- Create: `src/components/widgets/PricingSection.astro`
- Modify: `src/pages/[lang]/index.astro` (bloc commenté, aujourd'hui lignes 542-604)
- Modify: `src/pages/[lang]/inscription/dashboard.astro:3,128-200`
- Modify: `src/locales/fr.json`, `src/locales/en.json`

**Interfaces:**
- Consumes: `Pricing.astro` avec `priceLabel` (Task 4), la route de checkout (Task 2), `safeRedirect` côté connexion (Task 1).
- Produces: `<PricingSection />`, utilisé sans prop. Le composant rend l'ancre `#pricing`, ce qui répare l'entrée de menu « Tarifs » de `navigation.ts:44` — aujourd'hui une ancre morte puisque le bloc est commenté.

**Pourquoi un composant et non du code dans la page :** `dashboard.astro:128-200` rend **la même grille des trois anciens packs** que la page d'accueil, et importe `COUNTDOWN_TARGET` à la ligne 3. La spec ne mentionne que « le décompte dashboard », mais la réalité est plus large : purger `home.prices.*` et supprimer `countdown.ts` **casserait le build** tant que cette page n'est pas traitée. Les deux pages ont besoin exactement de la même section — la factoriser évite de dupliquer soixante lignes de props et le script d'achat. Le dashboard y gagne au passage : son visiteur est déjà connecté, donc le clic part directement sur Stripe.

- [ ] **Step 1 : Ajouter les clés françaises**

Dans `src/locales/fr.json` :

```json
  "pricing.title": "Tarifs",
  "pricing.subtitle": "Mesure ton aéro, puis décide",
  "pricing.subsubtitle": "Le diagnostic AeroX chiffre tes positions. Les studios ont leur propre formule.",
  "pricing.diagnostic.title": "Diagnostic AeroX",
  "pricing.diagnostic.subtitle": "Une séance, dix positions, tes gains chiffrés",
  "pricing.diagnostic.period": "paiement unique",
  "pricing.diagnostic.items.1": "Mesure de ta surface frontale sur 10 positions",
  "pricing.diagnostic.items.2": "Gains chiffrés pour chaque position",
  "pricing.diagnostic.items.3": "Comparaison de ton endurance dans chaque position",
  "pricing.diagnostic.items.4": "Recommandations personnalisées pour améliorer ton aéro en course",
  "pricing.diagnostic.cta": "Je commande — 79 €",
  "pricing.diagnostic.ribbon": "Le plus demandé",
  "pricing.diagnostic.error": "La commande n'a pas pu démarrer. Réessaie dans un instant.",
  "pricing.b2b.title": "Bike-Fitters & studios",
  "pricing.b2b.subtitle": "Pour ceux qui mesurent leurs clients",
  "pricing.b2b.priceLabel": "Sur devis",
  "pricing.b2b.period": "selon ton volume",
  "pricing.b2b.items.1": "Tarification au volume",
  "pricing.b2b.items.2": "Suivi multi-clients",
  "pricing.b2b.items.3": "Accompagnement à la prise en main",
  "pricing.b2b.cta": "Contactez-nous",
```

- [ ] **Step 2 : Ajouter les clés anglaises**

Dans `src/locales/en.json` :

```json
  "pricing.title": "Pricing",
  "pricing.subtitle": "Measure your aero, then decide",
  "pricing.subsubtitle": "The AeroX diagnostic puts numbers on your positions. Studios have their own plan.",
  "pricing.diagnostic.title": "AeroX Diagnostic",
  "pricing.diagnostic.subtitle": "One session, ten positions, your gains in numbers",
  "pricing.diagnostic.period": "one-time payment",
  "pricing.diagnostic.items.1": "Frontal area measured across 10 positions",
  "pricing.diagnostic.items.2": "Quantified gains for every position",
  "pricing.diagnostic.items.3": "How long you can hold each position",
  "pricing.diagnostic.items.4": "Personalised recommendations to improve your race aero",
  "pricing.diagnostic.cta": "Buy now — €79",
  "pricing.diagnostic.ribbon": "Most popular",
  "pricing.diagnostic.error": "Checkout could not start. Please try again in a moment.",
  "pricing.b2b.title": "Bike fitters & studios",
  "pricing.b2b.subtitle": "For those who measure their clients",
  "pricing.b2b.priceLabel": "On request",
  "pricing.b2b.period": "based on your volume",
  "pricing.b2b.items.1": "Volume-based pricing",
  "pricing.b2b.items.2": "Multi-client tracking",
  "pricing.b2b.items.3": "Hands-on onboarding",
  "pricing.b2b.cta": "Contact us",
```

- [ ] **Step 3 : Écrire le composant**

Créer `src/components/widgets/PricingSection.astro` :

```astro
---
import Prices from '~/components/widgets/Pricing.astro';
import { type Locale, getDict, t } from '~/lib/i18n';
import { localizedHref } from '~/utils/localize';

const lang = (Astro.params.lang as Locale) ?? 'fr';
const dict = getDict(lang);
---

<Prices
  id="pricing"
  title={t(dict, 'pricing.title')}
  subtitle={t(dict, 'pricing.subtitle')}
  subsubtitle={t(dict, 'pricing.subsubtitle')}
  prices={[
    {
      title: t(dict, 'pricing.diagnostic.title'),
      subtitle: t(dict, 'pricing.diagnostic.subtitle'),
      price: '79',
      period: t(dict, 'pricing.diagnostic.period'),
      items: [
        { description: t(dict, 'pricing.diagnostic.items.1'), icon: 'tabler:ruler-measure' },
        { description: t(dict, 'pricing.diagnostic.items.2'), icon: 'tabler:trending-up' },
        { description: t(dict, 'pricing.diagnostic.items.3'), icon: 'tabler:heartbeat' },
        { description: t(dict, 'pricing.diagnostic.items.4'), icon: 'tabler:bulb' },
      ],
      callToAction: {
        text: t(dict, 'pricing.diagnostic.cta'),
        id: 'btn-buy-diagnostic',
        type: 'button',
      },
      hasRibbon: true,
      ribbonTitle: t(dict, 'pricing.diagnostic.ribbon'),
    },
    {
      title: t(dict, 'pricing.b2b.title'),
      subtitle: t(dict, 'pricing.b2b.subtitle'),
      priceLabel: t(dict, 'pricing.b2b.priceLabel'),
      period: t(dict, 'pricing.b2b.period'),
      items: [
        { description: t(dict, 'pricing.b2b.items.1'), icon: 'tabler:receipt-euro' },
        { description: t(dict, 'pricing.b2b.items.2'), icon: 'tabler:users' },
        { description: t(dict, 'pricing.b2b.items.3'), icon: 'tabler:lifebuoy' },
      ],
      callToAction: {
        text: t(dict, 'pricing.b2b.cta'),
        href: localizedHref(lang, '/bike-fitting/#contact-bf'),
        target: '',
      },
      hasRibbon: false,
      ribbonTitle: '',
    },
  ]}
/>

<div
  id="buy-diagnostic-config"
  data-lang={lang}
  data-error={t(dict, 'pricing.diagnostic.error')}
  class="hidden"
></div>

<script>
  import { supabase } from '~/config/supabaseClient';

  const cfg = document.getElementById('buy-diagnostic-config');
  const lang = cfg?.dataset.lang ?? 'fr';
  const buyError = cfg?.dataset.error ?? '';

  document.getElementById('btn-buy-diagnostic')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '…';

    try {
      const { data } = await supabase.auth.getUser();
      const user = data?.user;

      // Connexion obligatoire avant le checkout : on mémorise le point de retour.
      if (!user) {
        const back = encodeURIComponent(`/${lang}/#pricing`);
        window.location.href = `/${lang}/inscription/connexion/?redirect=${back}`;
        return;
      }

      const res = await fetch(`/${lang}/telechargement/api/create-api-checkout/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lookupKey: 'diagnostic_basic',
          userId: user.id,
          customerEmail: user.email,
          product: 'diagnostic',
          lang,
        }),
      });
      const payload = await res.json();
      if (!payload?.url) throw new Error(payload?.error || 'no url');
      window.location.href = payload.url;
    } catch (err) {
      console.error('checkout diagnostic', err);
      alert(buyError);
      btn.disabled = false;
      btn.innerHTML = prev;
    }
  });
</script>
```

- [ ] **Step 4 : Brancher le composant sur la page d'accueil**

Dans `src/pages/[lang]/index.astro`, ajouter l'import au frontmatter :

```astro
import PricingSection from '~/components/widgets/PricingSection.astro';
```

Puis remplacer intégralement le bloc `{/* Section Pricing masquée temporairement … */}` — de `{/* Section Pricing` jusqu'à `*/}` inclus — par :

```astro
  <PricingSection />
```

L'import `Prices` du frontmatter de `index.astro` devient inutilisé : le supprimer.

- [ ] **Step 5 : Brancher le composant sur le dashboard**

Dans `src/pages/[lang]/inscription/dashboard.astro` :

1. supprimer la ligne 3 : `import { COUNTDOWN_TARGET } from '~/config/countdown';`
2. remplacer l'import `Prices` par `import PricingSection from '~/components/widgets/PricingSection.astro';`
3. remplacer intégralement le bloc `<Prices … />` (lignes 128 à 200 incluses) par :

```astro
  <PricingSection />
```

- [ ] **Step 6 : Vérifier que plus rien ne dépend des anciennes clés**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
grep -rn "home\.prices\.\|COUNTDOWN_TARGET" src/ --include='*.astro' --include='*.ts' || echo "aucune dépendance résiduelle"
npm run check
```

Expected: `aucune dépendance résiduelle`, check vert. C'est ce contrôle qui autorise la purge de `countdown.ts` (Task 10 Step 7 du plan Période de test) et celle des clés `home.prices.*` (Task 7 de ce plan).

- [ ] **Step 7 : Vérifier le rendu et les deux parcours**

Run: `npm run dev`, ouvrir `http://localhost:4321/fr/#pricing`.
Expected:
- la section s'affiche, l'ancre depuis le menu « Tarifs » fonctionne ;
- la carte B2C montre **79 €** et le ruban, la carte B2B montre **« Sur devis »** sans `€` orphelin ;
- **déconnecté**, le clic sur « Je commande — 79 € » mène à `/fr/inscription/connexion/?redirect=%2Ffr%2F%23pricing` et, après connexion, revient sur `/fr/#pricing` ;
- **connecté**, le clic ouvre Stripe Checkout à **79,00 €** ;
- « Contactez-nous » mène à `/fr/bike-fitting/#contact-bf`.

Ouvrir ensuite `http://localhost:4321/fr/inscription/dashboard/` avec un compte connecté : la même section s'affiche, sans décompte, et le clic part directement sur Stripe sans passer par la connexion.

Ouvrir enfin `/pt/#pricing` : textes en anglais via le fallback, jamais de clé brute.

- [ ] **Step 8 : Commit**

```bash
git add src/components/widgets/PricingSection.astro "src/pages/[lang]/index.astro" "src/pages/[lang]/inscription/dashboard.astro" src/locales/fr.json src/locales/en.json
git commit -m "feat tarifs : section partagée accueil + dashboard, diagnostic 79 € et B2B sur devis"
```

---

### Task 6 : Page de succès adaptée au diagnostic

**Files:**
- Modify: `src/pages/[lang]/telechargement/success.astro`
- Modify: `src/locales/fr.json`, `src/locales/en.json`

**Interfaces:**
- Consumes: `?product=diagnostic` posé par la route de checkout (Task 2).
- Produces: rien pour les tâches suivantes.

- [ ] **Step 1 : Ajouter les clés françaises**

Dans `src/locales/fr.json` :

```json
  "success.diagnostic.title": "Ton diagnostic est débloqué",
  "success.diagnostic.subtitle1": "Le paiement est passé, ton compte AeroX a accès au Diagnostic.",
  "success.diagnostic.subtitle2": "Ouvre l'application AeroX avec ce même compte pour lancer ta séance.",
```

- [ ] **Step 2 : Ajouter les clés anglaises**

Dans `src/locales/en.json` :

```json
  "success.diagnostic.title": "Your diagnostic is unlocked",
  "success.diagnostic.subtitle1": "Payment went through, your AeroX account now has Diagnostic access.",
  "success.diagnostic.subtitle2": "Open the AeroX app with this same account to start your session.",
```

- [ ] **Step 3 : Adapter la page**

Dans `src/pages/[lang]/telechargement/success.astro`, remplacer le frontmatter par :

```astro
---
export const prerender = false;

import { Icon } from 'astro-icon/components';
import Layout from '~/layouts/Layout.astro';
import { getDict, t } from '~/lib/i18n';

const { lang } = Astro.params;
const dict = getDict(lang);

const isDiagnostic = Astro.url.searchParams.get('product') === 'diagnostic';

const metadata = {
  title: t(dict, 'success.meta.title'),
  description: t(dict, 'success.meta.description'),
};
---
```

`prerender = false` est indispensable : la page doit lire un paramètre de requête, ce qu'une page prérendue ne peut pas faire.

Puis remplacer le titre et le sous-titre :

```astro
    <h1 class="text-3xl font-bold mb-4">
      ✅ {isDiagnostic ? t(dict, 'success.diagnostic.title') : t(dict, 'success.title')}
    </h1>

    <p class="text-lg mb-8">
      {isDiagnostic ? t(dict, 'success.diagnostic.subtitle1') : t(dict, 'success.subtitle1')}<br />
      {isDiagnostic ? t(dict, 'success.diagnostic.subtitle2') : t(dict, 'success.subtitle2')}
    </p>
```

Les boutons de téléchargement macOS / Windows restent affichés dans les deux cas : l'acheteur du diagnostic a précisément besoin de l'application.

- [ ] **Step 4 : Vérifier les deux variantes**

Run: `npm run dev`, puis ouvrir :
- `http://localhost:4321/fr/telechargement/success/` → message d'origine ;
- `http://localhost:4321/fr/telechargement/success/?product=diagnostic` → « Ton diagnostic est débloqué ».

- [ ] **Step 5 : Commit**

```bash
git add "src/pages/[lang]/telechargement/success.astro" src/locales/fr.json src/locales/en.json
git commit -m "feat tarifs : page de succès adaptée à l'achat du diagnostic"
```

---

### Task 7 : Retrait de l'offre Pionnier et des anciens packs

**Files:**
- Delete: `src/pages/[lang]/paiement.astro`
- Delete: `src/pages/[lang]/telechargement/DeviensPionnier.astro`
- Modify: `astro.config.mjs`
- Modify: `src/locales/*.json` (les 9)

**Interfaces:**
- Consumes: la section tarifs de la Task 5, cible de la redirection.
- Produces: rien.

- [ ] **Step 1 : Vérifier qui référence encore ces pages**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
grep -rn "paiement\|DeviensPionnier" src/ --include='*.astro' --include='*.ts' | grep -v '^src/locales/'
```

Noter chaque référence : elle devra disparaître avant la suppression. Si `navigation.ts` ou une autre page pointe vers `/paiement/`, corriger d'abord vers `withLang(lang, '#pricing')`.

- [ ] **Step 2 : Déclarer la redirection 301**

Dans `astro.config.mjs`, à l'intérieur de `defineConfig({ … })`, ajouter juste après `adapter: vercel({}),` :

```js
  redirects: {
    '/[lang]/paiement': { status: 301, destination: '/[lang]/#pricing' },
  },
```

- [ ] **Step 3 : Supprimer les deux pages**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
rm "src/pages/[lang]/paiement.astro" "src/pages/[lang]/telechargement/DeviensPionnier.astro"
```

- [ ] **Step 4 : Purger les clés des anciens packs dans les 9 dictionnaires**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
python3 - <<'PY'
import json, collections, glob
for path in sorted(glob.glob('src/locales/*.json')):
    d = json.load(open(path), object_pairs_hook=collections.OrderedDict)
    dead = [k for k in d if k.startswith('home.prices.')]
    for k in dead:
        del d[k]
    json.dump(d, open(path, 'w'), ensure_ascii=False, indent=2)
    open(path, 'a').write('\n')
    print(path, '->', len(dead), 'clés home.prices.* retirées,', len(d), 'restantes')
PY
```

Expected: 32 clés retirées par dictionnaire (comptage constaté le 2026-09-22 sur `fr.json`).

- [ ] **Step 5 : Vérifier qu'aucune clé supprimée n'est utilisée**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
grep -rn "home\.prices\." src/ --include='*.astro' --include='*.ts' || echo "aucun usage de home.prices.*"
grep -rn "pionnier\|Pionnier\|10 avril\|01/12/2025\|01/11/2025" src/ --include='*.astro' --include='*.ts' || echo "aucune mention datée hors dictionnaires"
```

Expected: les deux messages de confirmation.

- [ ] **Step 6 : Vérifier la redirection**

Run: `npm run build && npm run preview`, puis :

```bash
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' 'http://localhost:4321/fr/paiement/'
```

Expected: `301 -> .../fr/#pricing`. Si le format `[lang]` n'est pas accepté par `redirects`, déclarer les neuf routes explicitement :

```js
  redirects: Object.fromEntries(
    ['fr','en','pt','es','it','de','nl','ja','tr'].map((l) => [
      `/${l}/paiement`,
      { status: 301, destination: `/${l}/#pricing` },
    ]),
  ),
```

- [ ] **Step 7 : Vérification complète**

```bash
npm test && npm run check && npm run build
```

Expected: tout vert.

- [ ] **Step 8 : Commit**

```bash
git add -A src/pages src/locales astro.config.mjs
git commit -m "chore tarifs : retrait de l'offre Pionnier et des anciens packs"
```

---

## Vérification finale du plan

- [ ] `npm test` — safeRedirect et les modules du plan Période de test passent
- [ ] `npm run check` et `npm run build` — verts
- [ ] Un paiement de test de bout en bout passe `diagnostic_basic_paid` à `true` pour le bon compte
- [ ] La page Stripe affiche **79,00 €**, jamais 94,80 €
- [ ] Une signature de webhook invalide renvoie 400
- [ ] `?redirect=https://example.com` sur la page de connexion mène au dashboard, pas à example.com
- [ ] `grep -rn "pionnier\|Pionnier\|10 avril\|pricing.remaining\|home.prices\.\|COUNTDOWN" src/` — aucune occurrence
- [ ] Le dashboard affiche la même section tarifs, sans décompte
- [ ] `/fr/#pricing` accessible depuis le menu « Tarifs »

## Reste à faire au moment de la mise en production

1. Décommenter les clés live dans le `.env` (ou poser les variables sur Vercel) — le `lookup_key` `diagnostic_basic` résoudra tout seul vers `price_1UIPcJAmzoKsBiCN96WVY4uZ`.
2. Déclarer l'endpoint `https://aeroxbefaster.com/api/stripe-webhook/` dans le dashboard Stripe live, événement `checkout.session.completed` seul, et poser le `whsec_` de production dans les variables Vercel.
3. Traduire à la main les clés `pricing.*`, `testPeriod.*` et `lead.*` dans les sept langues restantes, qui tournent pour l'instant sur le fallback anglais.
4. Hors périmètre mais à traiter avant toute immatriculation TVA : le prix Early BikeFitter 69 €/mois (`price_1TuCkMAmzoKsBiCNBtiPqdaF`) est en `tax_behavior: unspecified` et porte le même risque de saut de prix que celui écarté ici par `inclusive`.
