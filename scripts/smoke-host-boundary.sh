#!/usr/bin/env bash
set -euo pipefail
service="${1:-pi-computer}"
container_id="$(docker compose ps -q "${service}")"
if [[ -z "${container_id}" ]]; then
  echo "service ${service} is not running" >&2
  exit 1
fi
if docker compose port "${service}" 9222 | grep -q .; then
  echo "CDP port 9222 is unexpectedly published" >&2
  exit 1
fi
if docker compose port "${service}" 5900 | grep -q .; then
  echo "VNC port 5900 is unexpectedly published" >&2
  exit 1
fi
if docker compose port "${service}" 6080 | grep -q .; then
  echo "noVNC published mapping: $(docker compose port "${service}" 6080)"
else
  echo "noVNC port 6080 is not published"
fi
container_ip="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${container_id}")"
if [[ -n "${container_ip}" ]] && curl -fsS --max-time 2 "http://${container_ip}:9222/json/version" >/tmp/pi-computer-host-cdp.$$ 2>/dev/null; then
  echo "host can reach container CDP at ${container_ip}:9222; CDP must remain loopback/private" >&2
  cat /tmp/pi-computer-host-cdp.$$ >&2
  rm -f /tmp/pi-computer-host-cdp.$$
  exit 1
fi
rm -f /tmp/pi-computer-host-cdp.$$
echo "host boundary ok: CDP/VNC are not published; host curl to container IP ${container_ip}:9222 failed as expected"
