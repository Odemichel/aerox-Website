# GEO Audit — AeroX (aeroxbefaster.com)

**Date** : 2026-03-24
**Objectif** : Optimiser la citabilité du site par les LLM (ChatGPT, Claude, Gemini, Perplexity)

---

## 1. llms.txt

| Critère | Statut avant audit | Détail |
|---------|--------------------|--------|
| Présence de `/llms.txt` | OK | Fichier existant, 41 lignes |
| Contenu structuré | INSUFFISANT | Manquait : définition physique du CdA, specs techniques, use cases, pricing détaillé, target users |
| `/llms-full.txt` | ABSENT | Aucun fichier de référence complète pour les LLM |

**Verdict** : llms.txt existant mais trop léger pour une citation riche. Pas de llms-full.txt.

---

## 2. FAQ — Rendu HTML vs JavaScript

| Critère | Statut | Détail |
|---------|--------|--------|
| Contenu FAQ dans le HTML statique | OK | Les FAQ utilisent `<details>/<summary>` natif HTML5, pas de JS |
| Réponses présentes dans le DOM | OK | Le contenu `education` est rendu côté serveur dans le `<details>`, visible par les crawlers |
| Schema FAQPage | OK | JSON-LD FAQPage avec 10 Q&A sur la homepage |

**Verdict** : Aucune correction nécessaire. L'implémentation est déjà optimale pour les crawlers LLM.

---

## 3. Blocs de faits citables

| Donnée clé | Présente en HTML statique ? | Emplacement |
|-------------|----------------------------|-------------|
| 300+ sessions | PARTIEL | Uniquement dans `home.stats.source` (texte xs) |
| +2,3 km/h | OK | Stats widget (HTML statique, pas de JS counter) |
| -35 W | OK | Stats widget |
| Répétabilité 3 % | ABSENT | Nulle part dans le HTML de la homepage |
| Compatible Wahoo, Elite, Tacx, Saris | PARTIEL | Dans le `home.definition` mais pas consolidé |

**Verdict** : Les stats sont bien en HTML statique (pas de compteur JS animé). Mais il manque un bloc texte consolidé avec toutes les métriques clés, notamment la répétabilité de 3 %.

---

## 4. Pages définition standalone

| Page | Statut |
|------|--------|
| `/fr/cda/` | ABSENTE |
| `/en/cda/` | ABSENTE |
| `/fr/aerodynamisme-cyclisme/` | ABSENTE |

**Verdict** : Aucune page de définition standalone. Le site ne peut pas être cité sur des requêtes génériques type "qu'est-ce que le CdA en cyclisme".

---

## 5. robots.txt

| Crawler | Statut avant audit |
|---------|--------------------|
| GPTBot | Autorisé |
| OAI-SearchBot | Autorisé |
| ChatGPT-User | Autorisé |
| ClaudeBot | Autorisé |
| PerplexityBot | Autorisé |
| Google-Extended (Gemini) | ABSENT |
| CCBot | Bloqué |
| Bytespider | Bloqué |
| anthropic-ai | Bloqué |
| cohere-ai | Bloqué |
| Sitemap référencé | OK |

**Verdict** : Bonne configuration. Seul Google-Extended (crawler Gemini de Google) était manquant.

---

## 6. Métadonnées structurées (schema.org)

| Schema | Page | Statut |
|--------|------|--------|
| FAQPage | Homepage | OK (10 Q&A) |
| Organization | Homepage | OK (avec founder, sameAs) |
| WebSite | Homepage | OK |
| SoftwareApplication | Homepage | OK (catégorie, OS, prix) |
| SoftwareApplication (reviews) | Homepage | OK (4 reviews, 4.8/5) |
| VideoObject | Homepage | OK |
| BreadcrumbList | Toutes pages | OK (dynamique) |
| BlogPosting | Articles blog | OK |
| Person (standalone) | Aucune | ABSENT (imbriqué dans Organization uniquement) |

**Verdict** : Couverture schema.org déjà très bonne. Le Person pour Olivier Demichel est imbriqué dans Organization, ce qui est suffisant.

---

## Score GEO global avant audit : 62/100

| Critère | Score | Poids |
|---------|-------|-------|
| Citabilité (passages 134-167 mots) | 14/25 | Definition block OK, mais pas de page dédiée CdA |
| Structure (H1-H3, FAQ, tables) | 17/20 | Bonne hiérarchie, FAQ native, manque page CdA |
| Multi-modal | 12/15 | Vidéo, images, texte — bon |
| Autorité | 12/20 | Person schema, ResearchGate, mais pas Wikipedia |
| Accessibilité technique | 15/20 | SSR Astro, robots.txt OK, llms.txt léger |

## Score GEO estimé après corrections : 81/100
