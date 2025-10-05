// src/utils/og.ts
import type { ImageMetadata } from 'astro';
import type { MetaData, MetaDataImage } from '~/types';

/**
 * Normalise md.openGraph.images vers [{ url, width?, height? }]
 * Accepte au départ: string | {url} | {src} | ImageMetadata.
 */

// Types d’images possibles en frontmatter
type FrontmatterOgImage =
  | string
  | { url: string; width?: number; height?: number }
  | { src: string; width?: number; height?: number }
  | ImageMetadata;

function isImageMetadata(x: unknown): x is ImageMetadata {
  return typeof x === 'object' && x !== null && 'src' in x && typeof (x as { src: unknown }).src === 'string';
}

function isUrlObject(x: unknown): x is { url: string; width?: number; height?: number } {
  return typeof x === 'object' && x !== null && 'url' in x && typeof (x as { url: unknown }).url === 'string';
}

function isSrcObject(x: unknown): x is { src: string; width?: number; height?: number } {
  return typeof x === 'object' && x !== null && 'src' in x && typeof (x as { src: unknown }).src === 'string';
}

function toMetaDataImage(img: FrontmatterOgImage): MetaDataImage | null {
  if (typeof img === 'string') return { url: img };
  if (isUrlObject(img)) {
    const out: MetaDataImage = { url: img.url };
    if (typeof img.width === 'number') out.width = img.width;
    if (typeof img.height === 'number') out.height = img.height;
    return out;
  }
  if (isImageMetadata(img)) return { url: img.src, width: img.width, height: img.height };
  if (isSrcObject(img)) {
    const out: MetaDataImage = { url: img.src };
    if (typeof img.width === 'number') out.width = img.width;
    if (typeof img.height === 'number') out.height = img.height;
    return out;
  }
  return null;
}

/** Normalise md.openGraph.images vers [{ url, width?, height? }] */
export function sanitizeMetaData(md: unknown): MetaData | undefined {
  if (typeof md !== 'object' || md === null) return undefined;

  // on clone superficialement pour ne pas muter la source
  const src = md as Record<string, unknown>;
  const openGraph = (src.openGraph ?? {}) as Record<string, unknown>;

  const rawImages = openGraph.images as unknown;
  let images: MetaDataImage[] | undefined;

  if (Array.isArray(rawImages)) {
    const parsed = rawImages
      .map((x) => toMetaDataImage(x as FrontmatterOgImage))
      .filter((x): x is MetaDataImage => x !== null);

    if (parsed.length > 0) images = parsed;
  }

  const normalized: MetaData = {
    ...(src as MetaData),
    openGraph: {
      ...(openGraph as MetaData['openGraph']),
      ...(images ? { images } : {}),
    },
  };

  return normalized;
}