#!/usr/bin/env bash
# TST-007 (Phase 16, Wave 11, Stream C): start the production builds of
# the api + dashboard apps for Playwright's webServer hook.
# Requires the builds to exist (`build:server` for both apps) and the
# environment to be exported (DATABASE_URL, BETTER_AUTH_SECRET,
# BETTER_AUTH_URL, NEXT_PUBLIC_* — see .env.example). Ports come from
# E2E_API_PORT / E2E_DASHBOARD_PORT (defaults 3001 / 3002).
set -euo pipefail

API_PORT="${E2E_API_PORT:-3001}"
DASHBOARD_PORT="${E2E_DASHBOARD_PORT:-3002}"

cd "$(dirname "$0")/.."

pnpm --filter @sendcms/api exec next start -p "$API_PORT" &
API_PID=$!
pnpm --filter @sendcms/dashboard exec next start -p "$DASHBOARD_PORT" &
DASHBOARD_PID=$!

trap 'kill $API_PID $DASHBOARD_PID 2>/dev/null || true' EXIT

# Playwright waits on the dashboard /sign-in URL itself; keep the
# servers alive until it kills this process.
wait
