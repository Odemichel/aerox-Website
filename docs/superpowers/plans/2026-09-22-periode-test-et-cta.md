# Période de test & CTA unifié — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer l'appel à l'action « Pionnier » daté par une prise de rendez-vous pour une période de test accompagnée, servie par un formulaire partagé, une route API validée et une notification email.

**Architecture :** La logique pure (validation, anti-spam, garde-fou de redirection) vit dans `src/lib/`, testée par vitest ; les routes Astro SSR ne font qu'orchestrer. Un composant `LeadForm.astro` piloté par une prop `topic` sert les deux formulaires de leads du site (période de test, bike-fitter), ce qui supprime la duplication actuelle. La notification email passe par une Edge Function Supabase calquée sur `notify-admin-pending-bf`.

**Tech Stack :** Astro 5.12 (`output: 'server'`, adaptateur Vercel), TypeScript, Tailwind, vitest (ajouté par ce plan), MailerLite API v2, Supabase Edge Functions (Deno + nodemailer).

**Spec :** `docs/superpowers/specs/2026-09-22-periode-test-et-tarifs-design.md`

## Global Constraints

- Branche : `main`. Ne pas toucher à `v3-produits`.
- Registre : **tutoiement** dans toutes les copies françaises.
- `SUPPORTED_LOCALES = ['fr','en','pt','es','it','de','nl','ja','tr']` — 9 langues, dictionnaires dans `src/locales/{lang}.json`, actuellement synchronisés (647 clés ; `en` en a 638).
- Toute route API est `export const prerender = false;`.
- `trailingSlash: 'always'` dans `astro.config.mjs` — **tout `fetch()` interne doit finir par `/`**.
- Le secret `MAILERLITE_API_KEY` existe déjà dans `.env`. Groupes MailerLite existants : `AeroX Global - fr` = `180112371932464856`, `AeroX Global - en` = `180113595562985140`.
- Aucun secret ne doit apparaître dans du code client (`<script>` non-`is:inline` inclus).
- Vérification finale de chaque tâche : `npm run check` et `npm run build` passent.

## Corrections apportées à la spec (constatées dans le code)

Ces trois points de la spec sont faux et le plan les corrige :

1. **La spec §8 affirme que `t()` implémente un fallback anglais. C'est faux.** `src/lib/i18n.ts:39` fait `dict[key] ?? key` : une clé absente s'affiche **en brut sur la page** (`cta.testPeriod.text`). La Task 1 implémente le fallback pour que la stratégie annoncée dans la spec devienne vraie.
2. **La spec §4 parle de « douze textes rotatifs » dont `home.features*.cta`. Ces clés n'existent pas.** Les CTA réellement en place sont au nombre de huit : `home.hero.cta.text`, `home.hero.cta.subtext`, `home.testimonials.cta`, `home.steps.cta`, `home.faq.cta`, `nav.cta.mobile`, `nav.cta.desktop`, `nav.cta.subtext`. `home.features.ctaDetails` est un texte de détail, pas un CTA. `home.leadmagnet.cta` est le bouton du formulaire ebook et **doit être laissé intact**.
3. **`index.astro:76` contient un bug d'affichage préexistant** : `tagline={t(dict, 'home.hero.tagline')}` est écrit *après* le `>` de `<Hero>`, donc dans les enfants. Le texte `tagline={...}` est rendu littéralement dans la page au lieu d'alimenter la prop `tagline` de `Hero.astro`. La Task 9 le corrige en le remontant dans les attributs.

## File Structure

| Fichier | Responsabilité |
|---|---|
| `src/lib/i18n.ts` (modifier) | Fallback anglais dans `getDict` |
| `src/lib/leadValidation.ts` (créer) | Validation pure du payload lead + normalisation |
| `src/lib/rateLimit.ts` (créer) | Fenêtre glissante en mémoire, par IP |
| `test/leadValidation.test.ts` (créer) | Tests de la validation |
| `test/rateLimit.test.ts` (créer) | Tests du rate limit |
| `test/i18n.test.ts` (créer) | Test du fallback anglais |
| `src/pages/[lang]/api/lead.ts` (créer) | Route SSR : valide, pousse MailerLite, notifie |
| `src/components/widgets/LeadForm.astro` (créer) | Formulaire partagé, piloté par `topic` |
| `src/pages/[lang]/periode-test/index.astro` (créer) | Page de prise de rendez-vous |
| `src/pages/[lang]/bike-fitting/index.astro` (modifier) | Migre sur `LeadForm` |
| `src/pages/[lang]/bike-fitting/api/contact.ts` (supprimer) | Remplacée par `lead.ts` |
| `supabase/functions/notify-admin-lead/index.ts` (créer) | Email admin |
| `src/pages/[lang]/index.astro` (modifier) | CTA unifié, purge du décompte hero |
| `src/navigation.ts` (modifier) | CTA unifié |
| `src/locales/*.json` (modifier ×9) | Clés `cta.testPeriod.*`, `testPeriod.*`, `lead.*` |

---

### Task 1 : Harnais de test + fallback anglais i18n

**Files:**
- Create: `vitest.config.ts`
- Create: `test/i18n.test.ts`
- Modify: `src/lib/i18n.ts:27-33`
- Modify: `package.json` (scripts + devDependencies)

**Interfaces:**
- Consumes: rien.
- Produces: `mergeDicts(base, locale): Record<string, string>` et `getDict(lang: string): Record<string, string>` — ce dernier renvoie désormais un dictionnaire **fusionné sur l'anglais**. `npm test` exécute vitest.

- [ ] **Step 1 : Installer vitest**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
npm install -D vitest@^2.1.0
```

- [ ] **Step 2 : Créer la configuration vitest**

Créer `vitest.config.ts` :

```ts
import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '~': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 3 : Ajouter le script npm**

Dans `package.json`, ajouter à `"scripts"` (juste après `"astro": "astro"`) :

```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 4 : Écrire le test qui échoue**

Le fallback doit être testé sur une fonction pure, pas sur les dictionnaires réels : aujourd'hui `en` (638 clés) est un sous-ensemble des huit autres (647 clés), donc un test « chaque locale contient toutes les clés de `en` » serait **vert avant l'implémentation** — ce ne serait pas un cycle rouge-vert. On extrait donc la fusion dans `mergeDicts`, qu'on teste sur des fixtures.

Créer `test/i18n.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import enDict from '../src/locales/en.json';
import { mergeDicts, getDict, t, SUPPORTED_LOCALES } from '../src/lib/i18n';

describe('mergeDicts', () => {
  it('complète la locale avec les clés absentes du socle', () => {
    expect(mergeDicts({ a: 'A', b: 'B' }, { a: 'A-fr' })).toEqual({ a: 'A-fr', b: 'B' });
  });

  it('laisse la traduction locale gagner sur le socle', () => {
    expect(mergeDicts({ a: 'base' }, { a: 'locale' }).a).toBe('locale');
  });

  it('conserve les clés que seule la locale possède', () => {
    expect(mergeDicts({ a: 'A' }, { z: 'Z' })).toEqual({ a: 'A', z: 'Z' });
  });

  it('ne modifie aucun des deux dictionnaires d’entrée', () => {
    const base = { a: 'A' };
    const loc = { a: 'A-fr' };
    mergeDicts(base, loc);
    expect(base).toEqual({ a: 'A' });
    expect(loc).toEqual({ a: 'A-fr' });
  });

  it('rend le socle intégralement quand la locale est vide', () => {
    expect(mergeDicts({ a: 'A', b: 'B' }, {})).toEqual({ a: 'A', b: 'B' });
  });
});

describe('getDict', () => {
  it('privilégie la traduction locale sur l’anglais', () => {
    expect(getDict('fr')['nav.home']).not.toBe(getDict('en')['nav.home']);
  });

  it('retombe sur l’anglais pour une locale inconnue', () => {
    expect(getDict('xx')['nav.home']).toBe(getDict('en')['nav.home']);
  });

  it('garantit que chaque locale rend toutes les clés anglaises', () => {
    const enKeys = Object.keys(enDict);
    for (const loc of SUPPORTED_LOCALES) {
      const d = getDict(loc);
      expect(enKeys.filter((k) => d[k] === undefined), `locale ${loc}`).toEqual([]);
    }
  });

  it('t() ne renvoie la clé brute que si elle manque partout', () => {
    expect(t(getDict('fr'), 'cle.qui.nexiste.nulle.part')).toBe('cle.qui.nexiste.nulle.part');
  });
});
```

- [ ] **Step 5 : Lancer les tests pour les voir échouer**

Run: `npm test -- test/i18n.test.ts`
Expected: FAIL — les cinq tests de `mergeDicts` échouent avec `mergeDicts is not a function`. Les quatre tests de `getDict` passent déjà : c'est normal, ils décrivent le comportement à préserver.

- [ ] **Step 6 : Implémenter la fusion**

Dans `src/lib/i18n.ts`, ajouter la fonction et rebrancher `getDict` :

```ts
/**
 * Fusionne un dictionnaire de locale sur un socle. Les deux entrées sont
 * laissées intactes. Utilisé pour que l'anglais serve de filet : une clé
 * absente de la locale s'affiche en anglais, jamais en brut.
 */
