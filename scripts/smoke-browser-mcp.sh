#!/usr/bin/env bash
set -euo pipefail
service="${1:-pi-computer}"
docker compose exec -T "${service}" python3 - <<'PY'
import json
import subprocess
import sys

proc = subprocess.Popen(
    ["/usr/local/bin/pi-computer-browser-mcp"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
)

def rpc(method, params=None):
    payload = {"jsonrpc": "2.0", "id": rpc.counter, "method": method}
    rpc.counter += 1
    if params is not None:
        payload["params"] = params
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()
    response = json.loads(proc.stdout.readline())
    if "error" in response:
        raise SystemExit(response["error"])
    return response["result"]
rpc.counter = 1

print(json.dumps(rpc("initialize"), indent=2, sort_keys=True))
print(json.dumps(rpc("tools/list"), indent=2, sort_keys=True))
print(json.dumps(rpc("tools/call", {"name": "browser.version"}), indent=2, sort_keys=True))
print(json.dumps(rpc("tools/call", {"name": "browser.targets"}), indent=2, sort_keys=True))
print(json.dumps(rpc("tools/call", {"name": "browser.navigate", "arguments": {"url": "about:blank"}}), indent=2, sort_keys=True))
proc.terminate()
PY
