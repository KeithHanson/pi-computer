#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/export-opera-profile.sh --source /path/to/opera-profile --dest ./operator/opera-profile-export [--browser-product opera-stable] [--browser-version 121.0.0.0]

Creates a closed-profile export snapshot that pi-computer can import at startup.
Authenticated sessions are intentionally not supported for cross-machine restore.
EOF
}

source_dir=''
dest_dir=''
browser_product='opera-stable'
browser_version=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      source_dir="$2"
      shift 2
      ;;
    --dest)
      dest_dir="$2"
      shift 2
      ;;
    --browser-product)
      browser_product="$2"
      shift 2
      ;;
    --browser-version)
      browser_version="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$source_dir" ] || { echo '--source is required' >&2; exit 2; }
[ -n "$dest_dir" ] || { echo '--dest is required' >&2; exit 2; }
[ -d "$source_dir" ] || { echo "source profile directory not found: $source_dir" >&2; exit 1; }

for lock_name in SingletonLock SingletonCookie SingletonSocket; do
  if [ -e "$source_dir/$lock_name" ]; then
    echo "source profile appears live; close the source browser before exporting ($lock_name present)" >&2
    exit 1
  fi
done

auth_markers="$({ python3 - "$source_dir" <<'PY'
import json, pathlib, sys
base = pathlib.Path(sys.argv[1])
markers = []
prefs = base / 'Default' / 'Preferences'
if prefs.exists():
    try:
        obj = json.loads(prefs.read_text())
        refresh = str(obj.get('opera', {}).get('oauth2', {}).get('session', {}).get('refresh_token', '') or '')
        if refresh:
            markers.append('opera.oauth2.session.refresh_token')
    except Exception:
        markers.append('unreadable Default/Preferences')
for rel in ['Default/Login Data', 'Default/Login Data For Account', 'Default/Cookies', 'Default/Network/Cookies']:
    if (base / rel).exists():
        markers.append(rel)
print(', '.join(markers), end='')
PY
} || true)"
if [ -n "$auth_markers" ]; then
  echo "source profile contains authenticated secret/session stores ($auth_markers); cross-machine login portability is unsupported, so sign in again inside the container instead" >&2
  exit 1
fi

profile_last_version="$({ python3 - "$source_dir" <<'PY'
import json, pathlib, sys
base = pathlib.Path(sys.argv[1])
value = ''
prefs = base / 'Default' / 'Preferences'
if prefs.exists():
    obj = json.loads(prefs.read_text())
    value = str(obj.get('extensions', {}).get('last_opera_version', '') or '')
if not value:
    local_state = base / 'Local State'
    if local_state.exists():
        obj = json.loads(local_state.read_text())
        last = obj.get('last_version')
        if isinstance(last, list):
            value = '.'.join(str(part) for part in last[:4])
print(value)
PY
} || true)"

if [ -z "$browser_version" ]; then
  if command -v opera >/dev/null 2>&1; then
    browser_version="$(opera --version | awk '{print $NF}')"
  else
    browser_version="$profile_last_version"
  fi
fi

staging_dir="${dest_dir}.tmp.$$"
rm -rf "$staging_dir"
mkdir -p "$staging_dir/profile"
tar -C "$source_dir" -cf - . | tar -C "$staging_dir/profile" -xf -

python3 - "$staging_dir/pi-computer-profile-export.json" "$source_dir" "$browser_product" "$browser_version" "$profile_last_version" <<'PY'
import json, pathlib, socket, sys
manifest_path = pathlib.Path(sys.argv[1])
source_dir, browser_product, browser_version, profile_last_version = sys.argv[2:6]
manifest = {
    'schemaVersion': 1,
    'browserProduct': browser_product,
    'browserVersion': browser_version,
    'profileLastOperaVersion': profile_last_version,
    'sourceProfileDir': source_dir,
    'sourceHostname': socket.gethostname(),
    'sourceClosed': True,
    'notes': [
        'Authenticated sessions are intentionally unsupported for pi-computer profile import.',
        'Use this export only for same-channel closed-profile browser state such as bookmarks and preferences.'
    ]
}
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
PY

rm -rf "$dest_dir"
mv "$staging_dir" "$dest_dir"

echo "exported closed Opera profile snapshot to $dest_dir"
echo "supported import scope: same-channel closed-profile export only; sign in again inside the container if login state is required"
