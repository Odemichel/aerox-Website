import type { ImageMetadata } from 'astro';

import aeroxVsZwift from '~/assets/images/blog/aerox-vs-zwift.png';
import PogacatVsEvenPoel from '~/assets/images/blog/Amstel-Pog_vs_EvenP.png';
import GainChronoAeroEn from '~/assets/images/blog/gain-chrono-aero-en.png';
import GainChronoAeroFr from '~/assets/images/blog/gain-chrono-aero-fr.png';
// Ajoute ici toutes les autres images

export const blogImages: Record<string, ImageMetadata> = {
  'aerox-vs-zwift': aeroxVsZwift,
  'Pog_EvenP': PogacatVsEvenPoel,
  "gain-chrono-aero-en": GainChronoAeroEn,
  "gain-chrono-aero-fr": GainChronoAeroFr
  // etc.
};
