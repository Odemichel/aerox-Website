# CLAUDE.md — AeroX Astro Project

## Projet

Site web **AeroX** — SaaS d'analyse aérodynamique temps réel pour cyclistes indoor.
Basé sur le template **AstroWind** (v1.0.0-beta.52), hébergé sur **Vercel** (SSR via `@astrojs/vercel`).

- **URL production** : `https://aeroxbefaster.com` (sans www)
- **Framework** : Astro 5.x + Tailwind CSS 3 + React 19
- **Langues** : FR (défaut) + EN, préfixe obligatoire (`/fr/`, `/en/`)
- **Trailing slash** : `always` (toutes les URLs finissent par `/`)

---

## Architecture des fichiers clés

```
aerox-astro/
├── astro.config.ts              # Config Astro (site, i18n, integrations, adapters)
├── src/
│   ├── config.yaml              # Metadata globales, blog config, analytics, UI
│   ├── lib/i18n.ts              # Système i18n (getDict, t, SUPPORTED_LOCALES)
│   ├── locales/
│   │   ├── fr.json              # ~470 clés de traduction FR
│   │   └── en.json              # ~450 clés de traduction EN
│   ├── navigation.ts            # Navigation header/footer par langue (makeNavigation)
│   ├── layouts/
│   │   ├── Layout.astro         # Layout racine (<html>, <head>, hreflang, metadata)
│   │   ├── PageLayout.astro     # Layout page (Header + Footer + slot)
│   │   ├── MarkdownLayout.astro # Layout pour pages .md
│   │   └── LandingLayout.astro  # Layout landing pages
│   ├── components/
│   │   ├── common/
│   │   │   ├── Metadata.astro   # SEO: canonical, meta desc, OG, Twitter, FAQ schema
│   │   │   ├── CommonMeta.astro # charset, viewport, lien sitemap
│   │   │   └── ...
│   │   ├── widgets/             # Composants réutilisables (Hero, FAQs, Features, etc.)
│   │   ├── blog/                # Grid, List, Pagination, RelatedPosts, SinglePost
│   │   └── ui/                  # Button, ItemGrid, Timeline, etc.
│   ├── pages/
│   │   ├── index.astro          # Redirect vers /fr/
│   │   ├── [lang]/
│   │   │   ├── index.astro      # Homepage (avec i18n)
│   │   │   ├── blog/
│   │   │   │   ├── [...page].astro        # Blog list paginé
│   │   │   │   ├── [slug].astro           # Article individuel
│   │   │   │   ├── [category]/[...page].astro
│   │   │   │   └── [tag]/[...page].astro
│   │   │   ├── team.astro       # Page équipe
│   │   │   ├── contact.astro    # Page contact
│   │   │   ├── method/          # Méthode + inscription ML
│   │   │   ├── inscription/     # Inscription, connexion, dashboard, confirmation
│   │   │   ├── telechargement/  # Téléchargement, success/cancel Stripe
│   │   │   └── paiement.astro   # Page paiement
│   │   ├── fr/ et en/           # Pages statiques (terms.md, privacy.md)
│   │   └── homes/, landing/     # Templates AstroWind (non utilisés en prod)
│   ├── data/
│   │   └── post/                # Articles de blog (MDX)
│   │       ├── zwift-fr.mdx / zwift-en.mdx
│   │       ├── aero-gain-chronometrique-fr.mdx / -en.mdx
│   │       ├── amstel-gold-race-2025-fr.mdx / -en.mdx
│   │       ├── aero-feedbacks-fr.mdx / -en.mdx
│   │       ├── aerox-innovation-fr.mdx        # ⚠ PAS de version EN
│   │       ├── BF-mesurer-fr.mdx / -en.mdx
│   │       └── feel-aero-en.mdx               # ⚠ PAS de version FR
│   ├── content/config.ts        # Zod schema pour posts (collection Astro)
│   ├── utils/
│   │   ├── blog.ts              # fetchPosts, getNormalizedPost, getRelatedPosts
│   │   ├── permalinks.ts        # getCanonical, getPermalink, cleanSlug
│   │   ├── images.ts            # findImage, adaptOpenGraphImages
│   │   ├── localize.ts          # localizedHref helper
│   │   └── frontmatter.ts       # Remark/Rehype plugins (reading time, lazy images)
│   ├── config/
│   │   └── supabaseClient.ts    # Client Supabase (auth)
│   │   └── countdown.ts         # Date cible countdown
│   └── assets/                  # Images, vidéos, favicons, styles
├── public/
│   └── robots.txt               # User-agent: * / Disallow: (INCOMPLET)
└── package.json                 # Scripts: dev, build, check, fix
```

