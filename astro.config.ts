import { defineConfig } from 'astro/config';
import path from 'path';
import { fileURLToPath } from 'url';

import mdx from '@astrojs/mdx';
import partytown from '@astrojs/partytown';
import sitemap from '@astrojs/sitemap';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';
import type { AstroIntegration } from 'astro';
import compress from 'astro-compress';
import { default as astroIcon, default as icon } from 'astro-icon';
import astrowind from './vendor/integration';

import react from '@astrojs/react';
import { lazyImagesRehypePlugin, readingTimeRemarkPlugin, responsiveTablesRehypePlugin } from './src/utils/frontmatter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hasExternalScripts = false;
const whenExternalScripts = (items: (() => AstroIntegration) | (() => AstroIntegration)[] = []) =>
  hasExternalScripts ? (Array.isArray(items) ? items.map((item) => item()) : [items()]) : [];

export default defineConfig({
  site: 'https://aeroxbefaster.com',
  trailingSlash: 'always',
  output: 'server',
  // `imageService` était absent : sans lui l'adaptateur ne déclare aucun service
  // d'images, et l'endpoint `/_image` répond 404 en production. Les pages
  // prérendues n'en souffrent pas (leurs images sont transformées au build),
  // mais toutes les pages rendues à la demande — connexion, inscription —
  // affichaient des images cassées, logo compris. Les listes `domains` et
  // `remotePatterns` sont reprises automatiquement du bloc `image` ci-dessous.
  adapter: vercel({ imageService: true }),

  // Offre Pionnier retirée (plus commercialisée) : les deux pages sont
  // supprimées, on redirige vers la section tarifs de la home. Motif à
  // paramètre (`/[lang]/paiement`) testé et écarté : le placeholder n'est
  // pas substitué dans l'URL de destination générée (Location littérale
  // `/[lang]/#pricing`) — routes déclarées explicitement pour les 9 langues.
  // Sources avec `/` final : `trailingSlash: 'always'` ne réécrit pas les
  // clés de `redirects`, une source sans slash ne matche pas les requêtes
  // réelles (`/fr/paiement/`) et retombe sur le rendu SSR de la page
  // supprimée au lieu de rediriger.
  redirects: {
    '/fr/paiement/': '/fr/#pricing',
    '/en/paiement/': '/en/#pricing',
    '/pt/paiement/': '/pt/#pricing',
    '/es/paiement/': '/es/#pricing',
    '/it/paiement/': '/it/#pricing',
    '/de/paiement/': '/de/#pricing',
    '/nl/paiement/': '/nl/#pricing',
    '/ja/paiement/': '/ja/#pricing',
    '/tr/paiement/': '/tr/#pricing',
    '/fr/telechargement/DeviensPionnier/': '/fr/#pricing',
    '/en/telechargement/DeviensPionnier/': '/en/#pricing',
    '/pt/telechargement/DeviensPionnier/': '/pt/#pricing',
    '/es/telechargement/DeviensPionnier/': '/es/#pricing',
    '/it/telechargement/DeviensPionnier/': '/it/#pricing',
    '/de/telechargement/DeviensPionnier/': '/de/#pricing',
    '/nl/telechargement/DeviensPionnier/': '/nl/#pricing',
    '/ja/telechargement/DeviensPionnier/': '/ja/#pricing',
    '/tr/telechargement/DeviensPionnier/': '/tr/#pricing',
  },

  /** 🌍 Ajout du bloc i18n */
  i18n: {
    defaultLocale: 'en',
    locales: ['fr', 'en', 'pt', 'es', 'it', 'de', 'nl', 'ja', 'tr'],
    routing: {
      prefixDefaultLocale: true,       // URLs avec /en/, /fr/, etc.
      redirectToDefaultLocale: false,  // Pas de redirection auto, géré par middleware
    },
  },

  integrations: [react(),
    tailwind({ applyBaseStyles: false }),
    sitemap({
      filter: (page) =>
        !/\/(homes|landing)\//.test(page) &&
        !/\/blog\/(tag|category)\//.test(page) &&
        !/\/inscription\/(connexion|confirmation|dashboard)\//.test(page) &&
        !/\/telechargement\/(cancel|success)/.test(page) &&
        !/\/paiement\//.test(page) &&
        !/\/404/.test(page) &&
        !/\/tri-dijon\//.test(page),
    }),
    mdx(),
    astroIcon({
      include: { 'circle-flags': ['fr', 'gb'] },
    }),
    icon({
      include: {
        tabler: ['*'],
        'flat-color-icons': [
          'template',
          'gallery',
          'approval',
          'document',
          'advertising',
          'currency-exchange',
          'voice-presentation',
          'business-contact',
          'database',
          'bullish',
          'charge-battery',
          'combo-chart',
          'flash-on',
          'picture',
          'edit-image',
          'clock',
          'globe',
          'decision',
          'expired',
          'services',
          'support',
          'ok',
          'debt',
          'manager',
          'idea',
        ],
        'fluent-emoji-flat': ['stopwatch', 'light-bulb', 'globe-showing-europe-africa'],
        'emojione-v1': ['person-biking'],
        emojione: ['rocket'],
        twemoji: ['person-biking-medium-skin-tone', 'woman-biking-medium-dark-skin-tone'],
      },
    }),
    ...whenExternalScripts(() =>
      partytown({
        config: { forward: ['dataLayer.push'] },
      })
    ),
    compress({
      CSS: true,
      HTML: { 'html-minifier-terser': { removeAttributeQuotes: false } },
      Image: false,
      JavaScript: true,
      SVG: false,
      Logger: 1,
    }),
    astrowind({ config: './src/config.yaml' }),
  ],

  image: {
    domains: ['cdn.pixabay.com'],
  },

  markdown: {
    remarkPlugins: [readingTimeRemarkPlugin],
    rehypePlugins: [responsiveTablesRehypePlugin, lazyImagesRehypePlugin],
  },

  vite: {
    resolve: {
      alias: {
        '~': path.resolve(__dirname, './src'),
      },
    },
  },
});
