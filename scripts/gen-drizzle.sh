#!/bin/bash
set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# CI verification: check that committed drizzle migrations match schema.
# We don't run `drizzle-kit generate` in CI because it requires interactive
# TTY for conflict resolution. Instead, we verify that backend and lark-bot
# have no pending changes.
#
# To regenerate migrations locally, run this script on a TTY.

cd "$REPO_ROOT/apps/backend"
bunx drizzle-kit generate --config drizzle.backend.config.ts

cd "$REPO_ROOT/apps/lark-bot"
bunx drizzle-kit generate

cd "$REPO_ROOT"

# Check for uncommitted changes in drizzle directories
if [ -n "$(git status --porcelain apps/backend/drizzle/ apps/lark-bot/drizzle/ 2>/dev/null)" ]; then
  echo "ERROR: drizzle migration files are out of date."
  echo "Schema changed but migrations were not regenerated."
  echo "Run 'bash scripts/gen-drizzle.sh' locally and commit the changes."
  git status --porcelain apps/backend/drizzle/ apps/lark-bot/drizzle/ 2>/dev/null
  exit 1
fi

echo "All drizzle migrations are up to date."
