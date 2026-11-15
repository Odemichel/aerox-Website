# Audit UX · Conversion · Visibilité IA — aeroxbefaster.com — 12 septembre 2026

Version complète (tableaux, scores par plateforme) : artifact « Audit AeroX septembre 2026 ».

## Scores

| Axe                 | Score  | Résumé                                                                                                            |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| Cible & message     | 7/10   | Segment 1 (amateur indoor) très bien adressé. Segment 2 (one-shot avant course) et coachs absents.                |
| Conversion          | 3/10   | Aucune offre visible, 20 CTA vers un mur d'inscription, copy pré-lancement.                                       |
| UI/UX & perf        | 7/10   | Lighthouse mobile 86 (66 en mars), a11y 96. Bandeau FR sur toutes les langues, erreur JS, vidéo 1,26 Mo autoplay. |
| Visibilité IA (GEO) | 64/100 | Technique excellente (robots, llms.txt, SSR, schémas). Faits périmés, quasi zéro mention hors site.               |

## Constat n°1 : site figé au 10 avril 2026

- Compte à rebours « 0j 00h 00m 00s ! » dans le hero (`src/config/countdown.ts`, `index.astro:107`).
- Section Prices commentée (`index.astro:543`), menu « Tarifs » → `/fr/#pricing` inexistant.
- Clés `home.prices.*` périmées (5 € / 20 € / 140 €, « Lancement le 01/12/2025 ») vs modèle réel 79/179/249 € one-shot, 24 €/mois, 229 €/an, essai 14 j.
- « Sois le premier informé du lancement… 10 avril », « Réservé aux pionniers AeroX » (hero + header), « Dernière mise à jour : mars 2026 ».
- `public/llms.txt` : « Launching April 10, 2026 ». Schéma SoftwareApplication : `price 20, availability PreOrder`.
- Trois grilles de prix contradictoires : DeviensPionnier (paiement unique), bike-fitting (109 €/mois), modèle B2B (~49 €/mois).
- Dashboard post-inscription : packs périmés, CTA « Lancement le 01/12/2025 » (`dashboard.astro:129`).

## Cible

| Segment                                     | Verdict                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1 · Amateur indoor (sub 24 €/mois)          | Bien couvert : hero chiffré, vidéo, 4 témoignages, comparatif Zwift, FAQ objections.                                     |
| 2 · Triathlète semi-pro (one-shot 79-249 €) | Absent : aucune offre « position optimale avant ta course », pas de comparaison précision webcam/soufflerie sur la home. |
| 3 · Bike fitter (B2B)                       | Bonne page dédiée, prix 109 €/mois à aligner, vouvoiement vs header tutoyé.                                              |
| 4 · Coach                                   | Absent : un témoignage, pas de programme.                                                                                |

## Conversion

- Bandeau « NEW AeroX est disponible maintenant ! » : href `https://aeroxbefaster.com/` → 308 vers `/en/`. Codé en dur en français sur 9 langues (`Announcement.astro`).
- 20 CTA, une seule destination (`/inscription/inscription/`), aucun ne nomme l'offre ni le prix.
- Formulaire d'inscription sans réassurance (prix, essai, annulation), téléphone non signalé facultatif.
- Home répète 5 fois la même promesse, sans bloc offre ni chemin par objectif.
- Atouts non exploités : guide gratuit 60 pages (/method/) non relié à la home ; preuves (300+ sessions, 3 % répétabilité, fitters 3 continents).

## UI/UX & performance (Lighthouse 12.8.2 local, mobile, /fr/)

| Métrique    | Mars  | Sept                           | Seuil   |
| ----------- | ----- | ------------------------------ | ------- |
| Performance | 66    | 86                             | > 90    |
| LCP         | 6,9 s | 3,5 s                          | < 2,5 s |
| FCP         | 3,2 s | 2,8 s                          | < 1,8 s |
| Poids       | —     | 1 657 Ko (vidéo hero 1 262 Ko) |         |