export function mergeDicts(
  base: Record<string, string>,
  locale: Record<string, string>,
): Record<string, string> {
  return { ...base, ...locale };
}

export function getDict(lang: string): Record<string, string> {
  const l = (SUPPORTED_LOCALES as readonly string[]).includes(lang)
    ? (lang as Locale)
    : DEFAULT_LOCALE;
  return mergeDicts(dictionaries[DEFAULT_LOCALE], dictionaries[l]);
}
```

Ne pas toucher à `t()` : son `?? key` reste le filet de dernier recours.

- [ ] **Step 7 : Lancer les tests**

Run: `npm test`
Expected: PASS, 9 tests.

- [ ] **Step 8 : Vérifier que le site compile toujours**

Run: `npm run check && npm run build`
Expected: aucune erreur.

- [ ] **Step 9 : Commit**

```bash
git add vitest.config.ts test/i18n.test.ts src/lib/i18n.ts package.json package-lock.json
git commit -m "feat i18n : fallback anglais dans getDict + harnais vitest"
```

---

### Task 2 : Module de validation des leads

**Files:**
- Create: `src/lib/leadValidation.ts`
- Create: `test/leadValidation.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `export const LEAD_TOPICS = ['test-period', 'bike-fitter'] as const;`
  - `export type LeadTopic = (typeof LEAD_TOPICS)[number];`
  - `export type LeadInput = { topic?: unknown; name?: unknown; email?: unknown; message?: unknown; availability?: unknown; trainer?: unknown; webcam?: unknown; hp?: unknown };`
  - `export type LeadResult = { ok: true; honeypot: boolean; lead: Lead } | { ok: false; error: string };`
  - `export type Lead = { topic: LeadTopic; name: string; email: string; message: string; availability: string; trainer: string; webcam: 'oui' | 'non' | '' };`
  - `export function validateLead(input: LeadInput): LeadResult;`

- [ ] **Step 1 : Écrire les tests qui échouent**

Créer `test/leadValidation.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { validateLead, LEAD_TOPICS } from '../src/lib/leadValidation';

const base = { topic: 'test-period', name: 'Olivier', email: 'o@example.com' };

describe('validateLead', () => {
  it('accepte un lead minimal valide', () => {
    const r = validateLead(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.honeypot).toBe(false);
      expect(r.lead.email).toBe('o@example.com');
      expect(r.lead.topic).toBe('test-period');
      expect(r.lead.message).toBe('');
    }
  });

  it('refuse un topic hors liste blanche', () => {
    const r = validateLead({ ...base, topic: 'spam-topic' });
    expect(r).toEqual({ ok: false, error: 'invalid_topic' });
  });

  it('refuse un topic absent', () => {
    expect(validateLead({ name: 'x', email: 'a@b.fr' })).toEqual({ ok: false, error: 'invalid_topic' });
  });

  it('refuse un email absent', () => {
    expect(validateLead({ ...base, email: undefined })).toEqual({ ok: false, error: 'invalid_email' });
  });

  it.each(['pasunemail', 'a@', '@b.fr', 'a b@c.fr', 'a@b', ''])('refuse l’email invalide %s', (email) => {
    expect(validateLead({ ...base, email })).toEqual({ ok: false, error: 'invalid_email' });
  });

  it('normalise l’email en minuscules et sans espaces', () => {
    const r = validateLead({ ...base, email: '  Olivier@Example.COM ' });
    expect(r.ok && r.lead.email).toBe('olivier@example.com');
  });

  it('refuse un nom vide', () => {
    expect(validateLead({ ...base, name: '   ' })).toEqual({ ok: false, error: 'invalid_name' });
  });

  it('refuse un champ texte de plus de 2000 caractères', () => {
    const r = validateLead({ ...base, message: 'a'.repeat(2001) });
    expect(r).toEqual({ ok: false, error: 'field_too_long' });
  });

  it('accepte un champ texte de 2000 caractères exactement', () => {
    expect(validateLead({ ...base, message: 'a'.repeat(2000) }).ok).toBe(true);
  });

  it('signale le honeypot sans rejeter', () => {
    const r = validateLead({ ...base, hp: 'rempli par un bot' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.honeypot).toBe(true);
  });

  it('normalise webcam en oui/non et ignore le reste', () => {
    expect(validateLead({ ...base, webcam: 'oui' }).ok && validateLead({ ...base, webcam: 'oui' }).lead.webcam).toBe('oui');
    expect(validateLead({ ...base, webcam: 'non' }).ok && validateLead({ ...base, webcam: 'non' }).lead.webcam).toBe('non');
    const r = validateLead({ ...base, webcam: 'peut-être' });
    expect(r.ok && r.lead.webcam).toBe('');
  });

  it('joint un tableau de disponibilités en une chaîne', () => {
    const r = validateLead({ ...base, availability: ['semaine-matin', 'weekend-soir'] });
    expect(r.ok && r.lead.availability).toBe('semaine-matin, weekend-soir');
  });

  it('ignore les entrées non-textuelles d’un tableau de disponibilités', () => {
    const r = validateLead({ ...base, availability: ['semaine-matin', 42, null, 'weekend-soir'] });
    expect(r.ok && r.lead.availability).toBe('semaine-matin, weekend-soir');
  });

  it('refuse des disponibilités dont le total dépasse 2000 caractères', () => {
    const r = validateLead({ ...base, availability: [ 'a'.repeat(1500), 'b'.repeat(600) ] });
    expect(r).toEqual({ ok: false, error: 'field_too_long' });
  });

  it('refuse un type inattendu sur un champ texte', () => {
    expect(validateLead({ ...base, name: 42 })).toEqual({ ok: false, error: 'invalid_name' });
    expect(validateLead({ ...base, trainer: { a: 1 } })).toEqual({ ok: false, error: 'invalid_field' });
  });

  it('expose la liste blanche des topics', () => {
    expect(LEAD_TOPICS).toEqual(['test-period', 'bike-fitter']);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour les voir échouer**

Run: `npm test -- test/leadValidation.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/leadValidation"`.

- [ ] **Step 3 : Implémenter le module**

Créer `src/lib/leadValidation.ts` :

```ts
export const LEAD_TOPICS = ['test-period', 'bike-fitter'] as const;
export type LeadTopic = (typeof LEAD_TOPICS)[number];

const MAX_FIELD_LENGTH = 2000;

// Volontairement strict mais simple : un local, un @, un domaine pointé.
// Le but est d'écarter le bruit, pas de valider la RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export type LeadInput = {
  topic?: unknown;
  name?: unknown;
  email?: unknown;
  message?: unknown;
  availability?: unknown;
  trainer?: unknown;
  webcam?: unknown;
  hp?: unknown;
};

export type Lead = {
  topic: LeadTopic;
  name: string;
  email: string;
  message: string;
  availability: string;
  trainer: string;
  webcam: 'oui' | 'non' | '';
};

export type LeadResult = { ok: true; honeypot: boolean; lead: Lead } | { ok: false; error: string };

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  return value.trim();
}

export function validateLead(input: LeadInput): LeadResult {
  const topic = input.topic;
  if (typeof topic !== 'string' || !(LEAD_TOPICS as readonly string[]).includes(topic)) {
    return { ok: false, error: 'invalid_topic' };
  }

  const name = asText(input.name);
  if (name === null || name.length === 0) return { ok: false, error: 'invalid_name' };
  if (name.length > MAX_FIELD_LENGTH) return { ok: false, error: 'field_too_long' };

  const rawEmail = asText(input.email);
  if (rawEmail === null) return { ok: false, error: 'invalid_email' };
  const email = rawEmail.toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };

  const message = asText(input.message);
  const trainer = asText(input.trainer);
  if (message === null || trainer === null) return { ok: false, error: 'invalid_field' };
  if (message.length > MAX_FIELD_LENGTH || trainer.length > MAX_FIELD_LENGTH) {
    return { ok: false, error: 'field_too_long' };
  }

  let availability = '';
  if (Array.isArray(input.availability)) {
    availability = input.availability.filter((v): v is string => typeof v === 'string').join(', ');
  } else {
    const single = asText(input.availability);
    if (single === null) return { ok: false, error: 'invalid_field' };
    availability = single;
  }
  if (availability.length > MAX_FIELD_LENGTH) return { ok: false, error: 'field_too_long' };

  const webcamRaw = typeof input.webcam === 'string' ? input.webcam.trim().toLowerCase() : '';
  const webcam: Lead['webcam'] = webcamRaw === 'oui' || webcamRaw === 'non' ? webcamRaw : '';

  const honeypot = typeof input.hp === 'string' && input.hp.trim().length > 0;

  return {
    ok: true,
    honeypot,
    lead: { topic: topic as LeadTopic, name, email, message, availability, trainer, webcam },
  };
}
```

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- test/leadValidation.test.ts`
Expected: PASS, tous les cas.

- [ ] **Step 5 : Commit**

```bash
git add src/lib/leadValidation.ts test/leadValidation.test.ts
git commit -m "feat lead : module de validation des demandes de contact"
```

---

### Task 3 : Limite de débit par IP

**Files:**
- Create: `src/lib/rateLimit.ts`
- Create: `test/rateLimit.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `export function createRateLimiter(opts: { limit: number; windowMs: number }): { check(key: string, now?: number): boolean; size(): number };`
  - `export const leadRateLimiter` — instance partagée, 5 requêtes / 10 minutes.

