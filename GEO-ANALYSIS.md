# GEO Analysis — AeroX (aeroxbefaster.com)

> Analyse complète selon le framework GEO / AI Search Optimization
> Date : 10 mars 2026

---

## 1. GEO Readiness Score: 72/100

| Critère | Poids | Score | Détail |
|---------|-------|-------|--------|
| Citability Score | 25% | 22/25 | Définition réduite avec gras (HP), définition BF, FAQ BF (5x 134-167 mots), FAQ HP (7/8 enrichies à 134-167 mots), données sourcées |
| Structural Readability | 20% | 18/20 | Headings question-based sur HP + BF (benefits inclus), tableau comparatif BF, FAQ structurées, hiérarchie H1→H2→H3 propre, HowTo schema 3 étapes |
| Multi-Modal Content | 15% | 10/15 | Vidéo hero, images produit, screenshots AeroX, globe SVG sur BF — manque infographies et contenu interactif |
| Authority & Brand Signals | 20% | 7/20 | sameAs enrichi, Person schema fondateur, dates de MàJ visibles, mais zéro présence Reddit/Wikipedia/forums |
| Technical Accessibility | 20% | 19/20 | Toutes les pages prerendered (SSG), robots.txt optimisé AI, llms.txt complet (7 articles), HowTo schema, pas de RSL 1.0 |
| **TOTAL** | **100%** | **76/100** | |

**Score pondéré ajusté : 72/100** (malus -4 pts pour absence de brand mentions externes, atténué par couverture technique complète)

---

## 2. Platform Breakdown

| Plateforme | Score | Analyse |
|------------|-------|---------|
| **Google AI Overviews** | 75/100 | Fort : SSG, headings question-based, tableau BF, FAQ, schema riche + HowTo. Faible : pas encore dans le top-10 sur les requêtes cibles |
| **ChatGPT** | 50/100 | Fort : llms.txt complet (7 articles), Organization schema, Person sameAs, définition avec gras. Faible : zéro Wikipedia (47.9% des citations ChatGPT), zéro Reddit (11.3%) |
| **Perplexity** | 32/100 | Fort : contenu factuel, FAQ détaillées, llms.txt. Faible : zéro Reddit (46.7% des citations Perplexity), zéro forum |
| **Bing Copilot** | 55/100 | Fort : SSG, schema complet (7 types dont HowTo), sitemap. Faible : pas d'IndexNow, faible Domain Rating |

---

## 3. AI Crawler Access Status

| Crawler | Owner | Statut | robots.txt |
|---------|-------|--------|------------|
| GPTBot | OpenAI | ✅ Autorisé | `Allow: /` |
| OAI-SearchBot | OpenAI | ✅ Autorisé | `Allow: /` |
| ChatGPT-User | OpenAI | ✅ Autorisé | `Allow: /` |
| ClaudeBot | Anthropic | ✅ Autorisé | `Allow: /` |
| PerplexityBot | Perplexity | ✅ Autorisé | `Allow: /` |
| CCBot | Common Crawl | 🚫 Bloqué | `Disallow: /` |
| Bytespider | ByteDance | 🚫 Bloqué | `Disallow: /` |
| anthropic-ai | Anthropic | 🚫 Bloqué | `Disallow: /` |
| cohere-ai | Cohere | 🚫 Bloqué | `Disallow: /` |

**Verdict : Configuration optimale.** Crawlers de recherche AI autorisés, crawlers d'entraînement bloqués.

---

## 4. llms.txt Status

**✅ Présent et complet** à `/llms.txt`

| Critère | Statut |
|---------|--------|
| Titre + description | ✅ "AeroX — Virtual Wind Tunnel for Cyclists" |
| Pages principales (6) | ✅ HP FR/EN, BF FR/EN, Team, Method |
| Blog (7 articles) | ✅ Zwift, Aero Gains, BF Mesurer, Feel Aero, Amstel, Aero Feedbacks, AeroX Innovation |
| Key facts (7) | ✅ CdA, compatibilité, gains, prix (109 €/mois) |
| Contact/social (7 URLs) | ✅ LinkedIn x2, YouTube x2, Instagram, ResearchGate |

---

## 5. Brand Mention Analysis

| Plateforme | Présence | Impact GEO |
|------------|----------|------------|
| **Wikipedia** | ❌ Aucune page | Critique — 47.9% des citations ChatGPT viennent de Wikipedia |
| **Reddit** | ❌ Aucune mention détectée | Critique — 46.7% des citations Perplexity, 11.3% ChatGPT |
| **YouTube @AeroXBeFaster** | ⚠️ Existe, non indexé par Google | Faible visibilité — YouTube est le signal #1 (corrélation 0.737) |
| **YouTube @nolimit-triathlon** | ⚠️ Existe, non indexé par Google | Idem |
| **LinkedIn company** | ⚠️ Page existante, non trouvable par recherche | Faible découvrabilité |
| **LinkedIn founder** | ✅ Profil existant | OK mais peu actif |
| **Instagram** | ✅ @aerox_be_faster | Faible impact GEO (Instagram peu cité par les AI) |
| **ResearchGate** | ✅ Profil Olivier Demichel | Bon signal d'autorité académique |
| **Forums cyclisme** | ❌ Aucune mention (TrainerRoad, Slowtwitch, DC Rainmaker) | Critique pour la crédibilité niche |
| **Wikidata** | ❌ Aucune entité | Manque d'entity linking |