---

## Flux des métadonnées SEO

```
Page (.astro) → définit `metadata = { title, description, robots, ... }`
    ↓
PageLayout.astro → passe metadata à Layout.astro
    ↓
Layout.astro → fusionne (config.yaml defaults + metadata_i18n[lang] + page metadata)
             → injecte <Metadata /> (canonical, description, OG, Twitter)
             → injecte hreflang alternates
             → injecte <CommonMeta /> (charset, viewport, sitemap link)
    ↓
Metadata.astro → utilise @astrolib/seo (AstroSeo)
              → getCanonical(Astro.url.pathname) par défaut
              → merge: base defaults → config.yaml → page props
              → ⚠ INCLUT le FAQPage schema en dur (hardcodé, pas conditionnel)
```

---

## Système i18n

- **Module** : `src/lib/i18n.ts`
- **Dictionnaires** : `src/locales/fr.json` et `src/locales/en.json`
- **Usage** : `const dict = getDict(lang); t(dict, 'clé.imbriquée')`
- **Locales supportées** : `['fr', 'en']` (type `Locale`)
- **Routing** : `[lang]/` comme paramètre dynamique, `getStaticPaths` génère les deux
- **Navigation** : `makeNavigation(lang)` génère header/footer traduits

### Clés i18n importantes pour le SEO

| Page | Clé title | Clé description |
|------|-----------|-----------------|
| Homepage | `home.meta.title` | `home.meta.description` |
| Team | `ourStory.meta.title` | `ourStory.meta.description` |
| Method/Book | `book.meta.title` | `book.meta.description` |
| Contact | `contact.title` | `contact.description` |
| Inscription | `signup.meta.title` | `signup.meta.description` |
| Blog list | hardcodé dans `[...page].astro` | hardcodé inline |

---

## Articles de blog

- **Emplacement** : `src/data/post/*.mdx`
- **Collection Astro** : définie dans `src/content/config.ts` via glob loader
- **Frontmatter** :
  ```yaml
  publishDate: 2026-02-12T00:00:00Z
  author: "Olivier Demichel"
  title: "Titre de l'article"
  excerpt: "Résumé court (utilisé comme description si metadata.description absent)"
  lang: "fr"                    # Filtre par langue
  imageKey: "clé-image"         # Résolu via src/data/blogImages.ts
  tags: ["tag1", "tag2"]
  metadata:
    canonical: "https://..."    # Optionnel, override auto
    description: "Meta desc"    # Prioritaire sur excerpt
  ```
- **Permalink** : `/{lang}/blog/{slug}/` (slug = nom du fichier sans extension)
- **Description SEO** : `post.metadata.description` > `post.excerpt` > config.yaml default

### Paires linguistiques

| Article FR | Article EN | Status |
|-----------|-----------|--------|
| zwift-fr | zwift-en | OK |
| aero-gain-chronometrique-fr | aero-gain-chronometrique-en | OK |
| amstel-gold-race-2025-fr | amstel-gold-race-2025-en | OK |
| aero-feedbacks-fr | aero-feedbacks-en | OK |
| BF-mesurer-fr | BF-mesurer-en | OK |
| aerox-innovation-fr | — | MANQUANT EN |
| — | feel-aero-en | MANQUANT FR |

---

## SEO — Audit Priority 1 : Statut actuel

