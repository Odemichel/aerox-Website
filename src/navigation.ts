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
          text: 'Contact',
          href: getPermalink('/#contact'),
        },
       
      ],
    },
   
  ],
  actions: [{variant:'primary', text: `
      <span class="md:hidden">Télécharger</span>
      <span class="hidden md:inline">Je&nbsp;teste&nbsp;AeroX</span>
    `, icon:'tabler:download', href: LINKS.download, target: '_blank',    subtext: "Réservé aux pionniers AeroX",
}],
    
};

export const footerData = {
  links: [
    {
      title: 'Produit',
      links: [
        { text: 'Fonctionnalités', href: '#features' },
        { text: 'Témoignages', href: '#utilisateurs' },
        { text: 'Abonnements', href: '#pricing' },
      ],
    },
   
    {
      title: 'Contact',
      links: [
        { text: 'Équipe', href: '#' },
        { text: 'Contactez-nous', href: '#' },

      ],
    },
    
  ],
  secondaryLinks: [
    { text: 'Privacy Policy', href: getPermalink('/privacy') },
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
