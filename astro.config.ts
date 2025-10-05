import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'astro/config';

import mdx from '@astrojs/mdx';
import partytown from '@astrojs/partytown';
import sitemap from '@astrojs/sitemap';
import tailwind from '@astrojs/tailwind';
import type { AstroIntegration } from 'astro';
import compress from 'astro-compress';
import { default as astroIcon, default as icon } from 'astro-icon';



import astrowind from './vendor/integration';

import { lazyImagesRehypePlugin, readingTimeRemarkPlugin, responsiveTablesRehypePlugin } from './src/utils/frontmatter';

import vercel from "@astrojs/vercel"; // ou netlify si tu déploies là-bas



const __dirname = path.dirname(fileURLToPath(import.meta.url));

const hasExternalScripts = false;
const whenExternalScripts = (items: (() => AstroIntegration) | (() => AstroIntegration)[] = []) =>
  hasExternalScripts ? (Array.isArray(items) ? items.map((item) => item()) : [items()]) : [];

export default defineConfig({
  site: "https://aeroxbefaster.com",   // ⚡ ton vrai domaine en prod
  trailingSlash: 'always',              // ou "always" si tu préfères /fr/
  output: 'server',
  adapter: vercel({}),

  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
    sitemap(),
    mdx(),
     astroIcon({
      // ajoute la collection et les icônes que tu utilises
      include: {
        'circle-flags': ['fr', 'gb'], // fr = France, gb = Royaume-Uni
      },
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
          'idea'
        ],
        'fluent-emoji-flat': [
          'stopwatch',
          'light-bulb'

        ],
        'emojione-v1': [
          'person-biking'
        ],
        'emojione': ['rocket'],
        'twemoji': [
          'person-biking-medium-skin-tone',
          'woman-biking-medium-dark-skin-tone'
        ]
      },
    }),


    ...whenExternalScripts(() =>
      partytown({
        config: { forward: ['dataLayer.push'] },
      })
    ),

    compress({
      CSS: true,
      HTML: {
        'html-minifier-terser': {
          removeAttributeQuotes: false,
        },
      },
      Image: false,
      JavaScript: true,
      SVG: false,
      Logger: 1,
    }),

    astrowind({
      config: './src/config.yaml',
    }),
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