**Limite assumée :** le compteur vit en mémoire de l'instance serverless Vercel. Plusieurs instances ⇒ plusieurs compteurs, et une instance froide repart de zéro. C'est un ralentisseur, pas un verrou. La défense principale contre le spam reste le honeypot et le bornage des champs ; ce limiteur évite qu'un même client boucle sur la route. Ne pas le présenter comme davantage.

- [ ] **Step 1 : Écrire les tests qui échouent**

Créer `test/rateLimit.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/lib/rateLimit';

describe('createRateLimiter', () => {
  it('laisse passer jusqu’à la limite', () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect(rl.check('ip1', 0)).toBe(true);
    expect(rl.check('ip1', 1)).toBe(true);
    expect(rl.check('ip1', 2)).toBe(true);
  });

  it('bloque au-delà de la limite dans la fenêtre', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    rl.check('ip1', 0);
    rl.check('ip1', 10);
    expect(rl.check('ip1', 20)).toBe(false);
  });

  it('rouvre après la fenêtre', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    rl.check('ip1', 0);
    rl.check('ip1', 10);
    expect(rl.check('ip1', 20)).toBe(false);
    expect(rl.check('ip1', 1001)).toBe(true);
  });

  it('compte chaque clé séparément', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check('ip1', 0)).toBe(true);
    expect(rl.check('ip2', 0)).toBe(true);
    expect(rl.check('ip1', 1)).toBe(false);
  });

  it('purge les clés expirées au lieu de croître sans fin', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 100 });
    for (let i = 0; i < 500; i++) rl.check(`ip${i}`, i);
    // après une fenêtre entière, tout est purgé au prochain appel
    expect(rl.check('nouvelle-ip', 100_000)).toBe(true);
    expect(rl.size()).toBe(1);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour les voir échouer**

Run: `npm test -- test/rateLimit.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter le module**

Créer `src/lib/rateLimit.ts` :

```ts
type Options = { limit: number; windowMs: number };

/**
 * Fenêtre glissante en mémoire.
 *
 * Portée : l'instance serverless courante. Plusieurs instances Vercel ⇒
 * plusieurs compteurs indépendants, et un démarrage à froid remet à zéro.
 * C'est délibéré : ce limiteur empêche un client de boucler sur la route,
 * il ne constitue pas une protection anti-spam distribuée.
 */
export function createRateLimiter({ limit, windowMs }: Options) {
  const hits = new Map<string, number[]>();

  function prune(now: number) {
    for (const [key, stamps] of hits) {
      const kept = stamps.filter((s) => now - s < windowMs);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }

  return {
    check(key: string, now: number = Date.now()): boolean {
      prune(now);
      const stamps = hits.get(key) ?? [];
      if (stamps.length >= limit) return false;
      stamps.push(now);
      hits.set(key, stamps);
      return true;
    },
    size(): number {
      return hits.size;
    },
  };
}

export const leadRateLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
```

- [ ] **Step 4 : Lancer les tests**

Run: `npm test -- test/rateLimit.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5 : Commit**

```bash
git add src/lib/rateLimit.ts test/rateLimit.test.ts
git commit -m "feat lead : limiteur de débit par IP en mémoire"
```

---

### Task 4 : Configuration MailerLite (champs + groupes)

**Files:** aucun fichier du dépôt — configuration distante via l'API MailerLite.

**Interfaces:**
- Consumes: `MAILERLITE_API_KEY` du `.env`.
- Produces: les clés de champs `home_trainer`, `webcam`, `dispos`, `message` et les identifiants des groupes `periode-test` et `bike-fitter`, à reporter dans `src/pages/[lang]/api/lead.ts` en Task 5.

**État constaté au 2026-09-22 :** MailerLite ne contient que les 8 champs par défaut (`name`, `last_name`, `company`, `city`, `country`, `phone`, `state`, `z_i_p`) et 6 groupes (`AeroX Global - fr/en`, `Livre-fr/en`, `beta-tester-aerox`, `tri-dijon-2026`). Aucun champ personnalisé, aucun groupe de leads.

- [ ] **Step 1 : Créer les quatre champs personnalisés**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
K=$(grep -m1 '^MAILERLITE_API_KEY=' .env | cut -d= -f2- | tr -d '"'"'"' \r')
for f in home_trainer webcam dispos message; do
  curl -s https://connect.mailerlite.com/api/fields \
    -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$f\",\"type\":\"text\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('data',d))"
done
```

Expected: quatre objets avec `"key"` valant `home_trainer`, `webcam`, `dispos`, `message`. **Noter les clés renvoyées** : MailerLite peut normaliser le nom (par exemple `home_trainer` devient `home_trainer`, mais vérifier). Ce sont ces clés exactes qui iront dans `fields` en Task 5.

- [ ] **Step 2 : Créer les deux groupes**

```bash
K=$(grep -m1 '^MAILERLITE_API_KEY=' .env | cut -d= -f2- | tr -d '"'"'"' \r')
for g in "periode-test" "bike-fitter"; do
  curl -s https://connect.mailerlite.com/api/groups \
    -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$g\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d['name'],d['id'])"
done
```

Expected: deux lignes `periode-test <id>` et `bike-fitter <id>`. **Noter les deux identifiants.**

- [ ] **Step 3 : Vérifier l'état final**

```bash
K=$(grep -m1 '^MAILERLITE_API_KEY=' .env | cut -d= -f2- | tr -d '"'"'"' \r')
echo "--- champs ---"
curl -s "https://connect.mailerlite.com/api/fields?limit=50" -H "Authorization: Bearer $K" \
  | python3 -c "import sys,json;[print(f['key'],'|',f['type']) for f in json.load(sys.stdin)['data']]"
echo "--- groupes ---"
curl -s "https://connect.mailerlite.com/api/groups?limit=50" -H "Authorization: Bearer $K" \
  | python3 -c "import sys,json;[print(g['id'],'|',g['name']) for g in json.load(sys.stdin)['data']]"
```

Expected: 12 champs (8 par défaut + 4 nouveaux), 8 groupes (6 + 2 nouveaux).

- [ ] **Step 4 : Consigner les identifiants**

Reporter les six valeurs relevées (4 clés de champs + 2 identifiants de groupes) dans ce fichier de plan, sous cette tâche, avant de passer à la Task 5. Elles sont l'entrée directe du code qui suit.

```
home_trainer = ____________
webcam       = ____________
dispos       = ____________
message      = ____________
groupe periode-test = ____________
groupe bike-fitter  = ____________
```

---

### Task 5 : Edge Function `notify-admin-lead`

**Files:**
- Create: `supabase/functions/notify-admin-lead/index.ts`

**Interfaces:**
- Consumes: le secret `SMTP_PASS` déjà configuré sur le projet Supabase `agvksgrjqskpetokudda`.
- Produces: endpoint `POST https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-lead`, corps `{ topic: string, fields: Record<string, string> }`, appelé avec la clé anon en `Authorization: Bearer`.

Le modèle est `notify-admin-pending-bf` (déployée, `verify_jwt: true`, nodemailer + SMTP IONOS). La différence : celle-ci reçoit un payload applicatif, pas un Database Webhook, et **échappe chaque valeur en HTML** — les valeurs viennent d'un formulaire public.

- [ ] **Step 1 : Écrire la fonction**

Créer `supabase/functions/notify-admin-lead/index.ts` :

