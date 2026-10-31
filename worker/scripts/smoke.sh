#!/usr/bin/env bash
#
# Post-deploy smoke test: the three things a Worker deployment must keep serving.
#
#   /        the landing page, from the assets directory
#   /admin/  the console shell, also from assets
#   /source  the AGPL-3.0 §13 offer, a redirect to the repository
#
# It deliberately needs no credential: it proves the deploy reached the edge and
# carried its assets, not that any particular account works. The authenticated
# checks are `dakflare doctor`.
#
#   ./worker/scripts/smoke.sh https://example.workers.dev
#
set -euo pipefail

base="${1:?usage: smoke.sh <worker-url>}"
base="${base%/}"

fail() {
  echo "FAIL $1" >&2
  exit 1
}

status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$base$1"
}

# A deploy that loses its assets answers 200 with the Worker's own 404 body, so
# the landing page is measured by size as well as status.
code="$(status /)"
[ "$code" = "200" ] || fail "/ -> $code (want 200)"
bytes="$(curl -sS --max-time 20 "$base/" | wc -c)"
[ "$bytes" -gt 1000 ] || fail "/ -> $bytes bytes (the assets directory did not deploy)"
echo "ok  /       200, $bytes bytes"

code="$(status /admin/)"
[ "$code" = "200" ] || fail "/admin/ -> $code (want 200)"
echo "ok  /admin/ 200"

# No -L: the redirect itself is the contract.
code="$(status /source)"
[ "$code" = "302" ] || fail "/source -> $code (want 302)"
echo "ok  /source 302"

echo "smoke: 3/3"
