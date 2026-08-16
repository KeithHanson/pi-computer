#!/usr/bin/env bash
set -euo pipefail
service="${1:-pi-computer}"
container_id="$(docker compose ps -q "${service}")"
if [[ -z "${container_id}" ]]; then
  echo "service ${service} is not running" >&2
  exit 1
fi

inspect_json="$(docker inspect "${container_id}")"
python3 - "${container_id}" <<'PY'
import json
import subprocess
import sys

cid = sys.argv[1]
info = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True))[0]
host = info["HostConfig"]
config = info["Config"]
state = info["State"]

def fail(msg):
    raise SystemExit(msg)

if host.get("Privileged"):
    fail("container must not be privileged")
if not config.get("User") or config.get("User") in {"0", "0:0", "root"}:
    fail(f"container must run as a non-root user, got {config.get('User')!r}")
if not host.get("ReadonlyRootfs"):
    fail("root filesystem must be read-only")
if "ALL" not in (host.get("CapDrop") or []):
    fail(f"all Linux capabilities must be dropped, got {host.get('CapDrop')}")
if "no-new-privileges:true" not in (host.get("SecurityOpt") or []):
    fail(f"no-new-privileges security_opt missing: {host.get('SecurityOpt')}")
if not host.get("PidsLimit") or int(host.get("PidsLimit")) <= 0:
    fail(f"pids_limit must be set, got {host.get('PidsLimit')}")
if not host.get("Memory") or int(host.get("Memory")) <= 0:
    fail(f"memory limit must be set, got {host.get('Memory')}")
ports = host.get("PortBindings") or {}
for forbidden in ("5900/tcp", "9222/tcp"):
    if forbidden in ports:
        fail(f"raw internal port {forbidden} must not be published")
for published in ("6080/tcp", "8080/tcp"):
    bindings = ports.get(published) or []
    if not bindings:
        fail(f"expected loopback-published ingress {published}")
    for binding in bindings:
        if binding.get("HostIp") not in {"127.0.0.1", "localhost"}:
            fail(f"{published} must bind host loopback only, got {bindings}")
mount_targets = {m.get("Destination") for m in (host.get("Tmpfs") or {}).items()} if False else set()
# Docker reports tmpfs as a dict of destination -> options.
tmpfs = host.get("Tmpfs") or {}
for required in ("/tmp", "/run", "/var/log/pi-computer", "/var/run/pi-computer"):
    if required not in tmpfs:
        fail(f"required tmpfs writable surface missing: {required}")
print("inspect hardening ok: non-root, unprivileged, read-only rootfs, cap_drop=ALL, no-new-privileges, resource limits, loopback-only ingress")
print(f"health={state.get('Health', {}).get('Status', 'n/a')}")
PY

docker compose exec -T "${service}" bash -lc '
  set -euo pipefail
  test "$(id -u)" != "0"
  ! command -v sudo >/dev/null 2>&1
  if grep -R --line-number -- "--no-sandbox" /proc/*/cmdline 2>/dev/null; then
    echo "residual risk: Opera is running with --no-sandbox for compatibility with no-new-privileges in this Docker runtime" >&2
  fi
  touch /tmp/pi-computer-hardening-write-test
  if touch /usr/local/bin/pi-computer-hardening-should-fail 2>/dev/null; then
    echo "read-only root filesystem allowed a write under /usr/local/bin" >&2
    rm -f /usr/local/bin/pi-computer-hardening-should-fail
    exit 1
  fi
  listeners="$( (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) || true )"
  echo "${listeners}" | grep -Eq "(^|[[:space:]])127\.0\.0\.1:${VNC_PORT:-5900}([[:space:]]|$)"
  echo "${listeners}" | grep -Eq "(^|[[:space:]])${CDP_HOST:-127.0.0.1}:${CDP_PORT:-9222}([[:space:]]|$)"
  ! echo "${listeners}" | grep -Eq "(^|[[:space:]])(0\.0\.0\.0|:::|\*):(${VNC_PORT:-5900}|${CDP_PORT:-9222})([[:space:]]|$)"
  echo "runtime hardening ok: uid=$(id -u), sudo absent, rootfs write blocked, VNC/CDP loopback-only"
'

logs="$(docker compose logs --no-color --tail=300 "${service}" || true)"
for secret in \
  "${OPENAI_API_KEY:-}" \
  "${ANTHROPIC_API_KEY:-}" \
  "${GEMINI_API_KEY:-}" \
  "${OPENROUTER_API_KEY:-}" \
  "${PI_AUTH_JSON_B64:-}"; do
  if [[ -n "${secret}" ]] && grep -F -- "${secret}" <<<"${logs}" >/dev/null; then
    echo "secret-like token value appeared in recent compose logs" >&2
    exit 1
  fi
done

echo "hardening smoke passed"
