# Période de test + tarifs — design

- **Date** : 2026-09-22
- **Repo / branche** : `Odemichel/aerox-Website`, branche `main` (copie `~/SiteAeroX/aerox_on_astro/aerox-astro`)
- **Statut** : design validé — décision TTC actée, prix Stripe créés, plans d'implémentation écrits
- **Plans** :
  - `docs/superpowers/plans/2026-09-22-periode-test-et-cta.md` (11 tâches)
  - `docs/superpowers/plans/2026-09-22-tarifs-et-stripe.md` (7 tâches)
- **Écarts relevés entre cette spec et le code** : les plans corrigent trois affirmations fausses de ce document — le fallback anglais de `t()` qui n'existe pas (§8), le décompte des CTA rotatifs (§4), l'ancre `#contact` de la page bike-fitting qui est en réalité `#contact-bf` (§6.2) — et comblent deux trous : la grille des anciens packs rendue par `dashboard.astro:128-200`, et cinq clés datées ou « pionnier » que le grep de contrôle du §10 ne laisserait pas passer.

## 1. Objectif

Le site vend une offre terminée : le compte à rebours du lancement du 10 avril affiche « 0j 00h 00 », les CTA
renvoient à l'offre Pionnier, et la section tarifs est commentée depuis avril. Il faut remettre le site
dans un état qui correspond à l'offre actuelle :

1. remplacer l'appel à l'action par une prise de rendez-vous pour une période de test accompagnée ;
2. supprimer tous les éléments datés ;
3. réafficher les tarifs avec une offre B2C achetable (Diagnostic AeroX, 79 €) et une entrée B2B sur devis.

## 2. Décisions actées

