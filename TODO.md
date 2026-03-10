# TODO — AeroX Site

## Bike Fitting (`/fr/bike-fitting/`)

### Conversion (pour passer à 8.5+)
- [ ] Ajouter une **vidéo démo 60s** (ou GIF animé) montrant l'interface AeroX en séance de fitting
- [ ] **Varier les 3 CTA** : "Voir AeroX en action" (hero), "Demander une démo" (mid), "Commencer maintenant" (form)
- [ ] Ajouter un **CTA secondaire low-commitment** : "Télécharger le guide" ou "Voir la vidéo" pour les prospects early-stage
- [ ] Intégrer un **embed Calendly** dans la section contact pour réduire la friction
- [ ] Ajouter un élément d'**urgence/rareté** (places limitées, offre de lancement, deadline)
- [ ] Ajouter une **garantie visible** (essai gratuit, satisfait ou remboursé)
- [ ] Améliorer le **message post-form** : ajouter un next step ou lien calendrier

### Visibilité (pour passer à 8.5+)
- [ ] Créer un **cluster de 3-5 articles blog** autour du bike fitting (étude de cas, comparatif outils, guide aéro pour fitters)
- [ ] **Adapter le contenu EN** au marché US (mentionner Retül, Guru comme contexte concurrentiel)
- [ ] Ajouter un **HowTo schema** JSON-LD pour la section "3 étapes"
- [ ] Ajouter un **SoftwareApplication schema** dédié avec `offers`, `audience` (B2B)
- [ ] Renforcer le **maillage interne** : liens depuis `/method/`, `/team/` vers bike-fitting
- [ ] Obtenir des **photos/logos** des studios des 3 bike fitters pour les cards

### Design
- [ ] Ajouter une **vidéo** ou GIF dans la section Visual Proof ou Steps
- [ ] Ajouter des **photos des fitters** ou logos de leur studio dans les cards social proof

---

## Homepage (`/fr/`) — Score : Visibilité 7/10, Conversion 6.5/10

### SEO critique (impact élevé)
- [ ] **Réécrire le H1** avec keyword fort : ex. "Transforme ton home trainer en soufflerie virtuelle" ou "Gagne 3 km/h sur home trainer"
- [ ] **Raccourcir la meta description** à < 160 caractères (actuellement ~210)
- [ ] **Corriger le hero subtitle** : supprimer le keyword stuffing (~350 mots), garder 2 phrases max
- [ ] **Corriger la typo** "perofrmants" → "performants" dans `home.hero.subtitle` (fr.json)
- [ ] **Supprimer les doublons** : 2e `<Stats>` et 2e `<LogosCarousel>` en bas de page (contenu identique)
- [ ] **Ajouter `SoftwareApplication` schema** JSON-LD avec offers + aggregateRating
- [ ] **Vérifier/retirer le `SearchAction`** schema si le blog n'a pas de vraie recherche

### Dates & contenus obsolètes (urgence)
- [ ] **Mettre à jour le tagline** "En bêta le 1er septembre" → refléter le statut actuel
- [ ] **Mettre à jour les CTA pricing** "Lancement le 01/12/2025" → lien actif ou nouvelle date
- [ ] **Vérifier le countdown** : `COUNTDOWN_TARGET` est-il dans le futur ? Si non, retirer ou mettre à jour
- [ ] **Vérifier la cohérence des prix** : Pack Progression annoncé 190€/an dans le texte mais affiché 140€

### Conversion
- [ ] **Raccourcir la page** : fusionner Features + Features2, supprimer les 5 Notes intercalaires → viser ~10 sections
- [ ] **Ajouter un lead magnet** au-dessus du fold (capture email pour visiteurs non prêts à s'inscrire)
- [ ] **Varier les CTA** : tous pointent vers `/inscription/` → proposer des actions secondaires
- [ ] **Ajouter un lien vers `/bike-fitting/`** dans le contenu principal (pas seulement le nav)

### Maillage interne
- [ ] Lien depuis la homepage vers `/bike-fitting/` (dans la section Features ou Testimonials)
- [ ] Lien vers les articles de blog principaux depuis la homepage
