import { defineConfig } from 'astro/config';
import { execFileSync } from 'child_process';
import fs from 'fs';
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

// Sous /{lang}/blog/, seuls les articles (un fichier dans src/data/post) et la
// pagination vont au sitemap. Les pages de tags ont la même forme d'URL
// (/{lang}/blog/{tag}/) mais sont en noindex : les y laisser enverrait à Google
// deux signaux contradictoires.
const postSlugs = new Set(
  // Les URL des articles sont en minuscules (BF-mesurer-fr → /blog/bf-mesurer-fr/).
  fs.readdirSync(path.resolve(__dirname, 'src/data/post')).map((f) => f.replace(/\.mdx?$/, '').toLowerCase())
);
// lastmod du sitemap. Articles : updateDate (ou publishDate) de l'en-tête.
// Listes du blog : l'article le plus récent de la langue. Autres pages : date
// du dernier commit du fichier source. Date introuvable : pas de lastmod.
const postDir = path.resolve(__dirname, 'src/data/post');
const postDates = new Map<string, { lang: string; date: string }>();
for (const file of fs.readdirSync(postDir)) {
  const head = fs.readFileSync(path.join(postDir, file), 'utf8').split('---')[1] ?? '';
  const date = (head.match(/^updateDate:\s*(\S+)/m) ?? head.match(/^publishDate:\s*(\S+)/m))?.[1];
  const lang = head.match(/^lang:\s*['"]?([a-z]{2})/m)?.[1];
  if (date && lang)
    postDates.set(file.replace(/\.mdx?$/, '').toLowerCase(), { lang, date: new Date(date).toISOString() });
}
const latestPostDate = (lang: string) =>
  [...postDates.values()]
    .filter((p) => p.lang === lang)
    .map((p) => p.date)
    .sort()
    .pop();
const gitDate = (file: string) => {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { cwd: __dirname }).toString().trim();
    return out ? new Date(out).toISOString() : undefined;
  } catch {
    return undefined;
  }
};
const pageLastmod = (url: string): string | undefined => {
  const { pathname } = new URL(url);
  const [lang, ...rest] = pathname.split('/').filter(Boolean);
  if (!lang) return undefined;
  if (rest[0] === 'blog') {
    if (rest[1] && !/^\d+$/.test(rest[1])) return postDates.get(rest[1])?.date;
    return latestPostDate(lang);
  }
  const route = rest.join('/');
  const candidates = route
    ? [`src/pages/[lang]/${route}.astro`, `src/pages/[lang]/${route}/index.astro`, `src/pages/${lang}/${route}.md`]
    : ['src/pages/[lang]/index.astro'];
  const file = candidates.find((f) => fs.existsSync(path.resolve(__dirname, f)));
  return file ? gitDate(file) : undefined;
};

const isIndexableBlogPath = (page: string) => {
  const m = new URL(page).pathname.match(/^\/[a-z]{2}\/blog\/([^/]+)\/$/);
  return !m || /^\d+$/.test(m[1]) || postSlugs.has(m[1]);
};

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
      prefixDefaultLocale: true, // URLs avec /en/, /fr/, etc.
      redirectToDefaultLocale: false, // Pas de redirection auto, géré par middleware
    },
  },

  integrations: [
    react(),
    tailwind({ applyBaseStyles: false }),
    sitemap({
      serialize: (item) => {
        const lastmod = pageLastmod(item.url);
        return lastmod ? { ...item, lastmod } : item;
      },
      filter: (page) =>
        isIndexableBlogPath(page) &&
        !/\/(homes|landing)\//.test(page) &&
        !/\/blog\/(tag|category)\//.test(page) &&
        !/\/inscription\/(connexion|confirmation|dashboard)\//.test(page) &&
        !/\/telechargement\/(cancel|success)/.test(page) &&
        !/\/paiement\//.test(page) &&
        !/\/bike-fitting\/bienvenue\//.test(page) &&
        !/\/404/.test(page) &&
        !/\/tri-dijon\//.test(page) &&
        !/\/method\/inscription_ML\//.test(page) &&
        !/\/periode-test\//.test(page),
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
