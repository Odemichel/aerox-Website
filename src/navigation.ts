// src/navigation.ts
import type { HeaderProps } from './components/widgets/Header.astro';
import { DEFAULT_LOCALE, getDict, SUPPORTED_LOCALES, type Locale } from './lib/i18n';
import { getPermalink } from './utils/permalinks';

const isLocale = (v: unknown): v is Locale =>
  typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v);

// Trailing slash helper (compatible trailingSlash: 'always')
const ensureTrailingSlash = (p: string) =>
  !p ? p : (p.endsWith('/') || p.includes('.')) ? p : p + '/';

// Préfixe /{lang} et gère correctement les ancres (#...) vers la HOME
const withLang = (lang: Locale, href: string) => {
  if (!href) return href;

  // 🔗 Cas des ancres: on veut /{lang}/#id (ancre sur la home)
  if (href.startsWith('#')) {
    return `/${lang}/` + href; // ex: "/fr/#pricing"
  }

  // Autres liens
  const path = href.startsWith('/') ? href : `/${href}`;
  const prefixed = `/${lang}${path}`.replace(/\/{2,}/g, '/');
  return ensureTrailingSlash(prefixed);
};

export function makeNavigation(langInput?: string) {
  const lang: Locale = isLocale(langInput) ? langInput : DEFAULT_LOCALE;

  const dict = getDict(lang);
  const t = (k: string) => dict[k] ?? k;

  const headerData: HeaderProps = {
    links: [
      {
        text: '',
        links: [
          // Home
          { text: t('nav.home'), href: withLang(lang, getPermalink('/')) }, // => "/fr/"
          // Ancres -> home + #id
          { text: t('nav.features'), href: withLang(lang, '#features') },       // => "/fr/#features"
          { text: t('nav.why'), href: withLang(lang, '#pourquoi') },       // => "/fr/#pourquoi"
          { text: t('nav.pricing'), href: withLang(lang, '#pricing') },        // => "/fr/#pricing"
          { text: t('nav.faq'), href: withLang(lang, '#FAQs') },           // => "/fr/#FAQs"
          // Pages
          { text: t('nav.story'), href: withLang(lang, getPermalink('/team/')) },
          { text: t('nav.contact'), href: withLang(lang, getPermalink('/contact/')) },
          { text: t('nav.blog'), href: withLang(lang, getPermalink('/blog/')) },
          { text: t('nav.login'), href: withLang(lang, getPermalink('/inscription/connexion/')) },
        ],
      },
    ],
    actions: [
      {
        variant: 'primary',
        text: `
          <span class="md:hidden">${t('nav.cta.mobile')}</span>
          <span class="hidden md:inline">${t('nav.cta.desktop')}</span>
        `,
        icon: 'tabler:download',
        href: withLang(lang, '/inscription/inscription/'), // => "/{lang}/#pricing"
        target: '',
        subtext: t('nav.cta.subtext'),
      },
    ],
  };

  const footerData = {
    links: [
      {
        title: t('footer.contact.title'),
        links: [
          { text: t('footer.team'), href: withLang(lang, '/team') },
          { text: t('footer.contactUs'), href: withLang(lang, '/contact') }, // i18n si nécessaire
        ],
      },
    ],
    secondaryLinks: [
      {
        text: t('footer.privacy'),
        href: withLang(lang, '/privacy'),
      },
      { text: t('footer.terms'), 
        href:withLang(lang, '/terms'),
},
    ],
    socialLinks: [], // requis par Props de Footer.astro
    footNote: t('footer.footnote'),
  };

  return { headerData, footerData };
}
