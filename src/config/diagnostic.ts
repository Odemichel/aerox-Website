// src/config/diagnostic.ts
//
// Livraison du Diagnostic AeroX. Avant cette date, un achat est une
// pré-réservation : la page de succès l'annonce et ne propose pas de
// téléchargement (la version de l'application qui ouvre le diagnostic n'est
// pas encore publiée). Les acheteurs reçoivent un email MailerLite 7 jours
// avant. À partir de cette date, la page annonce un diagnostic débloqué.
export const DIAGNOSTIC_AVAILABLE_AT = new Date('2026-11-01T00:00:00+01:00');

export const isDiagnosticAvailable = (now: Date = new Date()) => now >= DIAGNOSTIC_AVAILABLE_AT;
