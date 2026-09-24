# Facturation bike fitters — BILLING.md

Grille publique en 3 offres, facturée par Stripe, activation automatique du
compte, comptage des analyses côté serveur.

| Offre              | Prix HT                                              | Stripe (`lookup_key`)                                                      |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Essai              | 2 analyses, 20 jours, débloquées par une carte (0 €) | Checkout « setup », une carte = un essai (`bf_trial_cards`)                |
| À l'usage          | 20 € par analyse, facturé en fin de mois             | `aerox_bf_payg` (meter, sans forfait)                                      |
| Studio             | 79 €/mois, 5 incluses, puis 10 €                     | `aerox_bf_studio_base` + `aerox_bf_studio_usage` (meter)                   |
| Illimité           | 119 €/mois ou 1 190 €/an (2 mois offerts)            | `aerox_bf_unlimited`, `aerox_bf_unlimited_year`                            |
| Illimité lancement | 69 €/mois jusqu'au 31/12/2026, puis 99 € au prorata  | `aerox_bf_unlimited_launch` → `aerox_bf_unlimited_launch_after` (schedule) |
| Founding Partner   | inchangé (69 $/mois, lien de paiement)               | plan `legacy`, abonnement Stripe jamais touché                             |

Paliers : 1 à 3 analyses par mois → à l'usage ; 4 à 9 → Studio ; 10 et plus →
Illimité. Toutes les offres incluent l'installation du setup en visio et une
visio collective par mois. Le Pack (crédits prépayés) a été retiré avant toute
vente ; le plan `pack` reste valide en base pour l'historique.

**Analyse** = un client (`bf_clients`) analysé, décompté une fois par période
glissante de 30 jours. Les re-tests dans la fenêtre sont gratuits.

---

## Architecture

```
Navigateur (site Astro)                  Application desktop (Flutter)
  │ /api/billing/checkout/  (jeton)        │ SessionLifecycle.start
  │ /api/billing/portal/    (jeton)        │   └─ RPC register_analysis(client_id)  (jeton)
  │ /api/billing/manage/    (jeton)        │
  ▼                                        ▼
Vercel (routes Astro, clé Stripe)       Supabase Postgres
  ├─ checkout / portal / manage  ──────▶  bf_billing · bf_credits · bf_analyses · stripe_events
  ├─ /api/stripe-webhook/  ◀── Stripe     ├─ bf_register_analysis_for (verrou par client, crédits atomiques)
  │     └─ handleBillingEvent             ├─ trigger sessions → filet de sécurité (comptage à l'enregistrement)
  └─ /api/billing/report-usage/ ◀── pg_net├─ trigger bf_analyses (Studio) → ping report-usage
        └─ meter events Stripe            └─ pg_cron bf-report-usage (toutes les 10 min, rejeu)
```

Principes :

- **Le client ne compte jamais.** L'app demande `register_analysis(client_id)` ;
  la base décide (fenêtre de 30 jours, crédits, statut). Si l'appel n'a pas eu
  lieu (ancienne version, hors ligne), le trigger sur `sessions` compte
  l'analyse à l'enregistrement de la séance (ou la trace `uncredited`).
- **Le corps des requêtes ne choisit que l'offre et la langue.** Prix et
  utilisateur sont décidés côté serveur (catalogue + jeton vérifié).
- **Le webhook ne croit que les métadonnées signées** `userId` / `aerox_offer`,
  et relit toujours l'abonnement chez Stripe (événements dans le désordre).
  Un objet sans `aerox_offer` (Founding Partner, diagnostic cycliste) n'est
  jamais traité par la facturation BF.
