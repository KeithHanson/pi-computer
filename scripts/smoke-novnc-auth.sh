#!/usr/bin/env bash
set -euo pipefail
service="${1:-pi-computer}"
NOVNC_BASE="${NOVNC_BASE:-http://127.0.0.1:${NOVNC_HOST_PORT:-6080}}"

echo "checking unauthenticated noVNC access at ${NOVNC_BASE}/vnc.html"
curl -fsS "${NOVNC_BASE}/vnc.html" | grep -qi 'noVNC\|html'

echo "checking noVNC websocket desktop relay through published endpoint"
python3 - <<'PY'
import asyncio
import os
import sys
import websockets

base = os.environ.get('NOVNC_BASE', f"http://127.0.0.1:{os.environ.get('NOVNC_HOST_PORT', '6080')}")
ws_url = base.replace('http://', 'ws://', 1).replace('https://', 'wss://', 1) + '/websockify'

async def main():
    async with websockets.connect(ws_url, open_timeout=5, max_size=1024) as websocket:
        greeting = await asyncio.wait_for(websocket.recv(), timeout=5)
        if not isinstance(greeting, (bytes, bytearray)) or not bytes(greeting).startswith(b'RFB '):
            raise SystemExit(f'unexpected VNC greeting from {ws_url}: {greeting!r}')
        sys.stdout.write(bytes(greeting).decode('ascii', 'replace').strip())

asyncio.run(main())
PY

echo

echo "checking raw VNC and CDP remain unpublished"
if docker compose port "${service}" 5900 | grep -q .; then
  echo "VNC port 5900 is unexpectedly published: $(docker compose port "${service}" 5900)" >&2
  exit 1
fi
if docker compose port "${service}" 9222 | grep -q .; then
  echo "CDP port 9222 is unexpectedly published: $(docker compose port "${service}" 9222)" >&2
  exit 1
fi

echo "noVNC smoke passed"
