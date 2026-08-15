# Desktop container MVP

## Ports

| Port | Scope | Purpose |
| --- | --- | --- |
| `127.0.0.1:6080` on host -> `6080/tcp` in container | Localhost only by default | Authenticated noVNC operator web UI and websocket proxy auth gate |
| `127.0.0.1:8080` on host -> `8080/tcp` in container | Localhost only by default | Authenticated Node.js browser-task API |
| `127.0.0.1:5900` inside container only | Not published by Compose | x11vnc backend for noVNC |
| `127.0.0.1:9222` inside container only | Not published by Compose | Opera CDP for the stdio browser MCP bridge |

Compose intentionally does not publish direct VNC, CDP, MCP, or direct browser-control ports and disables container IPv6. x11vnc runs per connection in inetd mode without opening its own TCP listener, while the VNC relay uses TCP4 on `127.0.0.1:5900` only. Opera CDP binds to container loopback at `127.0.0.1:9222`. Use authenticated noVNC at `http://127.0.0.1:6080/vnc.html` for local operator access.

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
6. Node.js noVNC auth gate on `0.0.0.0:6080` inside the container; Compose restricts the host bind to `127.0.0.1`. It proxies HTTP and websocket upgrades only after bearer-token or basic authentication succeeds.
7. Opera Stable on the virtual display.
8. Node.js task API on `0.0.0.0:8080` inside the container; Compose restricts the host bind to `127.0.0.1` and all `/v1/*` endpoints require bearer auth.

## Readiness and health

The image includes `/usr/local/bin/pi-computer-healthcheck`, also configured as Docker `HEALTHCHECK`. It verifies:

- X display responds via `xdpyinfo`.
- Fluxbox is running.
- The VNC relay is running, accepts IPv4 loopback TCP connections, and does not accept IPv6 loopback connections or expose `:::5900`.
- noVNC/websockify backend and noVNC auth gate are running.
- unauthenticated noVNC `/vnc.html` is rejected with `401`, while authenticated bearer-token access serves the UI.
- Opera process is running.
- Opera CDP `/json/version` responds on container loopback and is not wildcard-bound.

## noVNC operator authentication

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_COMPUTER_NOVNC_TOKEN` | `local-novnc-token-change-me` | Bearer token for scripted access; also the default basic-auth password. Change before shared use. |
| `PI_COMPUTER_NOVNC_USERNAME` | `operator` | Basic-auth username for browser access. |
| `PI_COMPUTER_NOVNC_PASSWORD` | value of `PI_COMPUTER_NOVNC_TOKEN` | Basic-auth password for browser access when explicit credentials are desired. |
| `NOVNC_BACKEND_PORT` | `6081` | Container-loopback backend noVNC/websockify port; not published. |

Manual checks:

```sh
curl -sS -o /tmp/novnc-unauth -w '%{http_code}\n' http://127.0.0.1:6080/vnc.html # expect 401
curl -fsS -H "Authorization: Bearer ${PI_COMPUTER_NOVNC_TOKEN:-local-novnc-token-change-me}" http://127.0.0.1:6080/vnc.html >/dev/null
curl -fsS -u "${PI_COMPUTER_NOVNC_USERNAME:-operator}:${PI_COMPUTER_NOVNC_PASSWORD:-${PI_COMPUTER_NOVNC_TOKEN:-local-novnc-token-change-me}}" http://127.0.0.1:6080/vnc.html >/dev/null
./scripts/smoke-novnc-auth.sh
```

## Current limitations

- noVNC authentication is an MVP bearer/basic auth gate without TLS, sessions, rate limiting, CSRF protection, or idle timeout; keep the default loopback host bind for local-only access unless a TLS ingress provides those controls.
- the task API is a constrained MVP that performs an `open_url` smoke task through the stdio browser MCP bridge; full Pi `AgentSession` execution is next.
- Opera CDP is intended for internal Pi/browser automation only; do not publish port `9222` by default.
- The Opera apt repository is used at build time, so builds require external network access and trust in Opera's signed Debian repository.

## Runtime hardening defaults

Compose runs the desktop as UID/GID `1000:1000` with `no-new-privileges`, `cap_drop: [ALL]`, a read-only root filesystem, bounded tmpfs writable surfaces, `/dev/shm`, CPU/memory limits, and a PID limit. The only default host-published ports are authenticated ingress ports bound to host loopback: noVNC on `127.0.0.1:6080` and the task API on `127.0.0.1:8080`. Raw VNC (`5900`), Opera CDP (`9222`), browser MCP stdio, Supervisor, and noVNC backend internals are not published.

Writable runtime surfaces are intentionally narrow:

- `/home/pi` via the `pi-computer-home` volume for the non-root home, Opera profile, downloads, and task store;
- `/tmp`, `/run`, `/var/log/pi-computer`, and `/var/run/pi-computer` as bounded tmpfs mounts;
- Docker-managed `/dev/shm` sized by `shm_size` for browser stability.

Do not add host directory mounts, Docker socket mounts, `privileged: true`, `cap_add`, wildcard host binds, or raw `5900`/`9222` port mappings without a new threat-model review.

## Secret and token operations

Development defaults such as `local-dev-token-change-me` and `local-novnc-token-change-me` are placeholders only. Shared or deployed environments must set unique high-entropy values for:

- `PI_COMPUTER_API_TOKEN` for `/v1/*` task API calls;
- `PI_COMPUTER_NOVNC_TOKEN` for scripted noVNC bearer access;
- `PI_COMPUTER_NOVNC_USERNAME` and `PI_COMPUTER_NOVNC_PASSWORD` for browser basic auth.

Keep real token values out of the repository, shell history, screenshots, issue text, and Compose override files that may be committed. Prefer an untracked `.env`, a local secret manager, or orchestrator-provided secrets. Rotate tokens after accidental disclosure, after operator offboarding, and on any move from local loopback-only use to a shared ingress. API and noVNC tokens are intentionally separate so either control plane can be rotated independently.

Log expectations: services must not print Authorization headers, bearer token values, basic-auth passwords, cookies, CDP websocket URLs, or page secrets. Smoke checks scan recent Compose logs for configured token values, but that is not a substitute for reviewing new logging code.

Sandbox compatibility note: Opera currently retains the `--no-sandbox` flag because the tested Docker runtime blocks both the setuid sandbox under `no-new-privileges` and unprivileged namespace sandbox startup. This is a known residual risk, offset only partially by non-root execution, dropped capabilities, read-only rootfs, unpublished raw control ports, and Docker isolation. Revisit before production or hostile browsing use.
