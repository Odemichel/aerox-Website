// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="vite/client" />
/// <reference types="../vendor/integration/types.d.ts" />
/// <reference types="astro/client" />

// Déclare le type pour App.Locals (évite "La propriété 'lang' n'existe pas")
declare namespace App {
  type Locale = 'fr' | 'en';
  interface Locals {
    lang: Locale;
  }
}

// (Optionnel mais pratique) — type des JSON d'i18n
declare module '*.json' {
  const value: Record<string, string>;
  export default value;
}