```ts
import nodemailer from "npm:nodemailer@6.9.16";

const ADMIN_EMAIL = "olivier.demichel@gmail.com";
const SMTP_HOST = "smtp.ionos.fr";
const SMTP_PORT = 587;
const SMTP_USER = "olivier.demichel@aeroxbefaster.com";
const SMTP_FROM = '"AeroX BeFaster" <no-reply@aeroxbefaster.com>';

const TOPIC_LABELS: Record<string, string> = {
  "test-period": "Demande de période de test",
  "bike-fitter": "Demande Bike-Fitter",
};

const FIELD_LABELS: Record<string, string> = {
  name: "Nom",
  email: "Email",
  lang: "Langue",
  availability: "Disponibilités",
  trainer: "Home-trainer",
  webcam: "Webcam",
  message: "Message",
};

// Les valeurs proviennent d'un formulaire public : rien n'est inséré brut.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload = await req.json();
    const topic = typeof payload?.topic === "string" ? payload.topic : "";
    const fields = payload?.fields;

    if (!TOPIC_LABELS[topic]) {
      return Response.json({ error: "Unknown topic" }, { status: 400 });
    }
    if (!fields || typeof fields !== "object") {
      return Response.json({ error: "Missing fields" }, { status: 400 });
    }

    const rows = Object.entries(fields as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
      .map(([k, v]) => {
        const label = escapeHtml(FIELD_LABELS[k] ?? k);
        const value = escapeHtml(String(v)).replace(/\n/g, "<br>");
        return `<tr><td style="padding:8px 0;color:#666;width:150px;vertical-align:top;">${label}</td><td style="padding:8px 0;font-weight:600;">${value}</td></tr>`;
      })
      .join("");

    const title = escapeHtml(TOPIC_LABELS[topic]);
    const who = escapeHtml(
      typeof (fields as Record<string, unknown>).name === "string"
        ? String((fields as Record<string, unknown>).name)
        : "",
    );

    const htmlBody = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <div style="background: linear-gradient(135deg, #3f8ca2 0%, #1a1a2e 100%); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">${title}</h1>
  </div>
  <div style="border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
    <table style="width: 100%; border-collapse: collapse; margin: 0;">${rows}</table>
  </div>
</body>
</html>`;

    const smtpPass = Deno.env.get("SMTP_PASS");
    if (!smtpPass) {
      console.error("SMTP_PASS secret is not set");
      return Response.json({ error: "SMTP_PASS not configured" }, { status: 500 });
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false, // STARTTLS sur le port 587
      auth: { user: SMTP_USER, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: ADMIN_EMAIL,
      subject: `[AeroX] ${TOPIC_LABELS[topic]}${who ? ` — ${who}` : ""}`,
      html: htmlBody,
    });

    console.log("Email sent:", info.messageId);
    return Response.json({ message: "Notification sent", messageId: info.messageId }, { status: 200 });
  } catch (error) {
    console.error("notify-admin-lead error:", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
});
```

- [ ] **Step 2 : Déployer**

Déployer via l'outil MCP Supabase `deploy_edge_function` sur le projet `agvksgrjqskpetokudda`, slug `notify-admin-lead`, `verify_jwt: true`, avec le contenu du fichier ci-dessus.

- [ ] **Step 3 : Vérifier le déploiement et envoyer un email de test**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
ANON=$(grep -m1 '^PUBLIC_SUPABASE_ANON_KEY=' .env | cut -d= -f2- | tr -d '"'"'"' \r')
curl -s -X POST "https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-lead" \
  -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' \
  -d '{"topic":"test-period","fields":{"name":"Test <script>alert(1)</script>","email":"test@example.com","trainer":"Tacx Neo 2T","webcam":"oui","availability":"semaine-soir","message":"Ligne 1\nLigne 2"}}'
```

Expected: `{"message":"Notification sent","messageId":"..."}`, un email reçu sur `olivier.demichel@gmail.com`, et dans cet email le nom affiché **littéralement** `Test <script>alert(1)</script>` — preuve que l'échappement fonctionne. Vérifier aussi que « Ligne 1 / Ligne 2 » est sur deux lignes.

- [ ] **Step 4 : Vérifier le rejet d'un topic inconnu**

```bash
ANON=$(grep -m1 '^PUBLIC_SUPABASE_ANON_KEY=' .env | cut -d= -f2- | tr -d '"'"'"' \r')
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-lead" \
  -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' \
  -d '{"topic":"n-importe-quoi","fields":{"name":"x"}}'
```

Expected: `400`.

- [ ] **Step 5 : Commit**

```bash
git add supabase/functions/notify-admin-lead/index.ts
git commit -m "feat lead : edge function de notification admin"
```

---

### Task 6 : Route API `/[lang]/api/lead`

**Files:**
- Create: `src/pages/[lang]/api/lead.ts`

**Interfaces:**
- Consumes: `validateLead` (Task 2), `leadRateLimiter` (Task 3), les identifiants MailerLite (Task 4), l'Edge Function (Task 5).
- Produces: `POST /{lang}/api/lead/` → `200 {"success":true}` ou `4xx {"error":"<code>"}`.

**Remplacer les deux `__À_REMPLIR__` par les identifiants de groupes relevés en Task 4 Step 4.** Les quatre clés de champs relevées au même endroit doivent correspondre aux noms utilisés dans l'objet `fields` ci-dessous (`home_trainer`, `webcam`, `dispos`, `message`) ; si MailerLite les a normalisées différemment, aligner le code sur ce qu'a renvoyé l'API.

- [ ] **Step 1 : Écrire la route**

Créer `src/pages/[lang]/api/lead.ts` :

```ts
export const prerender = false;

import type { APIRoute } from 'astro';
import { validateLead, type Lead } from '~/lib/leadValidation';
import { leadRateLimiter } from '~/lib/rateLimit';

const GROUP_GLOBAL_EN = '180113595562985140';
const GROUP_GLOBAL_FR = '180112371932464856';
const GROUP_TEST_PERIOD = '__À_REMPLIR__';
const GROUP_BIKE_FITTER = '__À_REMPLIR__';

const TOPIC_GROUPS: Record<Lead['topic'], string> = {
  'test-period': GROUP_TEST_PERIOD,
  'bike-fitter': GROUP_BIKE_FITTER,
};

const NOTIFY_URL = 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-lead';

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, params, clientAddress }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const result = validateLead(body as Record<string, unknown>);
  if (!result.ok) return json({ error: result.error }, 400);

  // Honeypot : on répond comme si tout s'était bien passé, sans rien faire.
  // Le bot ne peut pas distinguer un succès d'un rejet.
  if (result.honeypot) return json({ success: true }, 200);

  const ip = clientAddress ?? request.headers.get('x-forwarded-for') ?? 'inconnue';
  if (!leadRateLimiter.check(ip)) return json({ error: 'rate_limited' }, 429);

  const { lead } = result;
  const lang = params.lang ?? 'fr';

  const groups = [TOPIC_GROUPS[lead.topic], lang === 'en' ? GROUP_GLOBAL_EN : GROUP_GLOBAL_FR];

  const fields: Record<string, string> = { name: lead.name };
  if (lead.message) fields.message = lead.message;
  if (lead.availability) fields.dispos = lead.availability;
  if (lead.trainer) fields.home_trainer = lead.trainer;
  if (lead.webcam) fields.webcam = lead.webcam;
  if (lead.topic === 'bike-fitter') fields.company = 'bike-fitter';

  const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${import.meta.env.MAILERLITE_API_KEY}`,
    },
    body: JSON.stringify({ email: lead.email, fields, groups }),
  });

  if (!mlRes.ok) {
    console.error('MailerLite error', mlRes.status, await mlRes.text());
    return json({ error: 'subscribe_failed' }, 502);
  }

  // La notification ne doit jamais faire échouer l'inscription du lead :
  // le contact est déjà enregistré chez MailerLite à ce stade.
  try {
    const notifyRes = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.PUBLIC_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        topic: lead.topic,
        fields: {
          name: lead.name,
          email: lead.email,
          lang,
          availability: lead.availability,
          trainer: lead.trainer,
          webcam: lead.webcam,
          message: lead.message,
        },
      }),
    });
    if (!notifyRes.ok) console.error('notify-admin-lead', notifyRes.status, await notifyRes.text());
  } catch (err) {
    console.error('notify-admin-lead unreachable', err);
  }

  return json({ success: true }, 200);
};
```

- [ ] **Step 2 : Lancer le serveur de développement**

Run: `npm run dev`
Expected: serveur sur `http://localhost:4321`.

- [ ] **Step 3 : Vérifier le chemin nominal**

```bash
curl -s -X POST 'http://localhost:4321/fr/api/lead/' -H 'Content-Type: application/json' \
  -d '{"topic":"test-period","name":"Plan Test","email":"plan-test@example.com","trainer":"Tacx Neo 2T","webcam":"oui","availability":["semaine-soir","weekend-matin"],"message":"Bonjour"}'
```

Expected: `{"success":true}`. Vérifier dans MailerLite que l'abonné `plan-test@example.com` est dans les groupes `periode-test` **et** `AeroX Global - fr`, avec `home_trainer`, `webcam`, `dispos`, `message` renseignés — et que `last_name` est **vide** (fin du détournement constaté dans l'ancienne route `contact.ts:26`).

- [ ] **Step 4 : Vérifier le honeypot, la validation et le rate limit**

```bash
echo -n 'honeypot (attendu success, aucun abonné créé) : '
curl -s -X POST 'http://localhost:4321/fr/api/lead/' -H 'Content-Type: application/json' \
  -d '{"topic":"test-period","name":"Bot","email":"bot@example.com","hp":"je suis un bot"}'
echo -n 'topic invalide (attendu invalid_topic) : '
curl -s -X POST 'http://localhost:4321/fr/api/lead/' -H 'Content-Type: application/json' \
  -d '{"topic":"spam","name":"x","email":"a@b.fr"}'
echo -n 'email invalide (attendu invalid_email) : '
curl -s -X POST 'http://localhost:4321/fr/api/lead/' -H 'Content-Type: application/json' \
  -d '{"topic":"test-period","name":"x","email":"pasunemail"}'
echo 'rate limit (la 6e doit renvoyer 429) :'
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "  tentative $i -> %{http_code}\n" -X POST 'http://localhost:4321/fr/api/lead/' \
    -H 'Content-Type: application/json' \
    -d "{\"topic\":\"test-period\",\"name\":\"RL\",\"email\":\"rl$i@example.com\"}"
done
```

Expected: `{"success":true}` pour le honeypot **sans nouvel abonné dans MailerLite**, `{"error":"invalid_topic"}`, `{"error":"invalid_email"}`, puis `200 200 200 200 200 429`.

