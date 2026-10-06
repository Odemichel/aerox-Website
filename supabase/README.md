# Base Supabase AeroX — source unique

Le projet Supabase `agvksgrjqskpetokudda` est partagé par **toutes** les applications AeroX :
le site (ce dépôt), l'app desktop (`veloaero`), l'app mobile (`aerox-mycompanion`) et le CRM privé (`aerox-crm`).
**Ce dossier est le seul endroit où l'on modifie la base.** Les autres dépôts n'ont plus de dossier `supabase/`.

## Règle

1. Toute modification de la base (table, colonne, règle d'accès, fonction, déclencheur) est un **fichier** dans
   `migrations/`, nommé `AAAAMMJJhhmmss_description.sql`, avant d'être appliquée.
2. Rien n'est modifié « à la main » dans le tableau de bord Supabase, ni appliqué directement sans fichier.
3. Un changement qui touche des données sensibles (rôles, facturation, CRM) a son test dans `tests/`.

## Contenu

| Dossier                               | Rôle                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema/2026-10-06_schema_public.sql` | **Instantané du schéma réel de production** (pg_dump, schéma `public`, sans données) au 06/10/2026. Référence de départ : avant cette date, une vingtaine de modifications avaient été appliquées sans fichier. |
| `migrations/`                         | Migrations écrites depuis ce dépôt (facturation bike fitter, compteur CdA, CRM, garde du rôle…). Ce sont celles que rejouent les tests.                                                                         |
| `tests/`                              | Tests SQL. `bash tests/run.sh` (Docker) ou PGlite.                                                                                                                                                              |
| `functions/`                          | Fonctions serveur (Edge Functions) déployées.                                                                                                                                                                   |
| `archive/desktop/`                    | Migrations, tests et instantané d'avril 2026 venus de l'app desktop, **déjà appliqués**, conservés pour l'historique. Ne pas les rejouer.                                                                       |

## Refaire un instantané du schéma

Sans Docker, avec `pg_dump` (libpq) et un accès temporaire en lecture seule fourni par l'API Supabase
(`POST /v1/projects/<ref>/cli/login-role` avec `{"read_only": true}`, valable 5 minutes) :

```
pg_dump -h db.agvksgrjqskpetokudda.supabase.co -U <role> --role=supabase_read_only_user \
  -d postgres --schema-only --schema=public --no-owner -f schema/AAAA-MM-JJ_schema_public.sql
```

Vérifier ensuite qu'aucun secret n'y figure (seule la clé publique `anon` est attendue).
