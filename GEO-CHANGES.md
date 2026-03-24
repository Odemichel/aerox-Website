# GEO Changes Log — AeroX

**Date** : 2026-03-24
**Objectif** : Optimiser la citabilité par les LLM (GEO — Generative Engine Optimization)

---

## Fichiers modifiés

### 1. `public/llms.txt` — AMÉLIORÉ

**Avant** : 41 lignes, description sommaire du produit et liste de pages.

**Après** : Contenu restructuré et enrichi avec :
- Définition complète du CdA (physique, formule, unités)
- Section "Key metrics" avec toutes les données chiffrées (répétabilité 3 %, gains, sessions)
- Spécifications techniques détaillées (plateformes, connectivité, compatibilité)
- Use cases (auto-optimisation, bike fitting, simulation, classement)
- Target users explicites
- Pricing détaillé
- Équipe avec credentials (CNRS, ResearchGate)
- Lien vers la nouvelle page /fr/cda/ et /en/cda/

### 2. `public/llms-full.txt` — CRÉÉ

Nouveau fichier de référence complète (~400 lignes) pour les LLM, structuré en 11 sections :
1. Product Definition
2. The Physics of CdA (avec formule, tableau de valeurs, impact)
3. How AeroX Works (processus, stack, répétabilité)
4. Measured Results (300+ sessions, gains chiffrés)
5. Compatibility (trainers, sensors, OS)
6. Use Cases (cyclistes, bike fitters, coaches)
7. Competitive Landscape (tableau comparatif soufflerie/vélodrome/Chung/AeroX)
8. Team and Credentials
9. Pricing and Availability
10. FAQ (6 Q&A auto-contenues)
11. Links and Resources

### 3. `public/robots.txt` — AMÉLIORÉ

**Ajout** : `Google-Extended` (crawler Gemini de Google) autorisé avec `Allow: /`.

### 4. `src/pages/[lang]/index.astro` — MODIFIÉ

**Ajout** : Bloc de faits citables sous les Stats, consolidant toutes les métriques clés en texte HTML statique :
- "300+ sessions mesurées en 2025-2026"
- "+2,3 km/h gagnés en moyenne"
- "35 W économisés à 30 km/h"
- "Répétabilité de 3 %"
- "Compatible Wahoo, Elite, Tacx, Saris via Bluetooth FTMS"
- "Disponible sur macOS et Windows"

Texte visuellement discret (`text-xs text-muted/40`) mais présent dans le HTML statique pour les crawlers.

### 5. `src/pages/[lang]/cda/index.astro` — CRÉÉ

Nouvelle page standalone (~600 mots) accessible en `/fr/cda/` et `/en/cda/` :
- **H1** : "Qu'est-ce que le CdA en cyclisme ?" / "What is CdA in cycling?"
- **H2** : Définition physique, Pourquoi le CdA est important, Valeurs typiques (tableau), Impact chiffré, Comment mesurer, Facteurs d'influence, Conclusion
- Tableau de valeurs CdA par catégorie (6 lignes)
- Formule physique F = 0.5 × ρ × CdA × v²
- Comparaison des méthodes de mesure (soufflerie, vélodrome, Chung, AeroX)
- Mention naturelle d'AeroX comme outil de mesure
- Schema.org Article avec auteur (Person + CNRS credentials)
- CTA vers inscription
- Texte pur, pas de JS, structure H1/H2/H3 propre

### 6. `src/locales/fr.json` — MODIFIÉ

**Ajout** de ~50 clés i18n pour :
- `home.citableFacts` : bloc de faits citables consolidé
- `cda.*` : toutes les clés pour la page CdA (meta, titres, paragraphes, tableau, items)

### 7. `src/locales/en.json` — MODIFIÉ

**Ajout** des mêmes ~50 clés en anglais.

### 8. `src/layouts/Layout.astro` — MODIFIÉ

**Ajout** du label "cda" dans les breadcrumb labels pour FR ("CdA en cyclisme") et EN ("CdA in cycling").

---

## Fichiers NON modifiés (et pourquoi)

| Fichier | Raison |
|---------|--------|
| FAQ components (`ItemGridFAQ.astro`, `FAQs.astro`) | Déjà en `<details>/<summary>` natif HTML — contenu visible par les crawlers |
| Schemas JSON-LD homepage | Déjà complets (FAQPage, Organization, WebSite, SoftwareApplication ×2, VideoObject) |
| `navigation.ts` | Pas de modification de la structure de navigation (contrainte) |
| CSS / Design | Aucune modification visuelle (contrainte) |
| `astro.config.ts` | Aucun changement nécessaire |

---

## Recommandations futures (hors scope)

1. **Wikipedia** : Créer une page Wikipedia pour AeroX ou Olivier Demichel (impact fort sur les citations ChatGPT)
2. **Reddit** : Poster sur r/cycling, r/triathlon, r/Velo avec mention d'AeroX (2e source de citations Perplexity)
3. **YouTube** : Les mentions YouTube sont le signal #1 de corrélation avec la visibilité AI (étude Ahrefs)
4. **Blog CdA** : Créer un article blog approfondi complémentaire à la page /cda/ avec des cas pratiques et données originales
5. **Hreflang CdA** : La nouvelle page /fr/cda/ et /en/cda/ bénéficie déjà du hreflang automatique du Layout
