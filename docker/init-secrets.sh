#!/bin/sh
# Creates the shared TURN secret once (persisted in the `secrets` volume).
# An explicit TURN_SECRET always wins and replaces the stored one.
set -eu
FILE="${SECRETS_DIR:-/secrets}/turn_secret"
TMP="$FILE.tmp.$$"
umask 022

write() {  # atomic replace; works even though the stored file is read-only
  printf '%s' "$1" > "$TMP"
  chmod 0444 "$TMP"
  mv -f "$TMP" "$FILE"
}

if [ -n "${TURN_SECRET:-}" ]; then
  write "$TURN_SECRET"
  echo "init: using TURN_SECRET from environment"
elif [ ! -s "$FILE" ]; then
  write "$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  echo "init: generated new TURN secret"
else
  echo "init: keeping existing TURN secret"
fi
