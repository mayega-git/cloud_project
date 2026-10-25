#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
umask 077
mkdir -p "$app_dir/.secrets"

if [[ ! -f "$app_dir/.secrets/APIKEY.txt" ]]; then
  openssl rand -hex 32 > "$app_dir/.secrets/APIKEY.txt"
fi
if [[ ! -f "$app_dir/.secrets/INTERNAL_KEY.txt" ]]; then
  openssl rand -hex 32 > "$app_dir/.secrets/INTERNAL_KEY.txt"
fi
if [[ ! -f "$app_dir/.secrets/BETTER_AUTH_SECRET.txt" ]]; then
  openssl rand -hex 32 > "$app_dir/.secrets/BETTER_AUTH_SECRET.txt"
fi

if [[ ! -f "$app_dir/.env" ]]; then
  postgres_password="$(openssl rand -hex 24)"
  etherpad_admin_password="$(openssl rand -hex 24)"
  cat > "$app_dir/.env" <<EOF
PORT=3000
ETHERPAD_API_URL=http://127.0.0.1:9001
ETHERPAD_PUBLIC_URL=http://127.0.0.1:9001
ETHERPAD_API_KEY_FILE=../.secrets/APIKEY.txt
POSTGRES_PASSWORD=$postgres_password
ETHERPAD_ADMIN_PASSWORD=$etherpad_admin_password
APP_ENV=local
HOST=127.0.0.1
DATABASE_URL=postgresql://etherpad:$postgres_password@127.0.0.1:5432/etherpad
INTERNAL_KEY_FILE=../.secrets/INTERNAL_KEY.txt
EOF
fi

# Preserve an existing local file while adding variables introduced after v0.2.
if ! grep -q '^INTERNAL_KEY_FILE=' "$app_dir/.env"; then
  printf '%s\n' 'INTERNAL_KEY_FILE=../.secrets/INTERNAL_KEY.txt' >> "$app_dir/.env"
fi
if ! grep -q '^APP_ENV=' "$app_dir/.env"; then
  printf '%s\n' 'APP_ENV=local' >> "$app_dir/.env"
fi
if ! grep -q '^HOST=' "$app_dir/.env"; then
  printf '%s\n' 'HOST=127.0.0.1' >> "$app_dir/.env"
fi
if ! grep -q '^DATABASE_URL=' "$app_dir/.env"; then
  postgres_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$app_dir/.env" | head -1)"
  printf 'DATABASE_URL=postgresql://etherpad:%s@127.0.0.1:5432/etherpad\n' "$postgres_password" >> "$app_dir/.env"
fi
if ! grep -q '^BETTER_AUTH_SECRET_FILE=' "$app_dir/.env"; then
  printf '%s\n' 'BETTER_AUTH_SECRET_FILE=../.secrets/BETTER_AUTH_SECRET.txt' >> "$app_dir/.env"
fi
if ! grep -q '^AUTH_BASE_URL=' "$app_dir/.env"; then
  printf '%s\n' 'AUTH_BASE_URL=http://127.0.0.1:3000' >> "$app_dir/.env"
fi

printf 'Local configuration prepared in application/.env and application/.secrets/.\n'
