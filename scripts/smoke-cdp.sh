#!/usr/bin/env bash
set -euo pipefail
service="${1:-pi-computer}"
container_id="$(docker compose ps -q "${service}")"
if [[ -z "${container_id}" ]]; then
  echo "service ${service} is not running" >&2
  exit 1
fi
docker compose exec -T "${service}" bash -lc '
  set -euo pipefail
  curl -fsS "http://${CDP_HOST:-127.0.0.1}:${CDP_PORT:-9222}/json/version" | python3 -m json.tool
  listeners="$( (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) || true )"
  echo "${listeners}" | grep -E "127\.0\.0\.1:${CDP_PORT:-9222}" >/dev/null
  ! echo "${listeners}" | grep -E "(0\.0\.0\.0|:::|\*):${CDP_PORT:-9222}" >/dev/null
'