- [ ] **Step 5 : Commit**

```bash
git add "src/pages/[lang]/api/lead.ts"
git commit -m "feat lead : route API validée avec honeypot et rate limit"
```

---

### Task 7 : Composant `LeadForm.astro`

**Files:**
- Create: `src/components/widgets/LeadForm.astro`
- Modify: `src/locales/fr.json`, `src/locales/en.json`

**Interfaces:**
- Consumes: `POST /{lang}/api/lead/` (Task 6).
- Produces: `<LeadForm topic="test-period" | "bike-fitter" />`. Le composant rend son propre `<form>` avec un `id` dérivé du topic et embarque son script de soumission.

Les sept autres langues sont couvertes par le fallback anglais de la Task 1 ; elles seront traduites dans un second temps.

- [ ] **Step 1 : Ajouter les clés françaises**

Dans `src/locales/fr.json`, ajouter :

```json
  "lead.form.name.placeholder": "Ton prénom et ton nom",
  "lead.form.email.placeholder": "Ton email",
  "lead.form.message.placeholder": "Une question, une précision ?",
  "lead.form.trainer.label": "Ton home-trainer",
  "lead.form.trainer.placeholder": "Marque et modèle (ex. Tacx Neo 2T)",
  "lead.form.webcam.label": "As-tu une webcam ?",
  "lead.form.webcam.yes": "Oui",
  "lead.form.webcam.no": "Non",
  "lead.form.availability.label": "Tes disponibilités",
  "lead.form.availability.weekMorning": "Semaine — matin",
  "lead.form.availability.weekAfternoon": "Semaine — après-midi",
  "lead.form.availability.weekEvening": "Semaine — soir",
  "lead.form.availability.weekendMorning": "Week-end — matin",
  "lead.form.availability.weekendAfternoon": "Week-end — après-midi",
  "lead.form.availability.weekendEvening": "Week-end — soir",
  "lead.form.submit": "Envoyer ma demande",
  "lead.form.sending": "Envoi…",
  "lead.form.success": "C'est noté. Olivier te recontacte pour caler ton créneau.",
  "lead.form.error": "L'envoi a échoué. Réessaie dans un instant.",
```

- [ ] **Step 2 : Ajouter les clés anglaises**

Dans `src/locales/en.json`, ajouter :

```json
  "lead.form.name.placeholder": "Your first and last name",
  "lead.form.email.placeholder": "Your email",
  "lead.form.message.placeholder": "A question, a detail?",
  "lead.form.trainer.label": "Your smart trainer",
  "lead.form.trainer.placeholder": "Brand and model (e.g. Tacx Neo 2T)",
  "lead.form.webcam.label": "Do you have a webcam?",
  "lead.form.webcam.yes": "Yes",
  "lead.form.webcam.no": "No",
  "lead.form.availability.label": "Your availability",
  "lead.form.availability.weekMorning": "Weekday — morning",
  "lead.form.availability.weekAfternoon": "Weekday — afternoon",
  "lead.form.availability.weekEvening": "Weekday — evening",
  "lead.form.availability.weekendMorning": "Weekend — morning",
  "lead.form.availability.weekendAfternoon": "Weekend — afternoon",
  "lead.form.availability.weekendEvening": "Weekend — evening",
  "lead.form.submit": "Send my request",
  "lead.form.sending": "Sending…",
  "lead.form.success": "Got it. Olivier will get back to you to book your slot.",
  "lead.form.error": "Sending failed. Please try again in a moment.",
```

- [ ] **Step 3 : Écrire le composant**

Créer `src/components/widgets/LeadForm.astro` :

```astro
---
import { type Locale, getDict, t } from '~/lib/i18n';

interface Props {
  topic: 'test-period' | 'bike-fitter';
  class?: string;
}

const { topic, class: className = '' } = Astro.props;

const lang = (Astro.params.lang as Locale) ?? 'fr';
const dict = getDict(lang);

const isTestPeriod = topic === 'test-period';

const availabilitySlots = [
  { value: 'semaine-matin', key: 'lead.form.availability.weekMorning' },
  { value: 'semaine-apres-midi', key: 'lead.form.availability.weekAfternoon' },
  { value: 'semaine-soir', key: 'lead.form.availability.weekEvening' },
  { value: 'weekend-matin', key: 'lead.form.availability.weekendMorning' },
  { value: 'weekend-apres-midi', key: 'lead.form.availability.weekendAfternoon' },
  { value: 'weekend-soir', key: 'lead.form.availability.weekendEvening' },
];

const inputClass = 'w-full border rounded p-3 text-secondary';
---

<form
  class={`lead-form flex flex-col gap-4 max-w-md mx-auto text-left ${className}`}
  data-topic={topic}
  data-success={t(dict, 'lead.form.success')}
  data-error={t(dict, 'lead.form.error')}
  data-sending={t(dict, 'lead.form.sending')}
>
  <input type="text" name="name" required placeholder={t(dict, 'lead.form.name.placeholder')} class={inputClass} />
  <input type="email" name="email" required placeholder={t(dict, 'lead.form.email.placeholder')} class={inputClass} />

  {isTestPeriod && (
    <>
      <fieldset class="border-0 p-0 m-0">
        <legend class="mb-2 font-semibold">{t(dict, 'lead.form.availability.label')}</legend>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {availabilitySlots.map((slot) => (
            <label class="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" name="availability" value={slot.value} class="rounded" />
              {t(dict, slot.key)}
            </label>
          ))}
        </div>
      </fieldset>

      <label class="flex flex-col gap-1">
        <span class="font-semibold">{t(dict, 'lead.form.trainer.label')}</span>
        <input type="text" name="trainer" placeholder={t(dict, 'lead.form.trainer.placeholder')} class={inputClass} />
      </label>

      <fieldset class="border-0 p-0 m-0">
        <legend class="mb-2 font-semibold">{t(dict, 'lead.form.webcam.label')}</legend>
        <div class="flex gap-4">
          <label class="inline-flex items-center gap-2 text-sm">
            <input type="radio" name="webcam" value="oui" /> {t(dict, 'lead.form.webcam.yes')}
          </label>
          <label class="inline-flex items-center gap-2 text-sm">
            <input type="radio" name="webcam" value="non" /> {t(dict, 'lead.form.webcam.no')}
          </label>
        </div>
      </fieldset>
    </>
  )}

  <textarea name="message" rows="3" placeholder={t(dict, 'lead.form.message.placeholder')} class={inputClass}></textarea>

  {/* Honeypot : invisible pour l'humain, rempli par les bots. Jamais de label. */}
  <input
    type="text"
    name="hp"
    tabindex="-1"
    autocomplete="off"
    aria-hidden="true"
    class="absolute left-[-9999px] w-px h-px opacity-0"
  />

  <button type="submit" class="btn-primary px-8 py-3 text-lg w-full font-semibold">
    {t(dict, 'lead.form.submit')}
  </button>
  <p class="lead-form-msg text-sm mt-2 hidden"></p>
</form>

<script>
  document.querySelectorAll<HTMLFormElement>('form.lead-form').forEach((form) => {
    const msg = form.querySelector<HTMLParagraphElement>('.lead-form-msg');
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const initialLabel = button?.textContent ?? '';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!button) return;

      button.disabled = true;
      button.textContent = form.dataset.sending ?? '…';

      const data = new FormData(form);
      const payload = {
        topic: form.dataset.topic,
        name: String(data.get('name') ?? '').trim(),
        email: String(data.get('email') ?? '').trim(),
        message: String(data.get('message') ?? '').trim(),
        trainer: String(data.get('trainer') ?? '').trim(),
        webcam: String(data.get('webcam') ?? ''),
        availability: data.getAll('availability').map(String),
        hp: String(data.get('hp') ?? ''),
      };

      const lang = window.location.pathname.split('/')[1] || 'fr';

      let ok = false;
      try {
        const res = await fetch(`/${lang}/api/lead/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        ok = res.ok && (await res.json())?.success === true;
      } catch {
        ok = false;
      }

      if (msg) {
        msg.textContent = (ok ? form.dataset.success : form.dataset.error) ?? '';
        msg.classList.remove('hidden', 'text-red-600', 'text-green-600');
        msg.classList.add(ok ? 'text-green-600' : 'text-red-600');
      }

      if (ok) {
        form.reset();
        button.textContent = initialLabel;
        button.disabled = false;
      } else {
        button.textContent = initialLabel;
        button.disabled = false;
      }
    });
  });