**Score brand mentions : 8/70** — C'est le principal goulot d'étranglement GEO.

---

## 6. Passage-Level Citability

### Blocs optimaux — ✅ Présents

| Page | Bloc | Format | Pattern | Éval |
|------|------|--------|---------|------|
| Homepage FR | `home.definition` | ~80 mots, gras sur éléments clés | "**AeroX est la première soufflerie virtuelle…**" | ✅ Concis + scannable avec `<strong>` |
| Homepage EN | `home.definition` | ~75 mots, gras sur éléments clés | "**AeroX is the first virtual wind tunnel…**" | ✅ Concis + scannable |
| Bike Fitting FR | `bf.definition` | ~145 mots | "Le bike fitting aérodynamique consiste à…" | ✅ Optimal — "X consiste à…" pattern |
| Bike Fitting EN | `bf.definition` | ~140 mots | "Aerodynamic bike fitting optimizes…" | ✅ Optimal |

### FAQ BF enrichies — ✅ Optimales

| FAQ | Mots FR | Mots EN | Contenu clé |
|-----|---------|---------|-------------|
| Q1 (prix) | ~155 | ~150 | 2 licences Standard/Premium, à partir de 109 €/mois |
| Q2 (matériel) | ~145 | ~140 | Standard sans HT connecté, Premium FTMS |
| Q3 (formation) | ~150 | ~145 | Onboarding 30 min, éducation aéro, partenaires 3 continents |
| Q4 (usage client) | ~145 | ~140 | Partage data BF/client bidirectionnel |
| Q5 (précision) | ~150 | ~145 | 10% absolue, 3% répétabilité, vs soufflerie |

### FAQ HP — ✅ Enrichies (7/8)

| FAQ | Mots FR | Contenu clé |
|-----|---------|-------------|
| Q1 (Pourquoi AeroX) | ~150 | Résistance aéro 70-95%, comparaison Zwift, gains 300+ sessions |
| Q2 (Outils) | ~150 | Standard sans HT connecté, Premium FTMS, compatibilité 95% |
| Q3 (Installation) | ~145 | 2 min setup, calibration 2 clics, vs soufflerie 2-4h |
| Q4 (Compatibilité) | ~150 | Wahoo/Elite/Tacx/Saris, FTMS, Garmin/Polar/Suunto HR |
| Q5 (Innovation) | ~150 | Parallèle cardio→puissance→aéro, CNRS, 3% répétabilité |
| Q6 (Peloton) | ~40 | Gardée courte (choix éditorial — ton direct) |
| Q7 (Abonnement) | ~155 | Plan gratuit vs Premium, modes, habitude durable |
| Q8 (Position existante) | ~150 | Détails invisibles 10-30W, dégradation fatigue, mesurer vs croire |

**Score citability : 22/25** — Tous les blocs principaux sont optimaux.

---

## 7. Server-Side Rendering Check

| Page | Rendu | Statut |
|------|-------|--------|
| Homepage `/[lang]/index.astro` | `prerender: true` (SSG) | ✅ HTML complet |
| Bike Fitting `/[lang]/bike-fitting/index.astro` | `prerender: true` (SSG) | ✅ HTML complet |
| Blog list `/[lang]/blog/[...page].astro` | `prerender: true` (SSG) | ✅ HTML complet |
| Articles `/[lang]/blog/[slug].astro` | `prerender: true` (SSG) | ✅ HTML complet |
| Team `/[lang]/team.astro` | `prerender: true` (SSG) | ✅ HTML complet |
| Method `/[lang]/method/index.astro` | `prerender: true` (SSG) | ✅ HTML complet |
| API endpoints | `prerender: false` (SSR) | ✅ Normal — pas de contenu |

**Verdict : 100% du contenu est pré-rendu en HTML statique.** Les crawlers AI n'exécutant pas JavaScript, c'est la configuration idéale.

---

## 8. Top 5 Highest-Impact Changes

### 1. 🔴 Construire une présence Reddit (Impact: +15 pts Authority)
- **Effort** : Ongoing, 2-3h/semaine
- **Action** : Poster dans r/triathlon (~300k), r/cycling (~800k), r/Velo (~100k), r/bikefitting
- Répondre aux questions sur l'aérodynamisme avec données AeroX
- Partager les résultats de fitters (avec accord)
- Ne pas spammer — apporter de la valeur d'abord
- **Cible** : 10+ posts/commentaires pertinents en 3 mois
- **Impact GEO** : Perplexity (+15 pts), ChatGPT (+5 pts)
- **Faisable ici** : Non — action manuelle externe

