import type { GetStaticPaths, PaginateFunction } from 'astro';
import type { CollectionEntry } from 'astro:content';
import { getCollection, render } from 'astro:content';
import { APP_BLOG } from 'astrowind:config';
import type { Post } from '~/types';
import { BLOG_BASE, CATEGORY_BASE, cleanSlug, POST_PERMALINK_PATTERN, trimSlash } from './permalinks';
// (optionnel, recommandé) : si tu as ajouté le sanitizer
// import { sanitizeMetaData } from '~/utils/og';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

// slug robuste depuis le nom de fichier (id ou filePath)
const fileSlug = (entry: { id: string; filePath?: string }) =>
  (entry.filePath ?? entry.id).split('/').pop()!.replace(/\.mdx?$/i, '');

// construit "/{lang}/{blogBase}/{pattern...}" proprement
const withLangPrefix = (lang: 'fr' | 'en', path: string) => {
  const clean = trimSlash(path); // ex: "blog/zwift" ou "zwift"
  return clean ? `/${lang}/${clean}/` : `/${lang}/`;
};
/**
 * Si tu tiens à POST_PERMALINK_PATTERN (ex: "%slug%"), on l'applique
 * puis on préfixe de "{lang}/BLOG_BASE".
 */
const generatePermalink = ({
  id,
  slug,
  publishDate,
  category,
  lang,
}: {
  id: string;
  slug: string;
  publishDate: Date;
  category: string | undefined;
  lang: 'fr' | 'en';
}) => {
  const year = String(publishDate.getFullYear()).padStart(4, '0');
  const month = String(publishDate.getMonth() + 1).padStart(2, '0');
  const day = String(publishDate.getDate()).padStart(2, '0');
  const hour = String(publishDate.getHours()).padStart(2, '0');
  const minute = String(publishDate.getMinutes()).padStart(2, '0');
  const second = String(publishDate.getSeconds()).padStart(2, '0');

  const pattern = POST_PERMALINK_PATTERN.replace('%slug%', slug)
    .replace('%id%', id)
    .replace('%category%', category || '')
    .replace('%year%', year)
    .replace('%month%', month)
    .replace('%day%', day)
    .replace('%hour%', hour)
    .replace('%minute%', minute)
    .replace('%second%', second);

  // Ex: "blog/mon-article" (selon ton pattern)
  const path = pattern
    .split('/')
    .map((el) => trimSlash(el))
    .filter(Boolean)
    .join('/');

  // si le pattern ne commence pas par BLOG_BASE, on le préfixe
  const pathWithBase = path.startsWith(trimSlash(BLOG_BASE ?? 'blog'))
    ? path
    : `${trimSlash(BLOG_BASE ?? 'blog')}/${path}`;

  // Préfixe i18n: "/fr/blog/zwift/"
  // Préfixe i18n: "/fr/{path}" (avec BLOG_BASE déjà dans pattern)
  return withLangPrefix(lang, pathWithBase);
};

/* ------------------------------------------------------------------ */
/* Normalisation d’un post                                            */
/* ------------------------------------------------------------------ */

const getNormalizedPost = async (entry: CollectionEntry<'post'>): Promise<Post> => {
  const { id, data } = entry;
  const { Content, remarkPluginFrontmatter } = await render(entry);

  const {
    publishDate: rawPublishDate = new Date(),
    updateDate: rawUpdateDate,
    title,
    excerpt,
    image,
    imageKey,
    tags: rawTags = [],
    category: rawCategory,
    author,
    draft = false,
    metadata = {},
    lang = 'fr', // ⬅️ IMPORTANT : langue depuis le frontmatter
  } = data;

  const slug = cleanSlug(fileSlug(entry)); // base propre depuis le nom de fichier
  const publishDate = new Date(rawPublishDate);
  const updateDate = rawUpdateDate ? new Date(rawUpdateDate) : undefined;

  const category = rawCategory
    ? { slug: cleanSlug(rawCategory), title: rawCategory }
    : undefined;

  const tags = rawTags.map((tag: string) => ({
    slug: cleanSlug(tag),
    title: tag,
  }));

  return {
    id,
    slug,
    permalink: generatePermalink({
      id,
      slug,
      publishDate,
      category: category?.slug,
      lang,                                  // ⬅️ préfix i18n
    }),
    publishDate,
    updateDate,
    title,
    excerpt,
    image,
    imageKey,
    category,
    tags,
    author,
    draft,
    // ⬇️ si tu utilises un sanitizer, décommente la ligne suivante
    // metadata: sanitizeMetaData(metadata),
    metadata: metadata as unknown,               // sinon, garde tel quel (si déjà propre)
    Content,                                 // rendu Astro
    readingTime: remarkPluginFrontmatter?.readingTime,
    lang,                                    // ⬅️ stocké dans le Post
  };
};

/* ------------------------------------------------------------------ */
/* Chargement & cache                                                 */
/* ------------------------------------------------------------------ */

const load = async function (lang?: 'fr' | 'en'): Promise<Array<Post>> {
  // Filtre par langue si fournie
  const entries = await getCollection('post', ({ data }) => (lang ? data.lang === lang : true));
  const normalized = await Promise.all(entries.map(getNormalizedPost));

  const results = normalized
    .sort((a, b) => b.publishDate.valueOf() - a.publishDate.valueOf())
    .filter((post) => !post.draft);

  return results;
};

let _postsAll: Array<Post> | undefined;
const _postsByLang = new Map<'fr' | 'en', Array<Post>>();

