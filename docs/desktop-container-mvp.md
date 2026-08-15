# Desktop container MVP

## Ports

| Port | Scope | Purpose |
| --- | --- | --- |
| `127.0.0.1:6080` on host -> `6080/tcp` in container | Localhost only by default | noVNC web UI and websocket proxy |
| `127.0.0.1:5900` inside container only | Not published by Compose | x11vnc backend for noVNC |

Compose intentionally does not publish direct VNC and disables container IPv6. x11vnc runs per connection in inetd mode without opening its own TCP listener, while the VNC relay uses TCP4 on `127.0.0.1:5900` only. Use noVNC at `http://127.0.0.1:6080/vnc.html` for local access.

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
5. noVNC/websockify on `0.0.0.0:6080` inside the container; Compose restricts the host bind to `127.0.0.1`.
6. Opera Stable on the virtual display.

## Readiness and health

The image includes `/usr/local/bin/pi-computer-healthcheck`, also configured as Docker `HEALTHCHECK`. It verifies:

- X display responds via `xdpyinfo`.
- Fluxbox is running.
- The VNC relay is running, accepts IPv4 loopback TCP connections, and does not accept IPv6 loopback connections or expose `:::5900`.
- noVNC/websockify is running and serves `/vnc.html` locally.
- Opera process is running.

## Current limitations

- no noVNC authentication or TLS yet; keep the default loopback host bind for local-only access.
- no public CDP/MCP/task API port in this MVP.
- Opera starts with `--no-sandbox` for container compatibility; this should be revisited when a hardened browser sandbox profile is designed.
- The Opera apt repository is used at build time, so builds require external network access and trust in Opera's signed Debian repository.
