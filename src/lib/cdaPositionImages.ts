// Vues de face des 6 positions de /cda (illustration générée, recadrée au plus
// près du cycliste et recolorée en orange AeroX).
// Fichiers : src/assets/images/cda/positions/face-{n}-orange.webp
import type { ImageMetadata } from 'astro';

const files = import.meta.glob<{ default: ImageMetadata }>('~/assets/images/cda/positions/*.webp', { eager: true });

export function positionImage(n: number): ImageMetadata {
  const entry = Object.entries(files).find(([path]) => path.endsWith(`/face-${n}-orange.webp`));
  if (!entry) throw new Error(`Illustration manquante : face-${n}-orange.webp`);
  return entry[1].default;
}
