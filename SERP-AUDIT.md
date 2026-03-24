# Audit SERP Features — AeroX

Date : 2026-02-28

---

## Présence actuelle d'AeroX dans les SERPs

| Requête | AeroX visible ? | Position estimée | Feature SERP |
|---------|----------------|-----------------|--------------|
| "aérodynamisme vélo indoor" | Oui (page EN) | ~1-2 | Aucune feature captée |
| "CdA vélo" / "surface frontale" | Non | Absent | Snippets académiques |
| "position aérodynamique vélo" | Non | Absent | PAA + snippets concurrents |
| "entraînement aérodynamique cyclisme" | Non | Absent | PAA |
| "aerodynamics indoor cycling" | Non | Absent | Snippets (aero-coach, notio) |
| "aero position bike" | Non | Absent | Snippets + carrousel articles |
| "cycling aero apps indoor" | Non | Absent | Listicles (Zwift, TrainerRoad...) |

**Constat : AeroX est quasi invisible hors requête brandée.**

---

## Concurrents identifiés dans les SERPs

| Concurrent | Positionnement | Pays | URL |
|-----------|---------------|------|-----|
| AiRO | Bike fit aéro par IA/CFD | UK | https://www.bicycleretailer.com/announcements/2025/08/18/airo-launches-world%E2%80%99s-first-ai-powered-cfd-modelled-aero-bike-fit-platform |
| Notio | Capteur CdA terrain | CA | https://notio.ai/ |
| Body Rocket | Capteur drag live | UK | https://www.bikeradar.com/features/tech/body-rocket-aero-sensor-first-ride |
| AeroCoach | Coaching + vélodrome | UK | https://www.aero-coach.co.uk/ |
| AerOptimum | Optimisation aéro vélo | FR | https://aeroptimum.fr/ |
| MyWindsock | CdA via Strava (gratuit) | UK | https://mywindsock.com/ |

---

## Formulations qui rankent

### FR — Titles/H1 en positions 1-5

| Site | Title/H1 | Requête |
|------|---------|---------|
| combinaisontriathlon.fr | "Position aéro vélo : optimiser la posture pour plus de vitesse et de confort" | position aérodynamique vélo |
| opentri.fr | "9 astuces pour être plus aérodynamique sur votre vélo" | aérodynamique vélo |
| danslateteduncycliste.com | "Comment exploser ses chronos grâce à l'aérodynamisme" | aérodynamisme vélo |
| lexpertvelo.com | "Mesurer la résistance aux frottements sans soufflerie" | CdA vélo mesurer |
| sci-sport.com | "Méthode de terrain pour évaluer l'aire frontale projetée d'un cycliste" | surface frontale cyclisme |
| grandestcyclisme.fr | "Aérodynamique contre poids sur le plat : pourquoi 90 % des cyclistes se trompent de priorité" | aérodynamique cyclisme |

### EN — Titles/H1 en positions 1-5

| Site | Title/H1 | Requête |
|------|---------|---------|
| road.cc | "Aero bike vs aero position — why spending thousands might be slower" | aero position bike |
| cyclingweekly.com | "Aerodynamic testing: what are your options and how much does it cost?" | aerodynamic testing cycling |
| rule28.com | "A Guide to the Physics of Cycling Aerodynamics" | aerodynamics cycling |
| notio.ai | "What is CdA? And why is it important to measure it?" | CdA cycling |
| cyclingweekly.com | "Aero for everyone? I used an AI-based bike fit and saved dozens of watts" | aero bike fit AI |
| hiaerocycling.nl | "CdA explained in five sentences" | CdA explained cycling |

---

## Recommandations H1

### H1 Homepage

L'enjeu : inclure un mot-clé recherché tout en gardant l'identité de marque.

| | Option A | Option B | Option C |
|--|---------|---------|---------|
| **FR** | Optimise ta position aéro sur home trainer | Ta soufflerie virtuelle pour le vélo indoor | Mesure ton aérodynamisme sur home trainer |
| **EN** | Optimize your aero position on a smart trainer | Your virtual wind tunnel for indoor cycling | Measure your aerodynamics on a smart trainer |
| **Mot-clé visé** | "position aéro" + "home trainer" | "soufflerie" + "vélo indoor" | "aérodynamisme" + "home trainer" |
| **Intent** | Action/bénéfice | Métaphore produit | Action/technique |

Le **title tag** (meta) doit rester distinct du H1. Suggestion :
- FR : "AeroX — Analyse aérodynamique en temps réel sur home trainer"
- EN : "AeroX — Real-time aerodynamic analysis on your smart trainer"