</script>
```

- [ ] **Step 4 : Vérifier la compilation**

Run: `npm run check`
Expected: aucune erreur TypeScript ni Astro.

- [ ] **Step 5 : Commit**

```bash
git add src/components/widgets/LeadForm.astro src/locales/fr.json src/locales/en.json
git commit -m "feat lead : composant de formulaire partagé piloté par topic"
```

---

### Task 8 : Page `/{lang}/periode-test/`

**Files:**
- Create: `src/pages/[lang]/periode-test/index.astro`
- Modify: `src/locales/fr.json`, `src/locales/en.json`

**Interfaces:**
- Consumes: `LeadForm` (Task 7).
- Produces: la route `/{lang}/periode-test/`, cible du CTA unifié de la Task 9.

- [ ] **Step 1 : Ajouter les clés françaises**

Dans `src/locales/fr.json` :

```json
  "testPeriod.meta.title": "Période de test accompagnée — AeroX",
  "testPeriod.meta.description": "Réserve un créneau avec Olivier pour tester AeroX sur ton home-trainer et mesurer ton aéro en direct.",
  "testPeriod.title": "Teste AeroX avec Olivier",
  "testPeriod.subtitle": "Une séance accompagnée, sur rendez-vous, sur ton propre matériel.",
  "testPeriod.steps.title": "Comment ça se passe",
  "testPeriod.steps.1": "Tu choisis un créneau qui t'arrange et tu nous dis sur quoi tu roules.",
  "testPeriod.steps.2": "On installe AeroX ensemble et on cale ta caméra — compte 15 minutes.",
  "testPeriod.steps.3": "Tu pédales, on mesure ta surface frontale et ton CdA position par position.",
  "testPeriod.steps.4": "On regarde tes chiffres ensemble et tu repars avec tes gains.",
  "testPeriod.requirements.title": "Ce qu'il te faut",
  "testPeriod.requirements.1": "Un home-trainer, connecté de préférence.",
  "testPeriod.requirements.2": "Une webcam ou une caméra USB.",
  "testPeriod.requirements.3": "Un Mac ou un PC Windows à côté du vélo.",
  "testPeriod.form.title": "Programme ton créneau",
```

- [ ] **Step 2 : Ajouter les clés anglaises**

Dans `src/locales/en.json` :

```json
  "testPeriod.meta.title": "Guided test session — AeroX",
  "testPeriod.meta.description": "Book a slot with Olivier to try AeroX on your own trainer and measure your aero live.",
  "testPeriod.title": "Try AeroX with Olivier",
  "testPeriod.subtitle": "A guided session, by appointment, on your own gear.",
  "testPeriod.steps.title": "How it works",
  "testPeriod.steps.1": "You pick a slot that suits you and tell us what you ride.",
  "testPeriod.steps.2": "We install AeroX together and set up your camera — about 15 minutes.",
  "testPeriod.steps.3": "You pedal, we measure your frontal area and CdA position by position.",
  "testPeriod.steps.4": "We go through your numbers together and you leave with your gains.",
  "testPeriod.requirements.title": "What you need",
  "testPeriod.requirements.1": "A trainer, ideally a smart one.",
  "testPeriod.requirements.2": "A webcam or a USB camera.",
  "testPeriod.requirements.3": "A Mac or a Windows PC next to the bike.",
  "testPeriod.form.title": "Book your slot",
```

- [ ] **Step 3 : Écrire la page**

Créer `src/pages/[lang]/periode-test/index.astro` :

```astro
---
import type { GetStaticPaths } from 'astro';
import Layout from '~/layouts/PageLayout.astro';
import LeadForm from '~/components/widgets/LeadForm.astro';
import { SUPPORTED_LOCALES, type Locale, getDict, t } from '~/lib/i18n';

export const prerender = true;
export const getStaticPaths: GetStaticPaths = async () =>
  SUPPORTED_LOCALES.map((lang) => ({ params: { lang } }));

const lang = (Astro.params.lang as Locale) ?? 'fr';
const dict = getDict(lang);

const metadata = {
  title: t(dict, 'testPeriod.meta.title'),
  description: t(dict, 'testPeriod.meta.description'),
  robots: { index: true, follow: true },
  ignoreTitleTemplate: true,
};

const steps = ['1', '2', '3', '4'];
const requirements = ['1', '2', '3'];
---

