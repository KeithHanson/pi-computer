# Desktop container MVP

## Ports

| Port | Scope | Purpose |
| --- | --- | --- |
| `127.0.0.1:6080` on host -> `6080/tcp` in container | Localhost only by default | Direct noVNC operator web UI and websocket proxy |
| `127.0.0.1:8080` on host -> `8080/tcp` in container | Localhost only by default | Direct Node.js browser-task API |
| `127.0.0.1:5900` inside container only | Not published by Compose | x11vnc backend for noVNC |
| `127.0.0.1:9222` inside container only | Not published by Compose | Opera CDP for the stdio browser MCP bridge |

Compose intentionally does not publish direct VNC, CDP, MCP, or direct browser-control ports and disables container IPv6. x11vnc runs per connection in inetd mode without opening its own TCP listener, while the VNC relay uses TCP4 on `127.0.0.1:5900` only. Opera CDP binds to container loopback at `127.0.0.1:9222`. Use noVNC at `http://127.0.0.1:6080/vnc.html` for local operator access.

## Volumes

| Volume | Mount | Purpose |
| --- | --- | --- |
| `pi-computer-home` | `/home/pi` | Persistent non-root user home, Opera profile, Downloads |

Use `docker compose down -v` to remove the profile volume.

## Processes

`dumb-init` starts `supervisord` as the non-root `pi` user. Supervisor manages:

1. `Xvfb` virtual X11 display on `:1` with TCP disabled.
2. `fluxbox` lightweight window manager.
3. `socat` listening only on `127.0.0.1:5900` (TCP4) and spawning x11vnc in inetd mode per VNC connection; Compose also disables container IPv6.
4. x11vnc serving the virtual display over the accepted inetd connection without opening its own TCP listener.
5. noVNC/websockify backend on `127.0.0.1:6081` inside the container.
6. Node.js noVNC loopback proxy on `0.0.0.0:6080` inside the container; Compose restricts the host bind to `127.0.0.1`.
7. Opera Stable on the virtual display.
8. Node.js task API on `0.0.0.0:8080` inside the container; Compose restricts the host bind to `127.0.0.1`.

## Readiness and health

The image includes `/usr/local/bin/pi-computer-healthcheck`, also configured as Docker `HEALTHCHECK`. It verifies:

- X display responds via `xdpyinfo`.
- Fluxbox is running.
- The VNC relay is running, accepts IPv4 loopback TCP connections, and does not accept IPv6 loopback connections or expose `:::5900`.
- noVNC/websockify backend and the published noVNC loopback proxy are running.
- unauthenticated noVNC `/vnc.html` serves the UI.
- Opera process is running.
- Opera CDP `/json/version` responds on container loopback and is not wildcard-bound.

## Loopback access

The current deployment model intentionally removes application-layer auth from the host-loopback-published API and noVNC endpoints. Keep the default `127.0.0.1` host binds unless a separate trusted internal ingress is in place.

Manual checks:

```sh
curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null
./scripts/smoke-novnc-auth.sh
curl -fsS http://127.0.0.1:8080/healthz >/dev/null
./scripts/smoke-api.sh
```

## Current limitations

- noVNC is now directly reachable on the loopback-published port without in-app auth; keep the default loopback host bind for local/internal access unless a stronger ingress is added.
- the task API is a constrained MVP that performs an `open_url` smoke task through the stdio browser MCP bridge; full Pi `AgentSession` execution is next.
- Opera CDP is intended for internal Pi/browser automation only; do not publish port `9222` by default.
- The Opera apt repository is used at build time, so builds require external network access and trust in Opera's signed Debian repository.
