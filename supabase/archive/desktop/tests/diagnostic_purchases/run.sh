#!/usr/bin/env bash
# Applique les migrations du droit au diagnostic dans un Postgres jetable et
# joue les scénarios d'usage et d'attaque.
#   bash supabase/tests/diagnostic_purchases/run.sh
set -euo pipefail
cd "$(dirname "$0")"
NAME=aerox-diag-purchases-test
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=pg postgres:17-alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null' EXIT
until docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; do sleep 0.5; done
sleep 1
run() { docker exec -i "$NAME" psql -q -v ON_ERROR_STOP=1 -U postgres "$@"; }
run < stubs.sql
run --single-transaction < ../../migrations/20260924_diagnostic_purchases.sql
run --single-transaction < ../../migrations/20260924_drop_users_diagnostic_basic_paid.sql
run --single-transaction < ../../migrations/20260929_diagnostic_admin_test_controls.sql
run -o /dev/null < diagnostic_purchases.test.sql
