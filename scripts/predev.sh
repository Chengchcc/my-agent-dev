#!/usr/bin/env bash
set -euo pipefail

# ── predev bootstrap ────────────────────────────────────────────────────────
# Idempotent one-time-per-machine setup that runs before any `bun run dev*`.
#   1. Generate the gitignored drizzle migrations if any DB is missing them.
#   2. Create apps/{backend,web}/.env from .env.example if missing.
#   3. Auto-generate SESSION_SECRET (web) so dev login works out of the box.
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

# ── 3. Auto-generate SESSION_SECRET in apps/web/.env if empty ──
if [ -f "$WEB_ENV" ]; then
  current_secret="$(grep -E '^SESSION_SECRET=' "$WEB_ENV" 2>/dev/null | head -n1 | sed -E 's/^SESSION_SECRET=//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//' || true)"
  if [ -z "$current_secret" ]; then
    if ! command -v openssl >/dev/null 2>&1; then
      echo "ERROR: SESSION_SECRET is empty in $WEB_ENV and openssl is unavailable to generate one." >&2
      exit 1
    fi
    secret="$(openssl rand -hex 32)"
    if grep -qE '^SESSION_SECRET=' "$WEB_ENV"; then
      tmp="$(mktemp)"
      sed -E "s|^SESSION_SECRET=.*$|SESSION_SECRET=${secret}|" "$WEB_ENV" >"$tmp"
      mv "$tmp" "$WEB_ENV"
    else
      printf 'SESSION_SECRET=%s\n' "$secret" >>"$WEB_ENV"
    fi
    echo "==> Generated SESSION_SECRET in apps/web/.env"
  fi
fi
