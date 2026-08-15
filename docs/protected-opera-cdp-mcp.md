# Protected Opera CDP and browser MCP

## Topology

Opera starts inside the container on the Xvfb display with Chrome DevTools Protocol enabled only on the container loopback interface:

```text
Pi / task runner
  -> stdio browser MCP bridge (/usr/local/bin/pi-computer-browser-mcp)
      -> http://127.0.0.1:9222/json/version inside container
      -> CDP websocket on 127.0.0.1 only
          -> Opera on Xvfb/noVNC desktop
```

No raw CDP port, MCP port, or direct browser-control API is published by `compose.yaml`. The default host-published ports are loopback-only noVNC on `127.0.0.1:6080` and the authenticated Node.js task API on `127.0.0.1:8080`.

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

Do not change `CDP_HOST` to `0.0.0.0`, add a Compose `ports` entry for `9222`, or run the browser MCP bridge as a network service unless a later authenticated internal ingress design is added.

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
```

`smoke-host-boundary.sh` fails if Compose publishes raw CDP/VNC or if the container CDP endpoint is reachable from the host via the container network IP. It avoids assuming host `127.0.0.1:9222` is unused by unrelated local browsers.

## Limitations

- The authenticated task API currently uses this bridge directly for the `open_url` MVP smoke task; full Pi AgentSession integration remains the next runtime step.
- The bridge is intentionally minimal until task-specific Pi MCP allowlists are implemented.
- noVNC still lacks authentication/TLS in this slice; keep the loopback host bind.
- Opera's proprietary redistribution/licensing remains a release gate documented in the architecture notes.
