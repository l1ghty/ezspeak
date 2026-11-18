#!/bin/sh
# coturn launcher: reads the shared secret and builds the flag list from env.
set -eu
SECRET_FILE="${SECRETS_DIR:-/secrets}/turn_secret"
[ -s "$SECRET_FILE" ] || { echo "coturn: $SECRET_FILE missing" >&2; exit 1; }

set -- \
  -n --log-file=stdout --simple-log \
  --listening-port="${TURN_PORT:-3478}" \
  --min-port="${TURN_MIN_PORT:-49160}" --max-port="${TURN_MAX_PORT:-49200}" \
  --realm="${TURN_REALM:-ezspeak}" \
  --fingerprint --use-auth-secret --static-auth-secret="$(cat "$SECRET_FILE")" \
  --total-quota="${TURN_TOTAL_QUOTA:-1000}" \
  --user-quota="${TURN_USER_QUOTA:-30}" \
  --max-bps="${TURN_MAX_BPS:-500000}" \
  --stale-nonce=600 \
  --no-cli --no-tls --no-dtls --no-multicast-peers \
  --no-tcp-relay --no-software-attribute

# Public IP when the host is behind NAT ("auto" asks a public service).
case "${TURN_EXTERNAL_IP:-}" in
  "") ;;
  auto) set -- "$@" --external-ip="$(detect-external-ip)" ;;
  *) set -- "$@" --external-ip="$TURN_EXTERNAL_IP" ;;
esac

# Never relay into private networks (protects the host's LAN and cloud
# metadata endpoints) — unless explicitly allowed for LAN/local setups.
case "${TURN_ALLOW_LAN:-false}" in
  1|true|yes|on) set -- "$@" --allow-loopback-peers ;;
  *)
    for r in 0.0.0.0-0.255.255.255 10.0.0.0-10.255.255.255 100.64.0.0-100.127.255.255 \
             127.0.0.0-127.255.255.255 169.254.0.0-169.254.255.255 172.16.0.0-172.31.255.255 \
             192.168.0.0-192.168.255.255 ::1 fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
             fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff; do
      set -- "$@" --denied-peer-ip="$r"
    done ;;
esac

exec turnserver "$@"
