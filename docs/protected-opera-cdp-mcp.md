# Protected Opera CDP and browser MCP

## Topology

Opera starts inside the container on the Xvfb display with Chrome DevTools Protocol enabled only on the container loopback interface:

```text
Pi / task runner
  -> real Pi CLI (/usr/local/bin/pi)
  -> stdio browser MCP bridge (/usr/local/bin/pi-computer-browser-mcp)
      -> http://127.0.0.1:9222/json/version inside container
      -> CDP websocket on 127.0.0.1 only
          -> Opera on Xvfb/noVNC desktop
```

No raw CDP port, MCP port, or direct browser-control API is published by `compose.yaml`. The default host-published ports are loopback-only noVNC on `127.0.0.1:6080` and the Node.js task API on `127.0.0.1:8080`.

## Ports and environment

| Setting | Default | Scope | Purpose |
| --- | --- | --- | --- |
| `CDP_HOST` | `127.0.0.1` | container loopback | Opera remote-debugging bind address |
| `CDP_PORT` | `9222` | container loopback only | Opera remote-debugging HTTP/WebSocket endpoint |
| `BROWSER_MCP_TRANSPORT` | `stdio` | child process only | Documents that the bridge is not a network daemon |
| `NOVNC_HOST_BIND` | `127.0.0.1` | host bind | Compose host interface for noVNC |
| `NOVNC_HOST_PORT` | `6080` | host port | Compose host port for noVNC |
| `NOVNC_PORT` | `6080` | container port | Operator desktop UI |
| `VNC_PORT` | `5900` | container loopback only | x11vnc backend for noVNC |

Do not change `CDP_HOST` to `0.0.0.0`, add a Compose `ports` entry for `9222`, or run the browser MCP bridge as a network service unless a later trusted internal ingress design is added.

## Pi harness bootstrap

The container now ships the real Pi CLI (`/usr/local/bin/pi`) on Node.js 22. Pi state lives in `/home/pi/.pi/agent` on the persisted home volume.

Bootstrap paths:

- Compose-passed provider env vars such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and peers listed in `compose.yaml`.
- A read-only host import mounted at `/pi-agent-import` when `PI_HARNESS_HOST_AGENT_DIR` is set; `/usr/local/bin/pi-computer-bootstrap-pi-harness` copies `auth.json`, `settings.json`, `models.json`, `sessions/`, `prompts/`, `themes/`, and `tools/` into `/home/pi/.pi/agent`.
- Direct JSON injection for trusted automation through `PI_AUTH_JSON_B64`, `PI_SETTINGS_JSON_B64`, and `PI_MODELS_JSON_B64` when re-running the helper.

Useful checks:

```bash
docker compose exec pi-computer pi --version
docker compose exec pi-computer pi auth check --provider openai --json --no-refresh
docker compose exec pi-computer /usr/local/bin/pi-computer-bootstrap-pi-harness
```

## MCP bridge

`/usr/local/bin/pi-computer-browser-mcp` is a minimal repo-local JSON-RPC-over-stdio bridge used for smoke validation and as the package point for Pi integration. It has no listening socket. Supported smoke tools are intentionally small:

- `browser.version` reads CDP `/json/version`.
- `browser.targets` reads CDP `/json/list`.
- `browser.probe` performs a non-mutating websocket readiness check across the Runtime and Page CDP domains by reading `window.location.href` and `Page.getNavigationHistory` from the first ready page target.
- `browser.navigate` navigates the first page target to an `http://`, `https://`, or `about:` URL.

The bridge caps JSON result size through `BROWSER_MCP_MAX_RESULT_BYTES` (default `131072`). It is not a public API and must be launched by Pi/task-runner code with an allowlist.

## Readiness and smoke validation

The Docker healthcheck now verifies:

- Xvfb/fluxbox/noVNC/VNC are ready.
- Opera is running.
- CDP `/json/version` responds on `CDP_HOST:CDP_PORT`.
- The browser bridge can complete a non-mutating websocket readiness probe across the Runtime and Page CDP domains against the first ready page target.
- CDP and VNC do not listen on wildcard interfaces.

Repo smoke scripts:

```bash
docker compose up --build -d
./scripts/smoke-cdp.sh
./scripts/smoke-browser-mcp.sh
./scripts/smoke-host-boundary.sh
curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null
curl -fsS http://127.0.0.1:8080/healthz
```

`smoke-host-boundary.sh` fails if Compose publishes raw CDP/VNC or if the container CDP endpoint is reachable from the host via the container network IP. It avoids assuming host `127.0.0.1:9222` is unused by unrelated local browsers.

## Limitations

- The loopback-published task API currently uses this bridge directly for the `open_url` MVP smoke task; the real Pi harness is installed and auth-ready, but full supervised Pi AgentSession/task-runner cutover remains the next runtime step.
- The bridge is intentionally minimal until task-specific Pi MCP allowlists are implemented.
- noVNC is directly reachable on the loopback-published port in this slice; keep the loopback host bind.
- Opera's proprietary redistribution/licensing remains a release gate documented in the architecture notes.

## Runtime hardening defaults

Compose runs the desktop as UID/GID `1000:1000` with `no-new-privileges`, `cap_drop: [ALL]`, a read-only root filesystem, bounded tmpfs writable surfaces, `/dev/shm`, CPU/memory limits, and a PID limit. The only default host-published ports are loopback-bound ingress ports: noVNC on `127.0.0.1:6080` and the task API on `127.0.0.1:8080`. Those endpoints are currently unauthenticated in-app and rely on host/network boundaries for protection. Raw VNC (`5900`), Opera CDP (`9222`), browser MCP stdio, Supervisor, and noVNC backend internals are not published.

Writable runtime surfaces are intentionally narrow:

- `/home/pi` via the `pi-computer-home` volume for the non-root home, Opera profile, downloads, and task store;
- `/tmp`, `/run`, `/var/log/pi-computer`, and `/var/run/pi-computer` as bounded tmpfs mounts;
- Docker-managed `/dev/shm` sized by `shm_size` for browser stability.

Do not add host directory mounts, Docker socket mounts, `privileged: true`, `cap_add`, wildcard host binds, or raw `5900`/`9222` port mappings without a new threat-model review.

## Pi harness secrets and log hygiene

The current runtime does not configure application-layer API or noVNC tokens. Keep the default host-loopback binds unless a separate trusted/internal ingress is in place, and add TLS/auth there before exposing the UI or API more broadly.

Pi/provider credentials remain sensitive. Keep real provider API keys, imported Pi `auth.json`, cookies, and other browser/session secrets out of the repository, shell history, screenshots, issue text, and committed Compose overrides.

Log expectations: services must not print Authorization headers, cookies, provider API keys, Pi auth material, CDP websocket URLs, or page secrets. Smoke checks scan recent Compose logs for obvious secret values, but that is not a substitute for reviewing new logging code.

Sandbox compatibility note: Opera currently retains the `--no-sandbox` flag because the tested Docker runtime blocks both the setuid sandbox under `no-new-privileges` and unprivileged namespace sandbox startup. This is a known residual risk, offset only partially by non-root execution, dropped capabilities, read-only rootfs, unpublished raw control ports, and Docker isolation. Revisit before production or hostile browsing use.
