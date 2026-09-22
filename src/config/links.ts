// src/config/links.ts
export const LINKS = {
  abonnement: '/abonnement',
  pricing: '/#pricing',
  success: '/telechargement/success',
  method: '/method/',

  contact: '/contact/',

  // Lien de réservation de créneau (agenda Google), affiché au succès du
  // formulaire de la période de test. Plage de rendez-vous créée à la main
  // dans Google Calendar (Créer → Plage de rendez-vous, compte
  // olivierdemichel@releve.club). Forme courte (calendar.app.google), stable
  // même si la configuration de la plage est modifiée derrière.
  booking: 'https://calendar.app.google/eNFuymZ8MWz9icFB8',

  // Même plage de rendez-vous, forme longue, pour l'affichage en iframe dans
  // la page. Les deux formes ne sont pas interchangeables : la forme courte
  // redirige vers `calendar.google.com/appointments/schedules/<id>`, qui
  // répond `X-Frame-Options: SAMEORIGIN` et refuse donc d'être encadrée.
  // Seule cette variante `/calendar/appointments/schedules/<id>?gv=true` —
  // le code d'intégration officiel de Google — est servie sans en-tête de
  // cadrage. `<id>` est identique dans les deux (vérifié en suivant la
  // redirection de la forme courte).
  bookingEmbed:
    'https://calendar.google.com/calendar/appointments/schedules/AcZssZ3npRElsjB7w8SguAimJYPGBe9m1C1MFwToiZsonJ44T_1jJn9_3Do5wN2hzf8rPPG5lIjEVSrD?gv=true',
};
