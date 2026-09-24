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

/** Public visé par la page : il choisit le bouton d'action du header. */
export type Audience = 'rider' | 'bike-fitter';

export function makeNavigation(langInput?: string, audience: Audience = 'rider') {
  const lang: Locale = isLocale(langInput) ? langInput : DEFAULT_LOCALE;

  const dict = getDict(lang);
  const t = (k: string) => dict[k] ?? k;

  const headerData: HeaderProps = {
    links: [
      {
        text: '',
        links: [
          // Home
          {
            text: t('nav.home'), href: withLang(lang, getPermalink('/')), icon: "tabler:home"
          }, // => "/fr/"
          {
            text: t('nav.pricing'), href: withLang(lang, '#pricing'), icon: "tabler:currency-dollar"

          },        // => "/fr/#pricing"
          {
            text: t('nav.book'), href: withLang(lang, '/method/'), icon: "tabler:bolt"
          },        // => "/fr/#pricing"
          {
            text: t('nav.blog'), href: withLang(lang, getPermalink('/blog/')), icon: "tabler:article"
          },
          {
            text: t('nav.bikeFitting'), href: withLang(lang, '/bike-fitting/'), icon: "tabler:bike"
          },
          {
            text: t('nav.contact'), href: withLang(lang, getPermalink('/contact/')), icon: "tabler:mail"
          },
          {
            text: t('nav.login'), href: withLang(lang, getPermalink('/inscription/connexion/')), icon: "tabler:user"
          },
          /*  { text: t('nav.why'), href: withLang(lang, '#pourquoi') },       // => "/fr/#pourquoi"
               { text: t('nav.faq'), href: withLang(lang, '#FAQs') },           // => "/fr/#FAQs"
              { text: t('nav.story'), href: withLang(lang, getPermalink('/team/')) },    
             */
        ],
      },
    ],
    actions: [
      audience === 'bike-fitter'
        ? {
            variant: 'primary',
            text: t('lead.form.intent.demo'),
            icon: 'tabler:calendar-event',
            href: withLang(lang, '/periode-test/#reservation'),
            target: '',
          }
        : {
            variant: 'primary',
            // Libellé court sur mobile : la réduction est portée par le
            // bandeau au-dessus, le bouton complet débordait de l'écran.
            text: `<span class="sm:hidden">${t('cta.preorder.short')}</span><span class="hidden sm:inline">${t('cta.preorder.text')}</span>`,
            icon: 'tabler:discount-2',
            href: withLang(lang, '#pricing'),
            target: '',
            subtext: t('cta.preorder.subtext'),
            subtextClass: 'hidden sm:block',
          },
    ],
  };

  const footerData = {
    links: [
      {
        title: t('footer.contact.title'),
        links: [
          { text: t('footer.team'), href: withLang(lang, '/team') },
          { text: t('footer.story'), href: withLang(lang, '/team') },

          { text: t('footer.contactUs'), href: withLang(lang, '/contact') },
          { text: t('footer.bikeFitting'), href: withLang(lang, '/bike-fitting') },
          { text: t('footer.cda'), href: withLang(lang, '/cda') },
        ],
      },
    ],
    secondaryLinks: [
      {
        text: t('footer.privacy'),
        href: withLang(lang, '/privacy'),
      },
      {
        text: t('footer.terms'),
        href: withLang(lang, '/terms'),
      },
    ],
    socialLinks: [], // requis par Props de Footer.astro
    footNote: t('footer.footnote'),
  };

  return { headerData, footerData };
}