/** */
export const isBlogEnabled = APP_BLOG.isEnabled;
export const isRelatedPostsEnabled = APP_BLOG.isRelatedPostsEnabled;
export const isBlogListRouteEnabled = APP_BLOG.list.isEnabled;
export const isBlogPostRouteEnabled = APP_BLOG.post.isEnabled;
export const isBlogCategoryRouteEnabled = APP_BLOG.category.isEnabled;
export const isBlogTagRouteEnabled = APP_BLOG.tag.isEnabled;

export const blogListRobots = APP_BLOG.list.robots;
export const blogPostRobots = APP_BLOG.post.robots;
export const blogCategoryRobots = APP_BLOG.category.robots;
export const blogTagRobots = APP_BLOG.tag.robots;

export const blogPostsPerPage = APP_BLOG?.postsPerPage;

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */

export const fetchPosts = async (lang?: 'fr' | 'en'): Promise<Array<Post>> => {
  if (lang) {
    if (!_postsByLang.get(lang)) {
      _postsByLang.set(lang, await load(lang));
    }
    return _postsByLang.get(lang)!;
  }

  if (!_postsAll) _postsAll = await load();
  return _postsAll;
};

export const findPostsBySlugs = async (slugs: Array<string>, lang?: 'fr' | 'en'): Promise<Array<Post>> => {
  if (!Array.isArray(slugs)) return [];
  const posts = await fetchPosts(lang);
  return posts.filter((p) => slugs.includes(p.slug ?? ''));
};

export const findPostsByIds = async (ids: Array<string>, lang?: 'fr' | 'en'): Promise<Array<Post>> => {
  if (!Array.isArray(ids)) return [];
  const posts = await fetchPosts(lang);
  return posts.filter((p) => ids.includes(p.id));
};

export const findLatestPosts = async ({ count, lang }: { count?: number; lang?: 'fr' | 'en' }): Promise<Array<Post>> => {
  const _count = count || 4;
  const posts = await fetchPosts(lang);
  return posts.slice(0, _count);
};

/* ------------------------------------------------------------------ */
/* getStaticPaths helpers pour routes `[lang]/[...blog]`              */
/* ------------------------------------------------------------------ */

export const getStaticPathsBlogList = (lang: 'fr' | 'en'): GetStaticPaths => {
  return async ({ paginate }) => {
    if (!isBlogEnabled || !isBlogListRouteEnabled) return [];
    const posts = await fetchPosts(lang);
    return paginate(posts, {
      params: { lang, blog: BLOG_BASE || undefined }, // ex: blog
      pageSize: blogPostsPerPage,
    });
  };
};

export const getStaticPathsBlogPost = (lang: 'fr' | 'en'): GetStaticPaths => {
  return async () => {
    if (!isBlogEnabled || !isBlogPostRouteEnabled) return [];
    const posts = await fetchPosts(lang);
    return posts.map((post) => ({
      params: { lang, blog: `${BLOG_BASE}/${post.slug}` },
      props: { post },
    }));
  };
};

export const getStaticPathsBlogCategory = async ({
  paginate,
  lang,
}: {
  paginate: PaginateFunction;
  lang: 'fr' | 'en';
}) => {
  if (!isBlogEnabled || !isBlogCategoryRouteEnabled) return [];

  const posts = await fetchPosts(lang);
  const categories: Record<string, NonNullable<Post['category']>> = {};
  posts.forEach((post) => {
    if (post.category?.slug) categories[post.category.slug] = post.category;
  });

  return Object.keys(categories).flatMap((categorySlug) =>
    paginate(
      posts.filter((post) => post.category?.slug === categorySlug),
      {
        params: { lang, blog: `${CATEGORY_BASE || 'category'}/${categorySlug}` },
        pageSize: blogPostsPerPage,
        props: { category: categories[categorySlug] },
      }
    )
  );
};

export const getStaticPathsBlogTag = async ({
  paginate,
  lang,
}: {
  paginate: PaginateFunction;
  lang: 'fr' | 'en';
}) => {
  if (!isBlogEnabled || !isBlogTagRouteEnabled) return [];

  const posts = await fetchPosts(lang);
  const tags: Record<string, { slug: string; title: string }> = {};

  posts.forEach((post) => {
    post.tags?.forEach((tag) => {
      tags[tag.slug] = tag;
    });
  });

 return Object.keys(tags).flatMap((tagSlug) =>
  paginate(
    posts.filter((post) => post.tags?.some((t) => t.slug === tagSlug)),
    {
      // ✅ Corrigé ici : Astro attend "tag", pas "blog"
      params: { lang, tag: tagSlug },
      pageSize: blogPostsPerPage,
      props: { tag: tags[tagSlug] },
    }
  )
);
};

/* ------------------------------------------------------------------ */
/* Relations                                                          */
/* ------------------------------------------------------------------ */

export async function getRelatedPosts(originalPost: Post, maxResults: number = 4): Promise<Post[]> {
  const allPosts = await fetchPosts(originalPost.lang); // même langue
  const originalTagsSet = new Set(originalPost.tags?.map((t) => t.slug) ?? []);

  const scored = allPosts
    .filter((p) => p.slug !== originalPost.slug)
    .map((p) => {
      let score = 0;
      if (p.category?.slug && originalPost.category?.slug && p.category.slug === originalPost.category.slug) score += 5;
      p.tags?.forEach((t) => { if (originalTagsSet.has(t.slug)) score += 1; });
      return { post: p, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map((x) => x.post);
}