### H1 Blog Index

| | Option A | Option B |
|--|---------|---------|
| **FR** | Aérodynamisme & Cyclisme : nos guides | Position aéro, CdA et gains : le blog AeroX |
| **EN** | Aerodynamics & Cycling: our guides | Aero position, CdA & speed gains: the AeroX blog |
| **Mot-clé** | "aérodynamisme cyclisme" | "position aéro" + "CdA" |

---

## SERP Features captables

| Feature | Requête cible | Action | Priorité |
|---------|--------------|--------|----------|
| Featured snippet (paragraphe) | "qu'est-ce que le CdA vélo" | Ajouter H2 + réponse 40-60 mots dans un article dédié | Haute |
| Featured snippet (liste) | "comment améliorer son aérodynamisme vélo" | Article listicle avec H2 matching | Haute |
| PAA | "comment mesurer sa surface frontale" | Section FAQ dans l'article méthode | Moyenne |
| Rich result Breadcrumb | Toutes pages | FAIT (schema BreadcrumbList) | — |
| Rich result Article | Articles blog | FAIT (schema BlogPosting) | — |
| Knowledge Panel | "AeroX cycling" | Schema Organization fait — besoin fiche Wikipedia à terme | Basse |

---

## Actions prioritaires — Roadmap SEO contenu

### Court terme (wording)

| # | Action | Fichier | Impact |
|---|--------|---------|--------|
| 1 | Choisir et implémenter H1 homepage (parmi options ci-dessus) | `src/locales/fr.json`, `en.json` — clés `home.hero.title.l1` + `.l2` | Élevé |
| 2 | Choisir et implémenter H1 blog index | `src/locales/fr.json`, `en.json` — clé `blog.title` | Élevé |
| 3 | Différencier title tag homepage du H1 | `src/locales/fr.json`, `en.json` — clé `home.meta.title` | Moyen |

### Moyen terme (contenu)

| # | Action | Impact |
|---|--------|--------|
| 4 | Créer article "Qu'est-ce que le CdA ?" (FR + EN) — snippet-bait | Élevé — featured snippet captable |
| 5 | Créer article listicle "X astuces pour améliorer son aéro sur home trainer" | Élevé — snippet liste |
| 6 | Ajouter section FAQ avec schema HowTo dans la page méthode | Moyen — PAA |
| 7 | Optimiser les title tags des articles existants (inclure mots-clés cibles) | Moyen |

### Long terme (autorité)

| # | Action | Impact |
|---|--------|--------|
| 8 | Obtenir des backlinks depuis sites cyclisme (opentri, sci-sport, triathlon-addict) | Élevé |
| 9 | Créer une page "AeroX vs Notio vs Body Rocket vs AiRO" (comparatif) | Élevé — snippet table |
| 10 | Fiche Wikipedia AeroX (Knowledge Panel Google) | Moyen |

---

## Sources

- [AiRO AI Bike Fit — Bicycle Retailer](https://www.bicycleretailer.com/announcements/2025/08/18/airo-launches-world%E2%80%99s-first-ai-powered-cfd-modelled-aero-bike-fit-platform)
- [Cycling Weekly — Aero Testing Options](https://www.cyclingweekly.com/products/aerodynamic-testing-what-are-your-options-and-how-much-does-it-cost)
- [Notio — What is CdA](https://notio.ai/blogs/blog/what-is-cda-and-why-is-it-important-as-a-cyclist-to-measure-it)
- [Road.cc — Aero Position vs Aero Bike](https://road.cc/content/feature/aero-bike-vs-aero-position-312555)
- [Sci-Sport — Surface frontale cyclisme](https://www.sci-sport.com/articles/Methode-de-terrain-pour-evaluer-l-aire-frontale-projetee-d-un-cycliste-003.php)
- [OpenTri — Astuces aéro vélo](https://www.opentri.fr/9-astuces-pour-etre-plus-aero-a-velo/)
- [AerOptimum](https://aeroptimum.fr/)
- [Rule 28 — Physics of Cycling Aerodynamics](https://www.rule28.com/blogs/thoughts/the-physics-of-cycling-aerodynamics-a-technical-guide)
- [Cycling Weekly — AI Bike Fit](https://www.cyclingweekly.com/fitness/bike-fit/aero-for-everyone-i-used-an-ai-based-bike-fit-and-saved-dozens-of-watts)
- [CdA Explained — HiAeroCycling](https://www.hiaerocycling.nl/cda-explained-in-five-sentences/)
