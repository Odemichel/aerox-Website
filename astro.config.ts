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
  adapter: vercel({}),

  /** 🌍 Ajout du bloc i18n */
  i18n: {
    defaultLocale: 'fr',
    locales: ['fr', 'en'],
    routing: {
      prefixDefaultLocale: true,       // ✅ URLs avec /fr/
      redirectToDefaultLocale: true,   // ✅ Redirige / vers /fr/
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
        !/\/404/.test(page),
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
