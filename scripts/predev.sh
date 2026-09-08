#!/usr/bin/env bash
set -euo pipefail

# ── predev bootstrap ────────────────────────────────────────────────────────
# Idempotent one-time-per-machine setup that runs before any `bun run dev*`.
#   1. Generate the gitignored drizzle migrations if any DB is missing them.
#   2. Create apps/{backend,web}/.env from .env.example if missing.
#   3. Auto-generate secrets (SESSION_SECRET, BACKEND_AUTH_TOKEN,
#      MOCK_PASSWORD) so dev never ships the documented defaults (M16).
#   4. Lock .env files to owner-only.
# Safe to run repeatedly: every step is guarded and only acts when needed.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── 1. Drizzle migrations (gitignored, regenerated per machine) ──
JOURNALS=(
  "$ROOT/apps/backend/drizzle/backend/meta/_journal.json"
  "$ROOT/apps/lark-bot/drizzle/meta/_journal.json"
)

missing_migrations=0
for j in "${JOURNALS[@]}"; do
  if [ ! -f "$j" ]; then
    missing_migrations=1
    break
  fi
done

if [ "$missing_migrations" -eq 1 ]; then
  echo "==> Drizzle migrations missing — generating (scripts/gen-drizzle.sh)..."
  bash "$ROOT/scripts/gen-drizzle.sh"
fi

# ── 2. .env files from .env.example ──
BACKEND_ENV="$ROOT/apps/backend/.env"
WEB_ENV="$ROOT/apps/web/.env"
if [ ! -f "$BACKEND_ENV" ]; then
  echo "==> Creating apps/backend/.env from .env.example"
  cp "$ROOT/apps/backend/.env.example" "$BACKEND_ENV"
  echo "   ⚠  Edit $BACKEND_ENV and set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN."
fi

if [ ! -f "$WEB_ENV" ]; then
  echo "==> Creating apps/web/.env from .env.example"
  cp "$ROOT/apps/web/.env.example" "$WEB_ENV"
fi

# ── 3. Auto-generate secret-shaped values that are empty OR still the
# documented example defaults (M16: dev-token / admin are one-guess
# credentials once the backend leaves loopback).
regen_secret() {
  local file="$1" key="$2" default="$3"
  local current
  current="$(grep -E "^${key}=" "$file" 2>/dev/null | head -n1 | sed -E "s/^${key}=//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//" || true)"
  if [ -n "$current" ] && [ "$current" != "$default" ]; then
    return 0
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: $key is unset/default in $file and openssl is unavailable to generate one." >&2
    exit 1
  fi
  local secret
  secret="$(openssl rand -hex 24)"
  if grep -qE "^${key}=" "$file"; then
    local tmp
    tmp="$(mktemp)"
    sed -E "s|^${key}=.*$|${key}=${secret}|" "$file" >"$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$secret" >>"$file"
  fi
  echo "==> Generated $key in $file"
}

# BACKEND_AUTH_TOKEN is shared by backend + web BFF: generate it ONCE (in
# the backend env) and mirror the SAME value into web/.env — regenerating
# per file would desync the pair and the BFF would 401.
if [ -f "$BACKEND_ENV" ]; then
  regen_secret "$BACKEND_ENV" "BACKEND_AUTH_TOKEN" "dev-token"
  if [ -f "$WEB_ENV" ]; then
    token="$(grep -E '^BACKEND_AUTH_TOKEN=' "$BACKEND_ENV" | head -n1 | sed -E 's/^BACKEND_AUTH_TOKEN=//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//')"
    if grep -qE '^BACKEND_AUTH_TOKEN=' "$WEB_ENV"; then
      tmp="$(mktemp)"
      sed -E "s|^BACKEND_AUTH_TOKEN=.*$|BACKEND_AUTH_TOKEN=${token}|" "$WEB_ENV" >"$tmp"
      mv "$tmp" "$WEB_ENV"
    else
      printf 'BACKEND_AUTH_TOKEN=%s\n' "$token" >>"$WEB_ENV"
    fi
    echo "==> Mirrored BACKEND_AUTH_TOKEN into apps/web/.env"
  fi
fi

if [ -f "$WEB_ENV" ]; then
  regen_secret "$WEB_ENV" "SESSION_SECRET" ""
  regen_secret "$WEB_ENV" "MOCK_PASSWORD" "admin"
  chmod 600 "$WEB_ENV"
fi