| Sujet | Décision |
|---|---|
| Base de code | `main` (site en production). La branche `v3-produits` n'est pas touchée. |
| Destination du CTA | Formulaire de prise de rendez-vous (créneau accompagné), pas l'inscription directe. |
| Registre | Tutoiement, cohérent avec le reste du site. |
| CTA rotatifs | Unifiés sur un message unique. |
| Nature du test | Créneau accompagné par Olivier, sur rendez-vous. |
| Champs collectés | Nom, email, disponibilités, home-trainer, webcam. |
| Destination des leads | MailerLite + notification email immédiate. |
| Diagnostic 79 € | Achetable immédiatement par Stripe (décision révisée : ce n'est plus une précommande). |
| Achat | Connexion obligatoire avant le checkout. |
| Section tarifs | Une carte B2C (79 €) + une carte B2B sans prix (« nous contacter »). |

## 3. Purge des éléments datés

| Élément | Emplacement |
|---|---|
| `COUNTDOWN_TARGET = '2026-04-10'` | `src/config/countdown.ts:1` — fichier supprimé |
| Composant `CountDown` | `src/components/widgets/CountDown.astro` — supprimé |
| Décompte hero | `src/pages/[lang]/index.astro:5,107` |
| Décomptes tarifs | `src/components/widgets/Pricing.astro:6,7,148-158,270-274` + props `countdownTarget`, `countdownTarget1/2` (`src/types.d.ts:184-186`) |
| Décompte dashboard | `src/pages/[lang]/inscription/dashboard.astro:3,152` |
| « Lancement le 10 avril » | `home.hero.tagline` |
| « Réservé aux pionniers AeroX » | `home.hero.cta.subtext`, `nav.cta.subtext` |
| « accès prioritaire le 10 avril » | `home.leadmagnet.subtitle` |
| « Lancement le 01/12/2025 » ×3 | `home.prices.packDiscover.cta`, `packProgress.cta1`, `packProgress.cta2` |
| Clé `pricing.remaining` | dictionnaires |
| Anciens packs (5 / 20 / 140 €) | `home.prices.*` — 34 clés supprimées |
| Page `paiement.astro` (offre Pionnier) | redirection 301 vers `/{lang}/#pricing` |

## 4. CTA unifié

Les douze textes rotatifs (`home.hero.cta.text`, `home.features*.cta`, `home.testimonials.cta`,
`home.faq.cta`, `home.steps.cta`, `nav.cta.desktop`, `nav.cta.mobile`) sont supprimés au profit d'une paire
unique :

- `cta.testPeriod.text` = « Programme ta période de test »
- `cta.testPeriod.subtext` = « Séance accompagnée, sur rendez-vous »

Destination : `/{lang}/periode-test/` (aujourd'hui `/{lang}/inscription/inscription/`).

## 5. Formulaire de période de test

### 5.1 Composant partagé

Nouveau `src/components/widgets/LeadForm.astro`, piloté par une prop `topic` :

- `'test-period'` — nom, email, disponibilités (semaine / week-end × matin / après-midi / soir, cases à
  cocher), modèle de home-trainer, webcam oui/non, message libre ;
- `'bike-fitter'` — nom, email professionnel, message (comportement actuel de `/fr/bike-fitting/`).

La page `/fr/bike-fitting/` (`index.astro:464-494`) migre sur ce composant, à rendu inchangé pour le
visiteur. Nouvelle page `src/pages/[lang]/periode-test/index.astro` qui explique le déroulé du rendez-vous
et porte le formulaire.

### 5.2 Route API

`src/pages/[lang]/api/lead.ts`, `prerender = false`, `POST`, corps JSON `{ topic, name, email, message?,
availability?, trainer?, webcam?, hp? }`.

1. Validation : email obligatoire et bien formé, `topic` dans la liste blanche, champs texte bornés à
   2 000 caractères, honeypot `hp` — s'il est rempli, la requête répond 200 sans rien faire.
2. MailerLite : création de l'abonné dans le groupe du topic **et** dans le groupe de la langue
   (`AeroX Global - fr` `180112371932464856`, `AeroX Global - en` `180113595562985140`). Un groupe
   `periode-test` est créé pour le topic `test-period` ; `bike-fitter` conserve le comportement actuel.
3. Champs personnalisés à créer dans MailerLite (il n'en existe aucun aujourd'hui) : `home_trainer`,
   `webcam`, `dispos`, `message`. Cela met fin au stockage du message dans `last_name`
   (`bike-fitting/api/contact.ts:26`).
4. Notification : appel de l'Edge Function `notify-admin-lead`.

L'ancienne route `bike-fitting/api/contact.ts` est supprimée une fois la page migrée.

### 5.3 Edge Function de notification

Nouvelle fonction Supabase `notify-admin-lead`, calquée sur `notify-admin-pending-bf` (nodemailer, SMTP
IONOS `smtp.ionos.fr:587`, secret `SMTP_PASS` déjà configuré, destinataire `olivier.demichel@gmail.com`).
Elle reçoit `{ topic, fields }`, échappe chaque valeur en HTML et envoie un mail au sujet explicite
(« [AeroX] Demande de période de test — <nom> »). Déploiement avec `verify_jwt = true`, appelée avec la clé
anon comme l'existante.

## 6. Section tarifs

Le bloc commenté `src/pages/[lang]/index.astro:543-604` est réécrit avec `id="pricing"`, ce qui répare
l'entrée de menu « Tarifs » (`navigation.ts:44`), aujourd'hui une ancre morte.

### 6.1 Carte B2C — Diagnostic AeroX, 79 €, paiement unique

- mesure de la surface frontale sur 10 positions
- gains chiffrés pour chaque position
- comparaison de ton endurance dans chaque position
- recommandations personnalisées pour améliorer ton aéro en course

CTA « Je commande — 79 € ». Si le visiteur n'est pas connecté, redirection vers la page de connexion, puis
retour au point d'achat.

**Prérequis non existant à construire** : `connexion.astro:100` redirige aujourd'hui en dur vers
`/{lang}/inscription/dashboard/` et ne lit aucun paramètre. Il faut lui ajouter la prise en charge d'un
`?redirect=` (chemin relatif uniquement, commençant par `/` et sans `//`, pour éviter une redirection
ouverte vers un domaine tiers), sans quoi l'acheteur se retrouve sur le dashboard après connexion et perd
son intention d'achat.

### 6.2 Carte B2B — Bike-Fitters & studios, sur devis

Tarification au volume, suivi multi-clients, accompagnement à la prise en main. CTA « Contactez-nous » vers
`/{lang}/bike-fitting/#contact`.

## 7. Chaîne Stripe

### 7.1 État des lieux (vérifié le 2026-09-22 via le connecteur Stripe et l'API)

**Deux comptes Stripe distincts, pas deux modes d'un même compte :**

| Compte | ID | Rôle |
|---|---|---|
| AeroX | `acct_1RjHpWAmzoKsBiCN` | Production (live). Stripe Tax **actif**, siège FR / Dijon. |
| Environnement de test AeroX | `acct_1RjHpdPNYbroGsVd` | Sandbox. C'est lui dont les clés `sk_test_…` sont actives dans le `.env`. |

Les identifiants d'objets le confirment : suffixe `AmzoKsBiCN` en live, `PNYbroGsVd` en sandbox. Le
connecteur Stripe branché sur Claude n'expose que le compte live ; les écritures sandbox passent par la clé
du `.env`.

Le reste de l'état des lieux :

- `src/pages/[lang]/telechargement/api/create-api-checkout.ts` existe et est générique (`priceId` ou
  `lookupKey`, `mode: 'payment'`, `automatic_tax` activé).
- L'Edge Function `stripe-webhook` du repo `aerox-mycompanion` **n'est pas déployée** : seules
  `notify-admin-pending-bf` et `notify-client-post-fitting` tournent. Elle écrit dans `payments`,
  `subscriptions`, `users.stripe_customer_id` et `users.mrr_cents`, **qui n'existent pas en base**, et ne
  touche jamais `diagnostic_basic_paid`. Elle est donc inutilisable en l'état et reste hors périmètre.
- Les seules colonnes de déblocage réellement disponibles sont `users.diagnostic_basic_paid` (bool) et
  `users.diagnostic_basic_paid_at` (timestamptz).

### 7.2 Chaîne cible

1. **Prix Stripe — créé le 2026-09-22 sur les deux comptes.** Produit « Diagnostic AeroX », prix unique
   79 € EUR `one_time`, `lookup_key` `diagnostic_basic`, `tax_behavior: inclusive`, `tax_code`
   `txcd_10000000`.

   | Compte | Produit | Prix |
   |---|---|---|
   | Sandbox | `prod_VJ1bwEqIyHlJQq` | `price_1UIPYCPNYbroGsVd3aqiYETh` |
   | Live | `prod_VJ1ft6Mgt4Ec4p` | `price_1UIPcJAmzoKsBiCN96WVY4uZ` |

   Le code résout le prix par `lookup_key`, jamais par identifiant : la bascule sandbox → live se fait en
   décommentant les clés du `.env`, sans toucher au code ni à `STRIPE_PRICE_DIAGNOSTIC_ID` (variable
   devenue inutile, abandonnée).

   Le nom reste « Diagnostic AeroX » sans qualificatif : il sera requalifié le jour où une offre de
   diagnostic plus évoluée existera. Le `lookup_key` garde `diagnostic_basic`, aligné sur la colonne
   `users.diagnostic_basic_paid` — il est interne et n'apparaît jamais côté client.
2. **Checkout** : réutilisation de `create-api-checkout` avec `lookupKey: 'diagnostic_basic'`,
   `customer_email` = email du compte connecté, `metadata.userId` = id Supabase,
   `success_url = /{lang}/telechargement/success?product=diagnostic`.
3. **Webhook** : nouvelle route `src/pages/api/stripe-webhook.ts` (`prerender = false`), qui lit le corps
   brut via `await request.text()`, vérifie la signature avec `STRIPE_WEBHOOK_SECRET`, et sur
   `checkout.session.completed` avec `payment_status === 'paid'` et `metadata.userId` présent, passe
   `diagnostic_basic_paid = true` et `diagnostic_basic_paid_at = now()` via la clé service role déjà
   présente dans l'environnement du site. L'opération est idempotente par nature ; un rejeu ne change rien.
   Tout autre type d'événement renvoie 200 sans traitement.
4. **Page de succès** : `success.astro` adapte son message quand `product=diagnostic` — le diagnostic est
   débloqué, ouvrir l'application AeroX avec le même compte.

### 7.3 Pièges — confirmés par test réel le 2026-09-22

#### `subscription_data` : bug latent, armé précisément par cette feature

`create-api-checkout.ts:70` passe `subscription_data: { metadata }` dans une session `mode: 'payment'`.
L'API refuse cette combinaison — vérifié en sandbox : `You can not pass 'subscription_data' in 'payment'
mode.`

**Pourtant la route fonctionne aujourd'hui**, et c'est ce qui rend le piège dangereux. `metadata` n'est
rempli que si `body.userId` est fourni ; or aucun des quatre appelants ne le fournit (`paiement.astro:91`,
`index.astro:709`, `dashboard.astro:224`, `DeviensPionnier.astro:90`). `metadata` reste donc `{}`, et le SDK
Stripe **n'émet rien du tout** pour un objet vide — vérifié en interceptant le corps HTTP réellement
envoyé :

```
mode=payment&line_items[0][price]=…&success_url=…&cancel_url=…
```

`subscription_data` disparaît du fil. L'API ne le voit jamais, la session part, le paiement passe. C'est
ainsi que les ventes du site à 20 € ont abouti.

**Le jour où l'on passe `metadata.userId` — ce que le webhook du diagnostic exige — le paramètre est
sérialisé et toutes les sessions tombent en erreur 400.** La ligne `subscription_data: { metadata }` doit
être supprimée avant, pas après.

À noter : l'abonnement Early BikeFitter à 69 €/mois ne passe pas par cette route. Il vient du Payment Link
`plink_1TuCo9AmzoKsBiCNUxOMyU9F` en `mode: 'subscription'`, où `subscription_data` est parfaitement légal.
Il ne touche aucun code du site et n'est pas concerné.

#### TVA : aucune immatriculation, 0 € collecté aujourd'hui

`GET /v1/tax/registrations` renvoie une liste **vide** sur le compte live. Stripe Tax est « actif » mais
sans immatriculation il ne calcule aucune taxe : toutes les sessions live, y compris les clients français
(Bozouls 12340, Dijon…), affichent `total_details.amount_tax = 0`.

Conséquence : **aujourd'hui la distinction HT / TTC est sans effet.** Le client paie 79 €, AeroX encaisse
79 € (hors commission Stripe), que le prix soit marqué `inclusive` ou `exclusive`.

Le choix ne devient visible que le jour où une immatriculation TVA est ajoutée :

| `tax_behavior` | Client FR paie | AeroX encaisse HT |
|---|---|---|
| `inclusive` (retenu) | 79,00 € | 65,83 € |
| `exclusive` | 94,80 € | 79,00 € |

`inclusive` est retenu pour deux raisons : l'affichage B2C doit être TTC (Code de la consommation,
art. L112-1), et `exclusive` ferait grimper le prix du checkout à 94,80 € tout seul, sans que personne ne
touche au site, le jour de l'immatriculation. Si la marge doit être protégée à ce moment-là, la réponse est
de relever le prix TTC affiché, pas de basculer en `exclusive`.

Le prix Early BikeFitter 69 €/mois (`price_1TuCkMAmzoKsBiCNBtiPqdaF`) est en `tax_behavior: unspecified` et
porte le même risque latent — hors périmètre de cette spec, mais à traiter avant immatriculation.

#### Autres points

- `automatic_tax.status` vaut `requires_location_inputs` à la création : Stripe Tax réclame l'adresse du
  client, que `billing_address_collection: 'auto'` collecte pendant le checkout. Rien à corriger.
- L'adaptive pricing est actif : un client hors zone euro voit le prix converti (le client US de l'abonnement
  a vu 82,09 USD pour 69 €).
- Le `.env` du site pointe sur le **sandbox** ; le jeu de clés live est commenté.

## 8. Internationalisation

`SUPPORTED_LOCALES = [fr, en, pt, es, it, de, nl, ja, tr]`. Le français et l'anglais sont rédigés à la main ;
les sept autres langues s'appuient d'abord sur le fallback anglais déjà implémenté dans `t()`
(`src/lib/i18n.ts`), puis sont traduites dans un second temps. Les clés supprimées le sont dans les neuf
dictionnaires.

## 9. Sécurité

- La route `lead.ts` est publique et déclenche un email : honeypot, bornage des champs et limite de débit
  par IP sont obligatoires, sinon elle devient un canal de spam direct vers la boîte d'Olivier.
- Le webhook Stripe vérifie la signature avant tout traitement et n'accepte aucun identifiant utilisateur
  venu d'ailleurs que de `metadata` signé par Stripe.
- La clé service role ne sort jamais du serveur : la route webhook est SSR, jamais préchargée.

## 10. Vérification

- `npm run check` et `npm run build`.
- POST manuel sur `/fr/api/lead/` avec un groupe MailerLite de test : abonné créé, mail reçu, honeypot
  silencieux.
- Checkout de test Stripe de bout en bout : paiement en carte de test, `diagnostic_basic_paid` passé à
  `true` pour le bon compte, page de succès adaptée.
- Grep de contrôle : plus aucune occurrence de `CountDown`, `COUNTDOWN`, « pionnier », « 10 avril »,
  `pricing.remaining` hors historique Git.
- Ancre `/fr/#pricing` fonctionnelle depuis le menu.

## 11. Hors périmètre

- Aucun passage du site en vouvoiement.
- Aucune reprise de l'Edge Function `stripe-webhook` du repo mycompanion, ni des tables `payments` /
  `subscriptions` qu'elle suppose.
- Aucune offre B2C autre que le diagnostic.

## 12. Dette assumée

La branche locale `v3-produits` (8 commits, jamais poussée) contient déjà une page `/fr/diagnostic/` à 79 €
et un composant `Offers.astro` A/B. Ce design crée donc une seconde version de la même offre sur `main`. Le
jour où `v3-produits` sera déployée, il faudra arbitrer entre les deux — choix assumé pour livrer sur le
site réellement en ligne.
