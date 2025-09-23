import type { HeaderProps } from './components/widgets/Header.astro';
import { LINKS } from './config/links';
import { getPermalink } from './utils/permalinks';

export const headerData = {
  links: [
    {
      text: '',
      links: [
        {
          text: 'Accueil',
          href: getPermalink('/#Accueil'),
        },
        {
          text: 'Fonctionnalités',
          href: getPermalink('/#features'),
        },
        {
          text: 'Pourquoi AeroX ?',
          href: getPermalink('/#pourquoi'),
        },
        {
          text: 'Abonnements',
          href: getPermalink('/#pricing'),
        },
        {
          text: 'FAQs',
          href: getPermalink('/#FAQs'),
        },
       
        {
          text: "L'histoire d'Aerox",
          href: getPermalink('/team'),
        },
         {
          text: 'Contact',
          href:  LINKS.contact,
        },
         {
          text: "Nos Articles",
  href: '/blog',
        },

 {
          text: "Connexion",
  href: '/inscription/connexion',
        },
      ],
    },

  ],
  actions: [{
    variant: 'primary', text: `
      <span class="md:hidden">Télécharger</span>
      <span class="hidden md:inline">Je&nbsp;teste&nbsp;AeroX</span>
    `, icon: 'tabler:download', href: '/#pricing',
    target: '', subtext: "Réservé aux pionniers AeroX",
  }],

} satisfies HeaderProps;

export const footerData = {
  links: [
    /* {
      title: 'Produit',
      links: [
        { text: 'Fonctionnalités', href: '#features' },
        { text: 'Témoignages', href: '#utilisateurs' },
        { text: 'Abonnements', href: '#pricing' },
      ],
    }, */

    {
      title: 'Contact',
      links: [
        { text: 'Équipe', href: '/team' },
        { text: 'Contactez-nous', href: LINKS.contact },

      ],
    },

  ],
  secondaryLinks: [
    { text: 'Règles de Confidentialité', href: getPermalink('/privacy') },
    { text: 'CGV', href: getPermalink('/terms')
    },

  ],
  /* socialLinks: [
    { ariaLabel: 'X', icon: 'tabler:brand-x', href: '#' },
    { ariaLabel: 'Instagram', icon: 'tabler:brand-instagram', href: '#' },
    { ariaLabel: 'Facebook', icon: 'tabler:brand-facebook', href: '#' },
  ], */
  footNote: `
    Made by  O. Demichel</a> · All rights reserved.
  `,
};
