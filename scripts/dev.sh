#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Check required env files ──
BACKEND_ENV="$ROOT/apps/backend/.env"
WEB_ENV="$ROOT/apps/web/.env"

if [ ! -f "$BACKEND_ENV" ]; then
  echo "==> Creating apps/backend/.env from .env.example"
  cp "$ROOT/apps/backend/.env.example" "$BACKEND_ENV"
  echo ""
  echo "   ⚠  Edit $BACKEND_ENV and set:"
  echo "      - ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"
  echo "      - BACKEND_AUTH_TOKEN (any random string)"
  echo ""
fi

if [ ! -f "$WEB_ENV" ]; then
  echo "==> Creating apps/web/.env from .env.example"
  cp "$ROOT/apps/web/.env.example" "$WEB_ENV"
  echo ""
  echo "   ⚠  Edit $WEB_ENV and set:"
  echo "      - BACKEND_AUTH_TOKEN (same as backend)"
  echo "      - SESSION_SECRET  (any random string, e.g. openssl rand -hex 32)"
  echo ""
fi

# ── Validate required vars ──
set -a
[ -f "$BACKEND_ENV" ] && . "$BACKEND_ENV"
set +a

API_KEY="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-}}"
if [ -z "$API_KEY" ]; then
  echo "ERROR: ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is not set. Edit $BACKEND_ENV"
  exit 1
fi

if [ -z "${BACKEND_AUTH_TOKEN:-}" ] || [ "$BACKEND_AUTH_TOKEN" = "dev-token" ]; then
  echo "WARN: BACKEND_AUTH_TOKEN is 'dev-token' (default). Consider using a random value."
fi

# ── Portable: find pids listening on a TCP port (macOS lsof, Linux ss/awk) ──
find_pids_on_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp "sport = :$port" 2>/dev/null | awk -F'pid=' '{if(NF>1){split($2,a,","); print a[1]}}'
  else
    lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null
  fi
}

# ── Cleanup stale ports ──
echo ""
echo "==> Killing any leftover processes on ports 3000/3001..."
for port in 3000 3001; do
  pids=$(find_pids_on_port "$port") || true
  if [ -n "$pids" ]; then
    echo "   Killing pid(s) $pids on port $port"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
done
sleep 0.5

# ── Cleanup handler ──
cleanup() {
  echo ""
  echo "==> Shutting down..."

  [ -n "${BACKEND_PID:-}" ] && kill -TERM "$BACKEND_PID" 2>/dev/null || true
  [ -n "${WEB_PID:-}" ] && kill -TERM "$WEB_PID" 2>/dev/null || true

  # Backend and web are direct children; terminate them in order.
  wait "$BACKEND_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true

  for port in 3000 3001; do
    find_pids_on_port "$port" \
      | sort -u \
      | xargs kill -9 2>/dev/null || true
  done

  echo "   Done."
  exit 0
}
trap cleanup INT TERM

echo "==> Starting backend (port 3000) + web (port 3001)..."
echo "    Login at http://localhost:3001/login"
echo "    Default password: admin"
echo ""

# Start as direct children of this script (no bun run wrapper).
# Coding Agent runs are spawned by the backend per Agent Run — nothing else
# needs to be started separately.
cd "$ROOT"
bun run --cwd apps/backend dev &
BACKEND_PID=$!
bun run --cwd apps/web dev &
WEB_PID=$!

echo "   backend PID=$BACKEND_PID  web PID=$WEB_PID"
echo "   Press Ctrl+C to stop both."
echo ""

wait
