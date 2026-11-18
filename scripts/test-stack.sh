#!/bin/sh
# Builds and starts the real docker compose stack (ezspeak + coturn) on
# side ports, runs the relay E2E tests against it, then tears it down.
set -eu
cd "$(dirname "$0")/.."

PROJECT=ezspeak-e2e
export EZSPEAK_PORT="${EZSPEAK_PORT:-3112}"
export TURN_PORT="${TURN_PORT:-3479}"
export TURN_MIN_PORT="${TURN_MIN_PORT:-49210}"
export TURN_MAX_PORT="${TURN_MAX_PORT:-49250}"
export TURN_ALLOW_LAN=true          # peers are on this machine
export MAX_CONNECTIONS_PER_IP=200 MAX_SERVERS_PER_IP=200 CONNECT_RATE_PER_IP=1000
export STUN_URLS=""                 # relay or nothing

cleanup() { docker compose -p "$PROJECT" down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker compose -p "$PROJECT" up -d --build
URL="http://127.0.0.1:$EZSPEAK_PORT"
i=0
until wget -qO- "$URL/health" >/dev/null 2>&1 || curl -fs "$URL/health" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { docker compose -p "$PROJECT" logs; echo "stack did not become healthy" >&2; exit 1; }
  sleep 1
done

E2E_STACK_URL="$URL" npx playwright test tests/e2e/stack.spec.mjs "$@"