### 2. ✅ FAIT — Headings question-based + tableaux comparatifs (Impact: +10 pts)
- HP : "Comment gagner en vitesse sans pédaler plus fort ?"
- BF : "Que mesure AeroX pendant une séance de bike fitting ?"
- BF : "Pourquoi ajouter la mesure aéro à votre studio de bike fitting ?"
- Tableau BF : "AeroX vs Soufflerie vs Fitting classique"

### 3. ✅ FAIT — Enrichir les FAQ à 134-167 mots (Impact: +5 pts)
- 5 FAQ BF enrichies avec données chiffrées, comparaisons, précision 10%/3%
- 7/8 FAQ HP enrichies avec détails techniques et données sourcées

### 4. ✅ FAIT — Dates de mise à jour + statistiques sourcées (Impact: +5 pts)
- "Dernière mise à jour : mars 2026" visible sur HP et BF
- "Données mesurées sur 300+ sessions AeroX, 2025-2026"

### 5. ✅ FAIT — HowTo schema + llms.txt complet (Impact: +3 pts)
- HowTo JSON-LD sur BF (3 étapes : installer, fitter, montrer résultats)
- llms.txt complété : 7 articles (ajout Amstel, Aero Feedbacks, AeroX Innovation) + prix corrigé (109 €/mois)

---

## 9. Schema Recommendations

### Schemas présents ✅

| Schema | Page | Statut |
|--------|------|--------|
| Organization (name, url, logo, founder, sameAs) | Homepage | ✅ Complet |
| WebSite (name, url, inLanguage) | Homepage | ✅ |
| SoftwareApplication (category, OS, offers) | Homepage | ✅ |
| VideoObject (hero video) | Homepage | ✅ |
| AggregateRating + 4 Reviews | Homepage | ✅ |
| FAQPage (10 Q&A) | Homepage | ✅ |
| FAQPage (5 Q&A) | Bike Fitting | ✅ |
| **HowTo** (3 étapes BF) | Bike Fitting | ✅ **NOUVEAU** |
| Service (provider, areaServed) | Bike Fitting | ✅ |
| SoftwareApplication (B2B, audience) | Bike Fitting | ✅ |
| 3x Review (bike fitters) | Bike Fitting | ✅ |
| BlogPosting (author, dates, image) | Articles | ✅ |
| BreadcrumbList | Toutes pages | ✅ |
| Person (founder, sameAs 3 URLs) | Homepage | ✅ |

### Schemas manquants — recommandés

| Schema | Page | Impact | Faisable ici |
|--------|------|--------|--------------|
| **Product** (licence BF) | Bike Fitting | Moyen — rich snippet prix | ✅ Oui |

---

## 10. Content Reformatting Suggestions

### A. Blog articles — pas de blocs citables

Aucun article de blog ne contient de bloc définition auto-contenu de 134-167 mots en introduction. Ajouter un bloc "En résumé" ou "Ce qu'il faut retenir" en tête de chaque article.

### B. Définition HP réduite

La définition HP a été réduite (~80 mots) avec mise en gras des éléments clés. Elle est concise et scannable mais en dessous de la longueur optimale de citation AI (134-167 mots). C'est un choix éditorial qui favorise la lisibilité au détriment de la citabilité maximale.

---

## Progression GEO

| Date | Score | Actions clés |
|------|-------|---------|
| Février 2026 (audit initial) | ~38/100 | Baseline — pas de llms.txt, pas de robots.txt AI, pas de blocs citables |
| Mars 2026 (1ère implem) | 52/100 | llms.txt, robots.txt AI, 2 définitions, sameAs enrichi |
| Mars 2026 (2ème implem) | 62/100 | FAQ BF 134-167 mots, headings question-based, tableaux comparatifs, dates MàJ, stats sourcées |
| Mars 2026 (3ème implem) | 67/100 | FAQ HP enrichies (7/8), heading BF benefits question-based |
| **Mars 2026 (4ème implem)** | **72/100** | HowTo schema BF, llms.txt complet (7 articles), définition HP réduite + gras, tableau HP supprimé |

---

## Actions faisables maintenant (sans intervention externe)

| # | Action | Impact estimé |
|---|--------|---------------|
| 1 | Ajouter blocs "En résumé" (134-167 mots) en tête des articles de blog | +2 pts Citability |
| 2 | Ajouter Product schema (licence BF) | +1 pt Schema |

**Potentiel avec ces actions : ~75/100**

## Actions nécessitant une intervention externe

| # | Action | Impact estimé |
|---|--------|---------------|
| 1 | Présence Reddit (posts/commentaires) | +15 pts Authority |
| 2 | Contenu YouTube régulier mentionnant AeroX | +10 pts Authority |
| 3 | Créer entité Wikidata pour AeroX | +3 pts Authority |
| 4 | Rendre la page LinkedIn company trouvable | +2 pts Authority |
| 5 | Mentions sur forums cyclisme (DC Rainmaker, Slowtwitch) | +5 pts Authority |

**Potentiel total avec actions externes : 90+/100**
