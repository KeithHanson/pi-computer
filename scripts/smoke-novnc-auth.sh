#!/usr/bin/env bash
set -euo pipefail
service="${1:-pi-computer}"
NOVNC_BASE="${NOVNC_BASE:-http://127.0.0.1:${NOVNC_HOST_PORT:-6080}}"
TOKEN="${PI_COMPUTER_NOVNC_TOKEN:-local-novnc-token-change-me}"
USERNAME="${PI_COMPUTER_NOVNC_USERNAME:-operator}"
PASSWORD="${PI_COMPUTER_NOVNC_PASSWORD:-${TOKEN}}"

echo "checking unauthenticated noVNC rejection at ${NOVNC_BASE}/vnc.html"
unauth_code="$(curl -sS -o /tmp/pi-computer-novnc-unauth.json -w '%{http_code}' "${NOVNC_BASE}/vnc.html")"
if [ "${unauth_code}" != "401" ]; then
  cat /tmp/pi-computer-novnc-unauth.json >&2 || true
  echo "expected 401 for unauthenticated noVNC, got ${unauth_code}" >&2
  exit 1
fi

echo "checking authenticated noVNC access with bearer token"
curl -fsS -H "Authorization: Bearer ${TOKEN}" "${NOVNC_BASE}/vnc.html" | grep -qi 'noVNC\|html'

echo "checking authenticated noVNC access with basic auth"
curl -fsS -u "${USERNAME}:${PASSWORD}" "${NOVNC_BASE}/vnc.html" | grep -qi 'noVNC\|html'

echo "checking raw VNC and CDP remain unpublished"
if docker compose port "${service}" 5900 | grep -q .; then
  echo "VNC port 5900 is unexpectedly published: $(docker compose port "${service}" 5900)" >&2
  exit 1
fi
if docker compose port "${service}" 9222 | grep -q .; then
  echo "CDP port 9222 is unexpectedly published: $(docker compose port "${service}" 9222)" >&2
  exit 1
fi

echo "noVNC auth smoke passed"
