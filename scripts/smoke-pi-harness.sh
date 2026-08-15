#!/usr/bin/env bash
set -euo pipefail
service="${1:-pi-computer}"

echo '== pi binary ==' 
docker compose exec -T "$service" sh -lc 'command -v pi && pi --version && node --version'

echo '== env auth check ==' 
auth_json="$(docker compose exec -T -e OPENAI_API_KEY=pi-smoke-placeholder "$service" pi auth check --provider openai --json --credentials --no-refresh)"
python3 - <<'PY' "$auth_json"
import json
import sys
payload = json.loads(sys.argv[1])
assert payload["status"] == "ready", payload
assert payload["provider"] == "openai", payload
assert payload["authType"] == "api_key", payload
assert payload["credentials"] == "pi-smoke-placeholder", payload
print(json.dumps({"status": payload["status"], "provider": payload["provider"], "authType": payload["authType"], "credentials": "redacted"}))
PY

echo '== bootstrap helper ==' 
settings_b64="$(printf '%s' '{"preferredProviders":["openai"],"theme":"pi-computer-smoke"}' | base64 -w0)"
docker compose exec -T -e PI_SETTINGS_JSON_B64="$settings_b64" "$service" /usr/local/bin/pi-computer-bootstrap-pi-harness

docker compose exec -T "$service" python3 - <<'PY'
import json
from pathlib import Path
settings_path = Path('/home/pi/.pi/agent/settings.json')
payload = json.loads(settings_path.read_text())
assert payload['theme'] == 'pi-computer-smoke', payload
assert payload['preferredProviders'] == ['openai'], payload
print(json.dumps({"settingsPath": str(settings_path), "theme": payload['theme'], "preferredProviders": payload['preferredProviders']}))
PY
