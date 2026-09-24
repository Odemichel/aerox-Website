#!/usr/bin/env bash
# Applique la migration bf_billing dans un Postgres jetable et joue les tests.
#   bash supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=aerox-billing-test
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=pg postgres:17-alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null' EXIT
until docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; do sleep 0.5; done
sleep 1
run() { docker exec -i "$NAME" psql -q -v ON_ERROR_STOP=1 -U postgres "$@"; }
run < tests/stubs.sql
for f in migrations/*.sql; do run --single-transaction < "$f"; done
run -o /dev/null < tests/bf_billing.test.sql
echo "OK — tous les tests SQL passent"
