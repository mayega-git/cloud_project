#!/usr/bin/env bash
# Reproducible local CI: locked install, typecheck/build, unit tests, Compose
# validation, image builds, migrations (twice), and integration tests against
# a throwaway stack. Touches neither application/.env contents nor
# application/.secrets, and uses its own Compose project name.
#
# Usage: bash ci-local.sh [--skip-docker] [--keep] [--local-db] [--no-build]
#   --skip-docker  only run the Node steps
#   --keep         leave the throwaway stack and temp files in place
#   --local-db     reuse the running development PostgreSQL (database ci_test,
#                  created and dropped here) instead of starting a new one
#   --no-build     reuse existing cloud-project-* images instead of building
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
skip_docker=0
keep=0
local_db=0
no_build=0
for arg in "$@"; do
  case "$arg" in
    --skip-docker) skip_docker=1 ;;
    --keep) keep=1 ;;
    --local-db) local_db=1 ;;
    --no-build) no_build=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

step "Node steps (backend)"
cd "$app_dir/backend"
npm ci
npm run build
npm test

if [[ "$skip_docker" == 1 ]]; then
  echo "Docker steps skipped."
  exit 0
fi

tmp="$(mktemp -d)"
project="ci-local"
dev_db_container="${DEV_DB_CONTAINER:-deployment-postgres-1}"
export SECRETS_DIR="$tmp/secrets"
env_file="$tmp/ci.env"
compose_files=(-f "$app_dir/deployment/compose.yaml" -f "$app_dir/deployment/compose.ci.yaml")
if [[ "$local_db" == 1 ]]; then
  compose_files+=(-f "$app_dir/deployment/compose.localdb.yaml")
fi
compose=(docker compose -p "$project" --env-file "$env_file" "${compose_files[@]}")

drop_test_db() {
  docker exec "$dev_db_container" psql -U etherpad -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE IF EXISTS ci_test WITH (FORCE)' >/dev/null
}

cleanup() {
  status=$?
  if [[ "$status" != 0 ]]; then
    echo "--- CI failed (exit $status); last container logs ---" >&2
    "${compose[@]}" logs --tail=40 2>&1 || true
  fi
  if [[ "$keep" == 1 ]]; then
    echo "Kept stack '$project' and $tmp"
  else
    if [[ "$local_db" == 1 ]]; then
      drop_test_db || true
      docker network disconnect -f "${project}_default" "$dev_db_container" >/dev/null 2>&1 || true
    fi
    "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$tmp"
  fi
  exit "$status"
}
trap cleanup EXIT

step "Generating throwaway secrets"
umask 077
mkdir -p "$SECRETS_DIR"
for name in APIKEY INTERNAL_KEY BETTER_AUTH_SECRET; do
  openssl rand -hex 32 > "$SECRETS_DIR/$name.txt"
done
chmod 755 "$SECRETS_DIR"
chmod 644 "$SECRETS_DIR"/*.txt
if [[ "$local_db" == 1 ]]; then
  # The existing instance keeps its own password; read it without printing it.
  db_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$app_dir/.env" | head -1)"
  [[ -n "$db_password" ]] || { echo "POSTGRES_PASSWORD missing in application/.env" >&2; exit 1; }
else
  db_password="$(openssl rand -hex 24)"
fi
printf 'POSTGRES_PASSWORD=%s\nETHERPAD_ADMIN_PASSWORD=%s\n' \
  "$db_password" "$(openssl rand -hex 24)" > "$env_file"

step "Validating Compose configuration"
"${compose[@]}" config --quiet

if [[ "$no_build" == 1 ]]; then
  step "Reusing existing images (no build)"
  docker image inspect cloud-project-backend:local cloud-project-etherpad:3.3.6-business >/dev/null
else
  step "Building images"
  "${compose[@]}" build
fi

if [[ "$local_db" == 1 ]]; then
  step "Creating empty database ci_test in the running PostgreSQL"
  # Create the CI network, then let the existing instance join it under a unique alias.
  "${compose[@]}" create --no-build
  docker network connect --alias ci-devdb "${project}_default" "$dev_db_container"
  drop_test_db
  docker exec "$dev_db_container" psql -U etherpad -d postgres -v ON_ERROR_STOP=1 \
    -c 'CREATE DATABASE ci_test' >/dev/null
else
  step "Starting a throwaway PostgreSQL"
  "${compose[@]}" up -d --wait postgres
fi

step "Applying migrations twice (idempotence)"
"${compose[@]}" run --rm --no-deps backend node dist/database.js
"${compose[@]}" run --rm --no-deps backend node dist/database.js

step "Starting the full stack"
"${compose[@]}" up -d --no-build

wait_for() { # wait_for <description> <node expression exiting 0 when ready>
  local what="$1" expr="$2"
  for _ in $(seq 1 90); do
    if "${compose[@]}" exec -T backend node -e "$expr" >/dev/null 2>&1; then
      echo "$what: ready"
      return 0
    fi
    sleep 2
  done
  echo "$what: not ready after 180s" >&2
  return 1
}
wait_for backend \
  "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Any HTTP answer proves Etherpad accepts connections (it requires auth).
wait_for etherpad \
  "fetch('http://etherpad:9001/').then(()=>process.exit(0)).catch(()=>process.exit(1))"

step "Integration tests (business, invitations, downloads and credit)"
"${compose[@]}" run --rm --no-deps \
  -e RUN_INTEGRATION=1 -e BUSINESS_BASE_URL=http://backend:3000 \
  backend node --test dist/domain/business.integration.test.js dist/domain/invitation.integration.test.js dist/domain/downloads.integration.test.js

step "CI local: all steps passed"