- **Idempotence partout** : `stripe_events` (webhook), unicité
  `(user_id, source)` sur `bf_credits` (crédit d'un pack), `identifier` = id
  de l'analyse (meter event), réservation des lots d'envoi
  (`bf_claim_meter_batch`, `SKIP LOCKED`).

### Fichiers

| Rôle                         | Fichier                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Catalogue (source de vérité) | `src/lib/billing/catalog.ts`                                                                    |
| Règles pures (testées)       | `src/lib/billing/logic.ts`                                                                      |
| Script catalogue Stripe      | `scripts/stripe-catalog.ts` (`npm run stripe:catalog`)                                          |
| Checkout / portail / gestion | `src/pages/api/billing/{checkout,portal,manage}.ts`                                             |
| Webhook                      | `src/pages/api/stripe-webhook.ts` → `src/lib/billing/webhook.ts`                                |
| Envoi de l'usage Studio      | `src/pages/api/billing/report-usage.ts`                                                         |
| Migrations                   | `supabase/migrations/20260924120000_bf_billing.sql`, `…130000_bf_analysis_counting.sql`         |
| Notification « nouveau BF »  | `supabase/functions/notify-admin-new-bf/`                                                       |
| Site                         | `BfPricing.astro` (#tarifs), `bike-fitting/bienvenue.astro`, `inscription/*`, dashboard         |
| App desktop                  | dépôt veloaero, branche `feat-bf-billing` : `bf_billing_service.dart`, `session_lifecycle.dart` |

### Données

- `bf_billing` : `plan` (`trial|pack|studio|unlimited|unlimited_launch|legacy`),
  `status` (`active|past_due|read_only`), `grace_until`, période, ids Stripe.
- `bf_credits` : crédits d'essai (`source='trial'`) et de packs (`source` = id de
  session Checkout).
- `bf_analyses` : une ligne par analyse comptée (`billing_mode`, `origin`
  `app|session_backstop`, état d'envoi du meter event).
- `stripe_events` : événements traités.
- RLS : lecture de ses propres lignes (et admin) ; aucune écriture client.

### Cycle de vie

- **Inscription** (`/inscription/inscription/?profil=bike-fitter`) :
  `handle_email_confirmed` crée l'utilisateur en `bike-fitter` actif, en essai
  `needs_card`. Notification admin par `notify-admin-new-bf`.
- **Essai** : `/api/billing/trial-card/` ouvre un Checkout « setup » (0 €). Le
  webhook lit l'empreinte de la carte chez Stripe et appelle `bf_grant_trial` :
  2 analyses sur 20 jours si la carte n'a jamais servi, sinon
  `card_already_used`. Sans carte, `register_analysis` refuse avec
  `needs_card` (message dédié dans l'app).
- **Échec de paiement** : `past_due`, accès complet jusqu'à `grace_until`
  (premier échec + 7 jours, calculé en temps réel par `bf_access_level`), puis
  lecture seule. Paiement régularisé : retour en `active`. Si Stripe résilie
  l'abonnement pour impayé (`cancellation_details.reason = payment_failed`)
  avant la fin de la grâce, l'offre et l'accès sont conservés jusqu'à
  `grace_until`, sans abonnement : l'espace propose de se réabonner. La
  promesse des 7 jours ne dépend donc pas du réglage des relances Stripe.
- **Fin d'abonnement** : retour au plan `trial` (analyses refusées s'il ne reste
  aucun crédit d'essai).
- **À l'usage et Studio** : chaque analyse comptée part au meter
  `aerox_analysis` ; Stripe facture en fin de période.
- **Démarrage au 1er novembre 2026** (`BF_AVAILABLE_AT`) : un abonnement
  souscrit avant cette date démarre en période d'essai Stripe jusqu'au 1er
  novembre (carte enregistrée, rien de débité, place de lancement réservée).
  Les schedules (lancement, descente) conservent ce `trial_end`. À moins de
  3 jours de la date, facturation immédiate (Stripe exige 48 h minimum).
- **Factures** : PDF créée par Stripe à chaque paiement, téléchargeable dans
  « Gérer ma facturation » (portail). Aucun e-mail de reçu n'est promis
  (choix produit : éviter de rappeler le prélèvement chaque mois).
- **Offre de lancement** : au premier paiement, le webhook pose un subscription
  schedule. Phase 1 jusqu'au 01/01/2027 00:00 (Paris), phase 2 à 99 €
  avec `proration_behavior: create_prorations`, puis le schedule est relâché.
  **Effet** : 99 € dès le 01/01 ; la période à cheval est régularisée au
  prorata (crédit 69 €, débit 99 € sur les jours restants) sur l'échéance
  suivante (vérifié par le test S5).
- **Changement d'offre / résiliation** : `/api/billing/manage/` (le portail
  Stripe ne sait pas modifier un abonnement à usage mesuré ni un abonnement
  sous schedule). **Monter** (usage → Studio → lancement → Illimité → annuel)
  est immédiat, au prorata. **Descendre** prend effet à la fin de la période
  payée, via un schedule `aerox_schedule=downgrade` : un passage en Illimité
  le temps d'un mois chargé ne se rembourse pas. Le portail sert aux factures, à la carte, au
  n° de TVA et à la résiliation.
- **MailerLite** : `bf_status` (`lead|trial|active|past_due|read_only|churned`)
  et `bf_plan`, mis à jour à l'inscription et par le webhook.

---

## Variables et secrets

### Vercel (site)

| Variable                                          | Usage                                           |
| ------------------------------------------------- | ----------------------------------------------- |
| `STRIPE_SECRET_KEY`                               | clé Stripe (live en production)                 |
| `STRIPE_WEBHOOK_SECRET`                           | secret de signature de l'endpoint webhook       |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`       | écritures serveur (webhook, report-usage)       |
| `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` | vérification des jetons, lecture des places     |
| `PUBLIC_SITE_URL`                                 | base des URL de retour Checkout / portail       |
| `BILLING_HOOK_SECRET`                             | **nouveau** — authentifie pg_net → report-usage |
| `MAILERLITE_API_KEY`                              | champs `bf_status` / `bf_plan`                  |

### Supabase

| Où                | Nom                   | Valeur                                                         |
| ----------------- | --------------------- | -------------------------------------------------------------- |
| Vault             | `billing_hook_secret` | = `BILLING_HOOK_SECRET`                                        |
| Vault (optionnel) | `billing_report_url`  | défaut : `https://aeroxbefaster.com/api/billing/report-usage/` |
| Vault             | `bf_notify_secret`    | = secret Edge `BF_NOTIFY_SECRET`                               |
| Secrets Edge      | `BF_NOTIFY_SECRET`    | nouveau ; `SMTP_PASS` existe déjà                              |

### Webhook Stripe

Endpoint : `https://aeroxbefaster.com/api/stripe-webhook/` (slash final
obligatoire). Événements : `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid`, `invoice.payment_failed` — plus `charge.refunded` pour le
chantier « achats du diagnostic » mené en parallèle.

---

## Passage en live

Chaque étape marquée ⚠ touche la production : à faire sur accord explicite.

1. **Stripe live — réglages** (tableau de bord, pas d'API) : Taxes → siège
   social et immatriculation France (+ OSS si ventes B2C dans d'autres pays
   de l'UE) ; Billing → Revenue recovery → Retries : Smart Retries, 8
   tentatives sur 2 semaines recommandé (la grâce de 7 jours est tenue par le
   code quel que soit ce réglage) ; e-mails clients : factures et reçus
   activés.
2. ⚠ **Catalogue live** : créer `.env.live` avec la clé `sk_live_…`
   (jamais commitée), puis
   `node --env-file=.env.live scripts/stripe-catalog.ts --live --dry-run`,
   relire, et relancer sans `--dry-run`. Crée le meter, les 5 produits, les
   6 prix et la configuration du portail. Idempotent.
3. ⚠ **Webhook live** : ajouter les événements ci-dessus à l'endpoint
   existant (celui du diagnostic). Le secret de signature ne change pas.
4. ⚠ **Supabase prod** : appliquer les deux migrations dans l'ordre ; créer
   les secrets Vault ; déployer `notify-admin-new-bf` avec `--no-verify-jwt` et
   poser `BF_NOTIFY_SECRET`.
5. ⚠ **Vercel** : ajouter `BILLING_HOOK_SECRET`, vérifier `STRIPE_SECRET_KEY`
   live, déployer le site.
6. ⚠ **App desktop** : fusionner `feat-bf-billing`, publier. Les anciennes
   versions restent comptées par le filet de sécurité (sans possibilité de
   refus au démarrage).
7. **Test réel** : sur son propre compte bike fitter, ajouter une carte
   (essai débloqué), souscrire « À l'usage », faire une analyse, vérifier
   la facture de fin de mois, puis résilier. Vérifier aussi `bf_status` /
   `bf_plan` dans MailerLite et le bandeau de places.

---

## Tests

| Niveau       | Commande                                      | Couvre                                         |
| ------------ | --------------------------------------------- | ---------------------------------------------- |
| Unitaires    | `npm test`                                    | catalogue, règles de plan / grâce / factures   |
| SQL          | `bash supabase/tests/run.sh` (Docker)         | migrations, RLS, comptage, filet, réservations |
| Bout en bout | `node --env-file=.env scripts/billing-e2e.ts` | 10 scénarios Stripe (test clocks)              |

### Bout en bout (mode test)

1. `supabase start` dans un dossier jetable, puis appliquer un socle
   reproduisant `users`, `bf_clients`, `sessions` et le trigger
   `on_email_confirmed`, puis les migrations `bf_*`.
2. Vault local : `billing_hook_secret`, et `billing_report_url` sur l'IP de
   l'hôte vue depuis Docker (`getent ahostsv4 host.docker.internal`) — le
   serveur de dev refuse le nom `host.docker.internal`.
3. `STRIPE_API_KEY=<clé du .env> stripe listen --forward-to http://localhost:4399/api/stripe-webhook/`
   — **la clé du `.env` est celle de la sandbox « Environnement de test AeroX »,
   qui n'est pas le compte par défaut du Stripe CLI.**
4. `astro dev --port 4399 --host` avec les variables Supabase locales,
   `STRIPE_WEBHOOK_SECRET` de `stripe listen`, `BILLING_HOOK_SECRET`, et
   `MAILERLITE_API_KEY` vide (rien n'est écrit dans MailerLite).
5. `E2E_SUPABASE_URL=… E2E_SUPABASE_ANON_KEY=… E2E_SUPABASE_SERVICE_KEY=… E2E_SITE_URL=http://localhost:4399 E2E_BILLING_HOOK_SECRET=… node --env-file=.env scripts/billing-e2e.ts`

Particularité : Stripe refuse un meter event daté après l'heure du test clock
du client ; le scénario Studio avance l'horloge à l'heure réelle avant l'envoi.

---

## Limites connues et points ouverts

- **Places de lancement** : deux paiements simultanés à 19/20 peuvent donner
  21 abonnés (contrôle au Checkout, pas de réservation). Le webhook honore le
  paiement.
- **Essai** : une carte = un essai ; une personne avec plusieurs cartes peut
  encore cumuler quelques essais (2 analyses chacun).
- **Code taxe produit** `txcd_10103101` (SaaS, téléchargement, usage pro) :
  à valider par le comptable.
- **Liens de téléchargement** (`src/config/downloads.ts`) : ils pointent sur
  les releases GitHub v1.0.0, alors que `version.min_required` vaut 1.4.0.
- **Vidéo de calibration** : `CALIBRATION_VIDEO_URL` vide, bouton masqué.
- **Hors UE** : EUR partout ; TVA selon les immatriculations Stripe Tax.
