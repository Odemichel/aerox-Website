# TODO — AeroX Site

## Bike Fitting (`/fr/bike-fitting/`)

### Conversion (pour passer à 8.5+)
- [ ] Ajouter une **vidéo démo 60s** (ou GIF animé) montrant l'interface AeroX en séance de fitting
- [x] **Varier les 3 CTA** : "Voir AeroX en action" (hero), "Demander une démo" (mid), "Envoyer ma demande" (form)
- [ ] Ajouter un **CTA secondaire low-commitment** : "Télécharger le guide" ou "Voir la vidéo" pour les prospects early-stage
- [ ] Intégrer un **embed Calendly** dans la section contact pour réduire la friction
- [ ] Ajouter un élément d'**urgence/rareté** (places limitées, offre de lancement, deadline)
- [ ] Ajouter une **garantie visible** (essai gratuit, satisfait ou remboursé)
- [ ] Améliorer le **message post-form** : ajouter un next step ou lien calendrier

### Visibilité (pour passer à 8.5+)
- [ ] Créer un **cluster de 3-5 articles blog** autour du bike fitting (étude de cas, comparatif outils, guide aéro pour fitters)
- [ ] **Adapter le contenu EN** au marché US (mentionner Retül, Guru comme contexte concurrentiel)
- [ ] Ajouter un **HowTo schema** JSON-LD pour la section "3 étapes"
- [x] **SoftwareApplication schema** ajouté avec `audience: BusinessAudience`, `offers: PreOrder`
- [ ] Renforcer le **maillage interne** : liens depuis `/method/`, `/team/` vers bike-fitting
- [ ] Obtenir des **photos/logos** des studios des 3 bike fitters pour les cards

### Design
- [x] **Micro-animations** : fade-in au scroll (Intersection Observer) + hover lift sur cards social proof
- [x] **Icônes metrics** : remplacé les chiffres par des icônes SVG (chart, lightning, clock, trend)
- [x] **FAQ accent** : bordure primary + texte primary sur les détails ouverts
- [ ] Ajouter une **vidéo** ou GIF dans la section Visual Proof ou Steps
- [ ] Ajouter des **photos des fitters** ou logos de leur studio dans les cards social proof

---

### Visibilité — corrigé
- [x] **Hreflang** : articles mono-langue (aerox-innovation-fr, feel-aero-en) n'émettent plus de hreflang fantôme vers des 404
- [x] **VideoObject schema** ajouté sur la homepage pour la hero video
- [x] **Review/AggregateRating schema** ajouté sur la homepage (4 testimonials, 4.8/5)

---

## Homepage (`/fr/`) — Score : Visibilité 7.5/10, Conversion 7/10

### SEO critique (impact élevé) — FAIT
- [x] **H1 réécrit** : "Ton home trainer / devient une soufflerie virtuelle"
- [x] **Meta description** raccourcie à 155 car.
- [x] **Hero subtitle** réduit à 2 phrases (supprimé keyword stuffing)
- [x] **Typo corrigée** "perofrmants" (supprimé avec le nouveau subtitle)
- [x] **Doublons supprimés** : 2e Stats + 2e LogosCarousel retirés
- [x] **SoftwareApplication schema** ajouté (SportsApplication, macOS/Windows, 20€ PreOrder)
- [x] **SearchAction retiré** du schema WebSite

### Dates & contenus obsolètes — FAIT
- [x] **Tagline** → "Lancement le 10 avril"
- [x] **Section pricing masquée** temporairement (à réactiver après le 10 avril)
- [x] **Countdown** → cible 2026-04-10
- [ ] **Cohérence des prix** : à harmoniser lors de la réactivation du pricing (140€ vs 190€, 15€ vs 22€)

### Conversion
- [ ] **Raccourcir la page** : fusionner Features + Features2, supprimer les 5 Notes intercalaires → viser ~10 sections
- [x] **Lead magnet ajouté** : capture email après le hero ("Sois le premier informé du lancement") via MailerLite
- [ ] **Varier les CTA** : tous pointent vers `/inscription/` → proposer des actions secondaires
- [x] **Lien vers `/bike-fitting/`** ajouté dans la section "Explore AeroX"

### Maillage interne — FAIT
- [x] Section "Explore AeroX" avec 4 cards : bike-fitting (mise en avant) + 3 articles blog (zwift, aero-gain, feel-aero)
- [x] Liens homepage → articles blog principaux (zwift, aero-gain-chronometrique, feel-aero)