- Render-blocking : 4 familles Google Fonts (Roboto et Russo One inutilisées sur la home), gain estimé 1,7 s.
- Erreur console `ReferenceError: Cannot access 'a' before initialization` (script inline, countdown/glitch minifié).
- Contrastes `text-gray-… dark:text-slate-400` toujours insuffisants (déjà signalé en mars).
- Logo servi 19×32 pour 32×32, rôle ARIA incompatible, ratio image.

## GEO

- Robots IA : GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Google-Extended autorisés. OK.
- SSR complet, définition « AeroX est… » dans les 60 premiers mots, titres-questions, FAQ visibles de 150-200 mots. OK.
- Schéma FAQPage : réponses de 21-32 mots seulement (version courte, sans chiffres).
- llms.txt et schémas périmés (voir constat n°1). VideoObject thumbnail = favicon.svg. Milan « Co-founder » dans llms.txt vs « Ambassadeur » sur /team/.
- Mentions hors site : aucune trouvée par recherche web (YouTube, Slowtwitch, presse). Reddit inaccessible depuis mes outils, à vérifier manuellement. Pas de Wikidata.
- Manque : comparatif AeroX vs Notio / Aerosensor / Body Rocket / vélodrome ; Person schema + sameAs sur /team/ ; dateModified réel ; stats datées.
- Estimation par plateforme : Google AIO 72, Claude/Gemini 65, ChatGPT 58, Perplexity 50.

## Plan d'action

| Prio | Action                                                                                                                             | Où                                             | Effort  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------- |
| P0   | Retirer countdown, « Réservé aux pionniers », « Sois le premier informé », « mars 2026 »                                           | countdown.ts, index.astro, 9 locales           | ½ j     |
| P0   | Réactiver Tarifs avec le vrai modèle, ancre `#pricing` fonctionnelle                                                               | index.astro:543, Pricing.astro, home.prices.\* | 1 j     |
| P0   | Bandeau : href `/{lang}/#pricing`, texte i18n                                                                                      | Announcement.astro                             | 30 min  |
| P0   | llms.txt + SoftwareApplication (offres réelles, InStock, thumbnail vidéo)                                                          | public/llms.txt, index.astro                   | 1 h     |
| P0   | Erreur JS console + dashboard packs périmés                                                                                        | dashboard.astro:129                            | 2 h     |
| P1   | Chemin segment 2 : bloc « une course dans 8 semaines ? » → page one-shot 79 €, relier le guide                                     | nouvelle page                                  | 2 j     |
| P1   | CTA différenciés par offre, réassurance sur le formulaire, téléphone « facultatif »                                                | inscription.astro                              | 1 j     |
| P1   | Prix bike fitter aligné + ligne coachs                                                                                             | bike-fitting/index.astro                       | 1 h     |
| P1   | 2 polices au lieu de 4 + preconnect, vidéo preload=none ou ≤ 500 Ko, contrastes                                                    | Layout.astro, Hero.astro                       | ½ j     |
| P2   | FAQ longues dans le schéma, Person schema /team/, stats datées, dateModified                                                       | utils/faq.ts, team.astro                       | 1 j     |
| P2   | Hors site : Reddit mensuel nommant AeroX, titres YouTube « AeroX », Wikidata, demande de test à DC Rainmaker / GPLama / Slowtwitch | hors code                                      | continu |
| P2   | Page comparative concurrents + calculateur minutes Ironman                                                                         | nouvelles pages                                | 3 j     |

## Méthode et limites

Code source (commit 05fda95, 28 mai 2026), HTML en ligne via curl le 12/09/2026 (9 langues + pages clés), robots.txt, llms.txt, sitemap, en-têtes Vercel, Lighthouse 12.8.2 local, audit KodeSaaS du 27/03/2026, segments ICP et modèle business AeroX. PageSpeed Insights (CrUX) en quota dépassé ; Reddit bloqué pour la recherche. Scores GEO par plateforme = estimations, pas des mesures de citations.
