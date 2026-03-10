# SEO Priorities — AeroX (aeroxbefaster.com)

> Mis à jour : 2026-03-10

---

## Résumé d'avancement

| Statut | Compte |
|--------|--------|
| ✅ Fait | 12/20 |
| ⏳ Reste | 8/20 |

---

## 🔴 Critique — Corrigé

| # | Action | Statut | Détails |
|---|--------|--------|---------|
| 1 | Créer et soumettre sitemap.xml | ✅ Fait | `@astrojs/sitemap` dans `astro.config.ts`, accessible à `/sitemap-index.xml` |
| 2 | Ajouter balises hreflang FR ↔ EN + x-default | ✅ Fait | `Layout.astro` — `hrefForLang()` + `blogSlugPairs` + `monoLangSlugs` (skip les articles sans traduction) |
| 3 | Ajouter canonical self-referencing | ✅ Fait | `Metadata.astro` — auto via `getCanonical(Astro.url.pathname)` |
| 4 | Rédiger méta descriptions uniques | ✅ Fait | Toutes les pages via clés i18n (`home.meta.description`, etc.) + frontmatter articles |
| 5 | Ajouter référence Sitemap dans robots.txt | ✅ Fait | `robots.txt` réécrit avec stratégie crawlers AI + `Sitemap: .../sitemap-index.xml` |

## 🟠 Élevé — Corrigé

| # | Action | Statut | Détails |
|---|--------|--------|---------|
| 6 | Schema BlogPosting sur chaque article | ✅ Fait | `[slug].astro` — JSON-LD avec author, datePublished, dateModified, image |
| 7 | Supprimer FAQ schema générique des articles | ✅ Fait | Retiré de `Metadata.astro`, conservé uniquement sur homepage |
| 8 | Bloc auteur avec bio sur chaque article | ✅ Fait | `SinglePost.astro` — photo, nom, rôle, bio i18n, lien vers `/[lang]/team/` |
| 9 | Optimiser H1 homepage | ✅ Fait | `home.hero.title.l1` + `l2` — "Ton home trainer / devient une soufflerie virtuelle" |
| 14 | Schema Organization + WebSite | ✅ Fait | `index.astro` — Organization (founder Person, sameAs enrichi) + WebSite + SearchAction |
| 15 | Schema BreadcrumbList | ✅ Fait | `Layout.astro` — généré dynamiquement, labels traduits |
| 19 | Lien blog depuis homepage | ✅ Fait | Section "Explore AeroX" sur homepage |

## ⏳ Reste à faire

| # | Action | Statut | Notes |
|---|--------|--------|-------|
| 10 | Optimiser H1 blog index | ❌ À faire | Reverté — nécessite keyword research avant changement (actuellement "Nos Articles") |
| 11 | Ajouter liens externes dans les articles | ❌ À faire | Citer sources scientifiques, Strava, études — aucun lien externe actuellement |
| 12 | Corriger alt texts des images | ❌ À faire | Actuellement alt = titre article (sous-optimal), décrire le contenu réel de l'image |
| 13 | Créer miroirs EN pour tous les articles FR | ❌ À faire | 2 articles mono-langue restent : `aerox-innovation-fr` (pas de EN), `feel-aero-en` (pas de FR). Hreflang corrigé pour ne pas pointer vers des 404 |
| 16 | Evergreen article Amstel Gold Race | ❌ À faire | Article événementiel (avril 2025) — transformer en contenu evergreen sur les classiques cyclisme |
| 17 | Tester Core Web Vitals | ❌ À faire | Tester sur PageSpeed Insights — viser LCP <2.5s, CLS <0.1, INP <200ms |
| 18 | Optimiser title tags des articles | ❌ À faire | Inclure keyword cible explicitement dans les titles (ex: "Position aéro vélo : …") |
| 20 | Corriger slugs redondants (-fr dans /fr/) | ❌ À faire | Supprimer le suffixe `-fr` des slugs FR (redondant avec `/fr/`). Nécessite redirections 301 |

---

## Ajouts post-audit (GEO / AI Search)

Implémentés lors de l'optimisation GEO (mars 2026) :

| Action | Statut |
|--------|--------|
| `llms.txt` pour crawlers AI | ✅ Fait |
| `robots.txt` avec stratégie crawlers AI (allow GPTBot, ClaudeBot, PerplexityBot / block CCBot, Bytespider) | ✅ Fait |
| Blocs de définition citables (134-167 mots) sur HP + Bike Fitting | ✅ Fait |
| `sameAs` enrichi (LinkedIn, YouTube x2, Instagram, ResearchGate) | ✅ Fait |
| VideoObject schema pour hero video | ✅ Fait |
| Review/AggregateRating schema (4 témoignages, 4.8/5) | ✅ Fait |
| Micro-animations (bf-fade-in + Intersection Observer) sur Bike Fitting | ✅ Fait |
| SVG icons métriques sur Bike Fitting | ✅ Fait |
| FAQ accent couleur (open state) sur Bike Fitting | ✅ Fait |
| CTAs variés sur Bike Fitting (3 formulations distinctes) | ✅ Fait |

---

## Prochaines priorités suggérées (par impact)

1. **#11 Liens externes** — Impact E-E-A-T direct, rapide à implémenter
2. **#18 Title tags** — Quick win CTR, keyword research léger
3. **#12 Alt texts** — Accessibilité + image SEO
4. **#10 H1 blog index** — Après keyword research
5. **#13 Miroirs EN** — Expansion internationale
6. **#20 Slugs -fr** — Nettoyage URL (301 nécessaires, risque si mal fait)
7. **#16 Amstel evergreen** — Contenu éditorial
8. **#17 Core Web Vitals** — À mesurer d'abord avant d'agir