Réf : `SEO-PRIORITIES.md` (fichier d'audit externe)

### 1. Meta descriptions — RESOLU dans le code
Toutes les pages passent une `description` via le système i18n ou le frontmatter des articles.
- Homepage : `home.meta.description` (FR + EN)
- Blog list : inline dans `[...page].astro`
- Articles : `metadata.description` dans chaque MDX
- Autres pages : via clés i18n dédiées
- Fallback global : `config.yaml` → `metadata.description`

### 2. Hreflang — CORRIGE
`Layout.astro:52-59` : `hrefForLang()` gnre des URLs absolues avec `SITE.site` origin.
Inclut FR, EN et x-default sur chaque page.
**Limite** : le mapping hreflang entre articles FR/EN est bas sur l'URL (mme slug), pas sur la paire linguistique relle.

### 3. Canonical — CORRIGE
`Metadata.astro:20` : auto-gnr via `getCanonical(Astro.url.pathname)`.
Les overrides hardcods incorrects dans `zwift-fr.mdx` et `zwift-en.mdx` ont t supprims.

### 4. Sitemap — CORRIGE
- `@astrojs/sitemap` avec filtre dans `astro.config.ts` (exclut `/homes/`, `/landing/`, `/inscription/`, `/telechargement/`, `/paiement/`, `/404`)
- Accessible en prod : `/sitemap-index.xml` et `/sitemap-0.xml` (HTTP 200)
- Contient routes FR + EN

### 5. robots.txt — CORRIGE
```
User-agent: *
Disallow:

Sitemap: https://aeroxbefaster.com/sitemap-index.xml
```

### 6. FAQ schema — CORRIGE
Retir de `Metadata.astro` (o il apparaissait sur toutes les pages).
Dplac dans `src/pages/[lang]/index.astro` uniquement (homepage).

---

## SEO — Sprint Élevé (#6-#10) : RÉSOLU

### 6. BlogPosting schema — CORRIGÉ
`src/pages/[lang]/blog/[slug].astro` : JSON-LD `BlogPosting` injecté avec headline, author, publisher, datePublished, dateModified, image.

### 7. FAQ schema générique — DÉJÀ CORRIGÉ (sprint précédent)
Retiré de `Metadata.astro`, déplacé dans `index.astro` uniquement.

### 8. Bloc auteur sur les articles — CORRIGÉ
`src/components/blog/SinglePost.astro` : Bloc auteur ajouté en bas d'article avec photo, nom, rôle, bio (i18n) et lien vers `/[lang]/team/`.

### 9. H1 homepage optimisé — CORRIGÉ
- FR : "Analyse aérodynamique / pour le vélo indoor" (avant : "Le cyclisme indoor / l'aérodynamisme en plus")
- EN : "Real-time aero analysis / for indoor cycling" (avant : "Indoor cycling / Now with real-time aero")
- Clés i18n : `home.hero.title.l1` + `home.hero.title.l2`

### 10. H1 blog index optimisé — CORRIGÉ
- FR : "Blog Cyclisme & Aérodynamisme" (avant : "Nos Articles")
- EN : "Cycling & Aerodynamics Blog" (avant : "Our Articles")
- Clé i18n : `blog.title`

---

## Problèmes SEO encore ouverts

| # | Problème | Fichier | Impact |
|---|----------|---------|--------|
| 1 | **2 articles sans paire linguistique** | `aerox-innovation-fr.mdx`, `feel-aero-en.mdx` | Moyen — Hreflang pointe vers page 404 |
| 2 | **Mapping hreflang FR↔EN par slug** | `src/layouts/Layout.astro` | Moyen — `zwift-fr` pointe vers `/en/blog/zwift-fr/` au lieu de `/en/blog/zwift-en/` |

---

## Commandes utiles

```bash
# Développement
cd aerox_on_astro/aerox-astro
npm run dev              # Serveur de dev local
npm run build            # Build production
npm run preview          # Preview du build
npm run check            # Astro check + ESLint + Prettier

# Vérifications
npm run check:astro      # Types Astro uniquement
npm run fix              # Auto-fix ESLint + Prettier
```

---

## Stack technique

| Composant | Technologie |
|-----------|------------|
| Framework | Astro 5.x |
| CSS | Tailwind CSS 3 + @tailwindcss/typography |
| UI | React 19 (composants interactifs) |
| Icons | astro-icon + Tabler + Flat Color Icons + Emojione + Twemoji |
| SEO | @astrolib/seo |
| Blog | Astro Content Collections (glob loader, MDX) |
| Auth | Supabase |
| Paiement | Stripe |
| Analytics | Vercel Analytics + Speed Insights + Cloudflare Web Analytics |
| Hosting | Vercel (SSR) |
| Compression | astro-compress |
| Markdown | MDX + remark (reading-time) + rehype (lazy images, responsive tables) |