<Layout metadata={metadata}>
  <section class="relative not-prose">
    <div class="mx-auto max-w-4xl px-4 md:px-6 py-16 md:py-20 text-center">
      <h1 class="text-4xl md:text-5xl font-bold tracking-tighter mb-4">{t(dict, 'testPeriod.title')}</h1>
      <p class="text-xl text-muted dark:text-slate-400">{t(dict, 'testPeriod.subtitle')}</p>
    </div>
  </section>

  <section class="relative not-prose">
    <div class="mx-auto max-w-4xl px-4 md:px-6 pb-12 grid gap-10 md:grid-cols-2">
      <div>
        <h2 class="text-2xl font-bold mb-4">{t(dict, 'testPeriod.steps.title')}</h2>
        <ol class="space-y-3">
          {steps.map((n) => (
            <li class="flex gap-3">
              <span class="shrink-0 w-7 h-7 rounded-full bg-primary text-white grid place-items-center text-sm font-bold">{n}</span>
              <span class="text-muted dark:text-slate-400">{t(dict, `testPeriod.steps.${n}`)}</span>
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h2 class="text-2xl font-bold mb-4">{t(dict, 'testPeriod.requirements.title')}</h2>
        <ul class="space-y-3 list-disc list-inside text-muted dark:text-slate-400">
          {requirements.map((n) => <li>{t(dict, `testPeriod.requirements.${n}`)}</li>)}
        </ul>
      </div>
    </div>
  </section>

  <section id="reservation" class="relative not-prose scroll-mt-[72px]">
    <div class="mx-auto max-w-3xl px-4 md:px-6 pb-20">
      <div class="p-6 md:p-10 rounded-2xl shadow-xl dark:shadow-none dark:border dark:border-slate-600">
        <h2 class="text-3xl font-bold tracking-tighter mb-8 text-center">{t(dict, 'testPeriod.form.title')}</h2>
        <LeadForm topic="test-period" />
      </div>
    </div>
  </section>
</Layout>
```

- [ ] **Step 4 : Vérifier le rendu dans le navigateur**

Run: `npm run dev` puis ouvrir `http://localhost:4321/fr/periode-test/`
Expected: la page s'affiche, le formulaire comporte les 6 cases de disponibilité, le champ home-trainer, les deux radios webcam. **Vérifier avec l'inspecteur que le champ `hp` est bien hors écran et non focusable.** Ouvrir aussi `/pt/periode-test/` : les textes doivent s'afficher **en anglais** (fallback de la Task 1), jamais sous forme de clés brutes.

- [ ] **Step 5 : Soumettre le formulaire pour de vrai**

Remplir et envoyer depuis `/fr/periode-test/`.
Expected: message de succès vert, abonné créé dans MailerLite (groupes `periode-test` + `AeroX Global - fr`, champs renseignés), email reçu.

- [ ] **Step 6 : Commit**

```bash
git add "src/pages/[lang]/periode-test/index.astro" src/locales/fr.json src/locales/en.json
git commit -m "feat periode-test : page de prise de rendez-vous"
```

---

### Task 9 : Migration de `/bike-fitting/` sur `LeadForm`

**Files:**
- Modify: `src/pages/[lang]/bike-fitting/index.astro:457-529`
- Delete: `src/pages/[lang]/bike-fitting/api/contact.ts`

**Interfaces:**
- Consumes: `LeadForm` (Task 7), la route `lead.ts` (Task 6).
- Produces: l'ancre `#contact-bf` reste en place — c'est elle que la carte B2B du plan Tarifs devra viser, **pas `#contact`** comme l'écrit la spec §6.2.

- [ ] **Step 1 : Importer le composant**

Dans `src/pages/[lang]/bike-fitting/index.astro`, ajouter à la liste des imports du frontmatter :

```astro
import LeadForm from '~/components/widgets/LeadForm.astro';
```

- [ ] **Step 2 : Remplacer le formulaire**

Remplacer le bloc `<form id="form-bf" …>…</form>` (de `<form` jusqu'à `</form>` inclus, aujourd'hui lignes 464-494) par :

```astro
        <LeadForm topic="bike-fitter" />
```

- [ ] **Step 3 : Supprimer le script de soumission devenu mort**

Supprimer intégralement le bloc `<script>` qui commence par `const form = document.getElementById('form-bf')` et se termine avant `<style>` (aujourd'hui lignes 500-529). `LeadForm.astro` embarque désormais son propre script.

- [ ] **Step 4 : Vérifier le rendu avant de supprimer l'ancienne route**

Run: `npm run dev` puis ouvrir `http://localhost:4321/fr/bike-fitting/#contact-bf`
Expected: le formulaire affiche nom, email, message et le bouton — **sans** les champs disponibilités / home-trainer / webcam, qui sont réservés au topic `test-period`. Soumettre : message de succès, abonné dans MailerLite groupes `bike-fitter` + `AeroX Global - fr`, avec `company: bike-fitter` et `last_name` **vide**.

- [ ] **Step 5 : Supprimer l'ancienne route**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
rm "src/pages/[lang]/bike-fitting/api/contact.ts"
grep -rn "bike-fitting/api/contact" src/ || echo "aucune référence résiduelle"
```

Expected: `aucune référence résiduelle`.

- [ ] **Step 6 : Vérifier**

Run: `npm run check && npm run build`
Expected: aucune erreur.

- [ ] **Step 7 : Commit**

```bash
git add "src/pages/[lang]/bike-fitting/index.astro"
git add -A "src/pages/[lang]/bike-fitting/api/"
git commit -m "refacto bike-fitting : migration sur LeadForm, suppression de la route contact"
```

---

### Task 10 : CTA unifié et purge du décompte hero

**Files:**
- Modify: `src/pages/[lang]/index.astro` (lignes 5, 68-76, 107, 428, 641, 693)
- Modify: `src/navigation.ts:69-81`
- Delete: `src/config/countdown.ts`
- Delete: `src/components/widgets/CountDown.astro`
- Modify: `src/locales/*.json` (les 9)

**Interfaces:**
- Consumes: la page `/{lang}/periode-test/` (Task 8).
- Produces: `cta.testPeriod.text` et `cta.testPeriod.subtext` — la paire unique utilisée partout.

**`CountDown.astro` et `countdown.ts` ne sont supprimés qu'au Step 7, une fois `Pricing.astro` purgé par le plan Tarifs.** Les supprimer maintenant casserait la compilation : `Pricing.astro:5-6` les importe encore.

- [ ] **Step 1 : Ajouter la paire de clés dans les 9 dictionnaires**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
python3 - <<'PY'
import json, collections
copy = {
  'fr': ("Programme ta période de test", "Séance accompagnée, sur rendez-vous"),
  'en': ("Book your test session", "Guided session, by appointment"),
  'pt': ("Agenda o teu período de teste", "Sessão acompanhada, com marcação"),
  'es': ("Programa tu período de prueba", "Sesión acompañada, con cita previa"),
  'it': ("Prenota il tuo periodo di prova", "Sessione guidata, su appuntamento"),
  'de': ("Plane deine Testphase", "Begleitete Session, nach Vereinbarung"),
  'nl': ("Plan je testperiode", "Begeleide sessie, op afspraak"),
  'ja': ("テスト期間を予約する", "予約制のサポート付きセッション"),
  'tr': ("Test dönemini planla", "Randevulu, eşlik edilen seans"),
}
for loc, (text, sub) in copy.items():
    path = f'src/locales/{loc}.json'
    d = json.load(open(path), object_pairs_hook=collections.OrderedDict)
    d['cta.testPeriod.text'] = text
    d['cta.testPeriod.subtext'] = sub
    json.dump(d, open(path, 'w'), ensure_ascii=False, indent=2)
    open(path, 'a').write('\n')
    print(loc, 'ok')
PY
```

Expected: neuf lignes `ok`.

- [ ] **Step 2 : Corriger le hero et son CTA**

Dans `src/pages/[lang]/index.astro`, remplacer le bloc `<Hero …>` d'ouverture (lignes 62-76) par :

```astro
  <Hero
    id="Accueil"
    tagline={t(dict, 'home.hero.tagline')}
    actions={[
      {
        variant: 'primary',
        text: t(dict, 'cta.testPeriod.text'),
        icon: 'tabler:calendar-event',
        subtext: t(dict, 'cta.testPeriod.subtext'),
        href: Link_testPeriod,
        target: '',
        seo: t(dict, 'home.hero.cta.seo'),
      },
    ]}
  >
```

Cela corrige au passage le bug décrit en tête de plan : `tagline` passe des enfants aux attributs, et cesse de s'afficher littéralement dans la page.

- [ ] **Step 3 : Remplacer la constante de lien**

Ligne 59, remplacer :

```astro
const Link_inscription = localizedHref(lang, '/inscription/inscription/');
```

par :

```astro
const Link_testPeriod = localizedHref(lang, '/periode-test/');
```

- [ ] **Step 4 : Supprimer le décompte du hero**

Supprimer le `<Fragment slot="content">` du hero (lignes 105-107) :

```astro
    <Fragment slot="content">
      {t(dict, 'home.hero.countdown.prefix')} <CountDown targetDate={new Date(COUNTDOWN_TARGET)} /> !
    </Fragment>
```

Supprimer aussi les deux imports devenus inutiles en tête de fichier :

```astro
import { COUNTDOWN_TARGET } from '~/config/countdown';
import CountDown from '~/components/widgets/CountDown.astro';
```

- [ ] **Step 5 : Unifier les trois CTA restants de la page**

Remplacer les trois occurrences restantes de `Link_inscription` et de leur texte :

- ligne ~428 (Testimonials) : `text: t(dict, 'home.testimonials.cta')` → `text: t(dict, 'cta.testPeriod.text')`, `href: Link_inscription` → `href: Link_testPeriod`
- ligne ~641 (StepsSansImage) : `t(dict, 'home.steps.cta')` → `t(dict, 'cta.testPeriod.text')`, même substitution de `href`
- ligne ~693 (FAQs) : `t(dict, 'home.faq.cta')` → `t(dict, 'cta.testPeriod.text')`, même substitution de `href`

Vérifier qu'il ne reste aucun `Link_inscription` :

```bash
grep -n "Link_inscription" "src/pages/[lang]/index.astro" || echo "aucune occurrence"
```

Expected: `aucune occurrence`. **Ne pas toucher à `home.leadmagnet.cta`** (ligne 253) : c'est le bouton du formulaire ebook.

- [ ] **Step 6 : Unifier le CTA de la navigation**

Dans `src/navigation.ts`, remplacer le bloc `actions` (lignes 69-81) par :

```ts
    actions: [
      {
        variant: 'primary',
        text: t('cta.testPeriod.text'),
        icon: 'tabler:calendar-event',
        href: withLang(lang, '/periode-test/'),
        target: '',
        subtext: t('cta.testPeriod.subtext'),
      },
    ],
```

- [ ] **Step 7 : Purger les clés mortes des 9 dictionnaires**

**À n'exécuter qu'après les Task 4 et Task 5 du plan Tarifs** : la Task 4 retire `pricing.remaining` de `Pricing.astro`, la Task 5 retire l'import `COUNTDOWN_TARGET` de `dashboard.astro:3`. Tant que le dashboard importe `~/config/countdown`, supprimer le fichier casse le build. Vérifier d'abord :

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
grep -rn "pricing.remaining\|CountDown\|COUNTDOWN" src/ || echo "plus aucun usage : purge autorisée"
```

Si et seulement si la sortie est `plus aucun usage : purge autorisée` :

```bash
python3 - <<'PY'
import json, collections, glob
dead = [
  'home.hero.cta.text', 'home.hero.cta.subtext', 'home.hero.countdown.prefix',
  'home.testimonials.cta', 'home.steps.cta', 'home.faq.cta',
  'nav.cta.mobile', 'nav.cta.desktop', 'nav.cta.subtext',
  'pricing.remaining',
]
for path in sorted(glob.glob('src/locales/*.json')):
    d = json.load(open(path), object_pairs_hook=collections.OrderedDict)
    removed = [k for k in dead if d.pop(k, None) is not None]
    json.dump(d, open(path, 'w'), ensure_ascii=False, indent=2)
    open(path, 'a').write('\n')
    print(path, '->', len(removed), 'clés retirées,', len(d), 'restantes')
PY
rm src/config/countdown.ts src/components/widgets/CountDown.astro
```

- [ ] **Step 8 : Vérifier qu'aucune clé supprimée n'est encore utilisée**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
for k in home.hero.cta.text home.hero.cta.subtext home.hero.countdown.prefix \
         home.testimonials.cta home.steps.cta home.faq.cta \
         nav.cta.mobile nav.cta.desktop nav.cta.subtext pricing.remaining; do
  hits=$(grep -rn "$k" src/ --include='*.astro' --include='*.ts' | grep -v '^src/locales/' | wc -l | tr -d ' ')
  [ "$hits" = "0" ] || echo "ENCORE UTILISÉE : $k ($hits)"
done
echo "contrôle terminé"
npm test && npm run check && npm run build
```

Expected: aucune ligne `ENCORE UTILISÉE`, puis tests, check et build verts.

- [ ] **Step 9 : Vérifier le rendu**

Ouvrir `http://localhost:4321/fr/` et contrôler :
- plus aucun décompte nulle part,
- le tagline s'affiche en haut du hero **sans** le préfixe littéral `tagline=`,
- les quatre CTA de la page et celui de la barre de navigation portent tous « Programme ta période de test » et mènent à `/fr/periode-test/`.

- [ ] **Step 10 : Commit**

```bash
git add -A src/pages src/navigation.ts src/locales src/config src/components
git commit -m "feat cta : message unique période de test, purge du décompte et des clés mortes"
```

---

### Task 11 : Réécriture des textes datés et de la mention « pionnier »

**Files:**
- Modify: `src/locales/*.json` (les 9)

**Interfaces:**
- Consumes: rien.
- Produces: rien pour les tâches suivantes.

**Trou de la spec comblé ici.** La spec §3 ne liste que `home.hero.tagline`, `home.hero.cta.subtext`, `nav.cta.subtext` et `home.leadmagnet.subtitle`. Le grep de contrôle qu'elle impose en §10 — « plus aucune occurrence de … *pionnier* » — échoue pourtant sur quatre clés supplémentaires, dont une particulièrement gênante :

```
home.features.ctaDetails = "Plus que <CountDown /> pour devenir pionniers AeroX et construire
                            <span class=\"font-bold text-accent\">le futur du cyclisme indoor !</span>"
```

Cette valeur est rendue par `index.astro:536` via `set:html`. **Elle contient la chaîne littérale `<CountDown />`**, qui n'est pas un composant à cet endroit mais une balise inconnue injectée dans le HTML : le navigateur l'avale sans rien afficher, et la phrase se lit « Plus que  pour devenir pionniers AeroX ». Le bug est antérieur à ce chantier ; il disparaît avec la réécriture.

- [ ] **Step 1 : Relever toutes les occurrences restantes**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
python3 - <<'INNER'
import json, glob
motifs = ['10 avril', 'pionnier', '01/12/2025', '01/11/2025', 'prioritaire', '<CountDown', 'pioneer', 'Pionnier']
for path in sorted(glob.glob('src/locales/*.json')):
    d = json.load(open(path))
    hits = [k for k, v in d.items() if isinstance(v, str) and any(m.lower() in v.lower() for m in motifs)]
    print(path, '->', len(hits), 'clés :', ', '.join(sorted(hits)))
INNER
```

Expected pour `fr.json` : `ourStory.cta.aria`, `ourStory.cta.label`, `home.hero.tagline`, `home.hero.cta.subtext`, `home.stats.pioneers`, `home.testimonials.cta`, `home.features.ctaDetails`, `home.leadmagnet.subtitle`, `nav.cta.subtext`, plus les clés `home.prices.*`. Les clés `home.hero.cta.subtext`, `home.testimonials.cta` et `nav.cta.subtext` disparaissent à la Task 10 Step 7 ; les `home.prices.*` à la Task 7 du plan Tarifs. **Restent cinq clés à réécrire ici.**

- [ ] **Step 2 : Réécrire les cinq clés dans les 9 dictionnaires**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
python3 - <<'INNER'
import json, collections

copy = {
 'fr': {
  'home.hero.tagline': "Mesure ton aéro chez toi",
  'home.leadmagnet.subtitle': "Inscris-toi et reçois le guide, plus les nouveautés AeroX.",
  'home.features.ctaDetails': 'Mesure tes positions et découvre <span class="font-bold text-accent">combien de watts tu laisses dans le vent.</span>',
  'ourStory.cta.label': "🚀 Découvre AeroX",
  'ourStory.cta.aria': "Découvrir les offres AeroX",
 },
 'en': {
  'home.hero.tagline': "Measure your aero at home",
  'home.leadmagnet.subtitle': "Sign up and get the guide, plus AeroX news.",
  'home.features.ctaDetails': 'Measure your positions and find out <span class="font-bold text-accent">how many watts you are leaving in the wind.</span>',
  'ourStory.cta.label': "🚀 Discover AeroX",
  'ourStory.cta.aria': "Discover the AeroX offers",
 },
 'pt': {
  'home.hero.tagline': "Mede a tua aerodinâmica em casa",
  'home.leadmagnet.subtitle': "Inscreve-te e recebe o guia, além das novidades AeroX.",
  'home.features.ctaDetails': 'Mede as tuas posições e descobre <span class="font-bold text-accent">quantos watts estás a perder no vento.</span>',
  'ourStory.cta.label': "🚀 Descobre a AeroX",
  'ourStory.cta.aria': "Descobrir as ofertas AeroX",
 },
 'es': {
  'home.hero.tagline': "Mide tu aerodinámica en casa",
  'home.leadmagnet.subtitle': "Apúntate y recibe la guía, además de las novedades de AeroX.",
  'home.features.ctaDetails': 'Mide tus posiciones y descubre <span class="font-bold text-accent">cuántos vatios estás dejando en el viento.</span>',
  'ourStory.cta.label': "🚀 Descubre AeroX",
  'ourStory.cta.aria': "Descubrir las ofertas de AeroX",
 },
 'it': {
  'home.hero.tagline': "Misura la tua aerodinamica a casa",
  'home.leadmagnet.subtitle': "Iscriviti e ricevi la guida, più le novità AeroX.",
  'home.features.ctaDetails': 'Misura le tue posizioni e scopri <span class="font-bold text-accent">quanti watt stai lasciando al vento.</span>',
  'ourStory.cta.label': "🚀 Scopri AeroX",
  'ourStory.cta.aria': "Scoprire le offerte AeroX",
 },
 'de': {
  'home.hero.tagline': "Miss deine Aerodynamik zu Hause",
  'home.leadmagnet.subtitle': "Melde dich an und erhalte den Guide sowie die AeroX-Neuigkeiten.",
  'home.features.ctaDetails': 'Miss deine Positionen und finde heraus, <span class="font-bold text-accent">wie viele Watt du im Wind lässt.</span>',
  'ourStory.cta.label': "🚀 Entdecke AeroX",
  'ourStory.cta.aria': "Die AeroX-Angebote entdecken",
 },
 'nl': {
  'home.hero.tagline': "Meet je aerodynamica thuis",
  'home.leadmagnet.subtitle': "Schrijf je in en ontvang de gids, plus het AeroX-nieuws.",
  'home.features.ctaDetails': 'Meet je posities en ontdek <span class="font-bold text-accent">hoeveel watt je in de wind laat.</span>',
  'ourStory.cta.label': "🚀 Ontdek AeroX",
  'ourStory.cta.aria': "De AeroX-aanbiedingen ontdekken",
 },
 'ja': {
  'home.hero.tagline': "自宅でエアロを測定",
  'home.leadmagnet.subtitle': "登録してガイドとAeroXの最新情報を受け取ろう。",
  'home.features.ctaDetails': 'ポジションを測定して、<span class="font-bold text-accent">風に捨てているワット数</span>を知ろう。',
  'ourStory.cta.label': "🚀 AeroXを見る",
  'ourStory.cta.aria': "AeroXのオファーを見る",
 },
 'tr': {
  'home.hero.tagline': "Aerodinamiğini evde ölç",
  'home.leadmagnet.subtitle': "Kaydol, rehberi ve AeroX haberlerini al.",
  'home.features.ctaDetails': 'Pozisyonlarını ölç ve <span class="font-bold text-accent">rüzgârda kaç watt bıraktığını</span> öğren.',
  'ourStory.cta.label': "🚀 AeroX'i keşfet",
  'ourStory.cta.aria': "AeroX tekliflerini keşfet",
 },
}

for loc, pairs in copy.items():
    path = f'src/locales/{loc}.json'
    d = json.load(open(path), object_pairs_hook=collections.OrderedDict)
    changed = 0
    for k, v in pairs.items():
        if k in d:
            d[k] = v
            changed += 1
        else:
            print(f'  ATTENTION {loc} : clé absente {k}')
    json.dump(d, open(path, 'w'), ensure_ascii=False, indent=2)
    open(path, 'a').write('\n')
    print(loc, '->', changed, 'clés réécrites')
INNER
```

Expected: neuf lignes `-> 5 clés réécrites`, aucune ligne `ATTENTION`.

- [ ] **Step 3 : Décider du sort de `home.stats.pioneers`**

Cette clé vaut `"Pionniers"` et sert de libellé à un compteur de la section statistiques : c'est un fait, pas une offre datée. La spec ne la liste pas. Vérifier son rendu sur `/fr/` et la laisser telle quelle si elle a toujours du sens ; sinon la remplacer par `"Utilisateurs"` / `"Users"` dans les 9 dictionnaires selon le même procédé qu'au Step 2. **Décision à prendre, pas à subir.**

- [ ] **Step 4 : Contrôler le résultat**

```bash
cd ~/SiteAeroX/aerox_on_astro/aerox-astro
python3 - <<'INNER'
import json, glob
motifs = ['10 avril', '01/12/2025', '01/11/2025', '<CountDown', 'prioritaire']
reste = 0
for path in sorted(glob.glob('src/locales/*.json')):
    d = json.load(open(path))
    hits = [k for k, v in d.items() if isinstance(v, str) and any(m.lower() in v.lower() for m in motifs)]
    hits = [k for k in hits if not k.startswith('home.prices.')]
    if hits:
        reste += len(hits)
        print(path, '->', hits)
print('RESTE', reste, 'occurrence(s) hors home.prices.*')
INNER
```

Expected: `RESTE 0 occurrence(s) hors home.prices.*`.

- [ ] **Step 5 : Vérifier le rendu**

Run: `npm run dev`, ouvrir `http://localhost:4321/fr/`.
Expected: le tagline du hero se lit « Mesure ton aéro chez toi », et la phrase de `ctaDetails` se lit en entier — **plus de trou là où se trouvait `<CountDown />`**.

- [ ] **Step 6 : Vérifier et commiter**

```bash
npm test && npm run check && npm run build
git add src/locales
git commit -m "copy : retrait des mentions datées et du décompte résiduel dans les dictionnaires"
```

---

## Vérification finale du plan

- [ ] `npm test` — tous les tests passent
- [ ] `npm run check` — astro check, eslint, prettier
- [ ] `npm run build` — build complet
- [ ] `grep -rn "CountDown\|COUNTDOWN\|10 avril" src/` — aucune occurrence hors `DeviensPionnier.astro` et `paiement.astro`, traités par le plan Tarifs
- [ ] `grep -rni "pionnier" src/` — ne subsistent que `home.stats.pioneers` si elle a été conservée sciemment (Task 11 Step 3) et les clés `home.prices.*` purgées par le plan Tarifs
- [ ] Les neuf locales rendent `/{lang}/periode-test/` sans clé brute à l'écran
