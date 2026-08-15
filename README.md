# pi-computer

pi-computer is an open-source, containerized browser computer for Pi. It aims to be an open alternative to Perplexity Computer: a full Pi harness running inside a Docker container with a remotely viewable desktop, Opera browser automation, an MCP bridge, and a Node.js API that accepts browser-related tasks and has Pi perform them in Opera.

## MVP vision

The MVP is a single-user, single-tenant browser-agent appliance:

- a pinned Debian/Ubuntu LTS container image;
- a non-root desktop/browser user with no passwordless sudo at runtime;
- Xvfb plus a lightweight desktop, x11vnc, noVNC/websockify, and `tini` + Supervisor process management;
- Opera launched with a task-scoped profile and loopback-only Chrome DevTools Protocol (CDP);
- an internal Opera/browser MCP setup exposed only to Pi, not to public callers;
- an authenticated Node.js task API for declarative browser requests;
- one active task per container at first, with ephemeral profiles by default;
- one external ingress port by default for API, events, and authenticated noVNC.

The first concrete consumer is `daily-briefing`, but the project should remain reusable for other browser-task workflows.

## High-level architecture

```text
client / daily-briefing
        |
        | HTTPS + auth (single published ingress)
        v
reverse proxy / ingress
   |            |
   |            +--> noVNC UI -> websockify -> 127.0.0.1:5900 x11vnc
   |
   +--> Node.js API -> task runner -> Pi AgentSession SDK
                                     |
                                     +--> internal MCP bridge/tool allowlist
                                     |
                                     +--> Opera CDP on loopback/private boundary

Xvfb -> XFCE/Openbox desktop -> Opera browser process
```

Public callers submit and observe constrained browser tasks; they do not receive arbitrary shell, raw MCP, raw CDP, or filesystem control. The task runner owns the browser profile, workspace, artifact manifest, cancellation, and cleanup lifecycle.

See [`docs/architecture.md`](docs/architecture.md) for implementation-ready decisions and [`docs/threat-model.md`](docs/threat-model.md) for risk ranking and mitigations.

## Security warning

pi-computer combines a real browser, remote desktop, automation tools, and potentially authenticated website sessions. Treat every exposed control plane as sensitive:

- do not publish VNC port `5900`, CDP, MCP, or internal service ports;
- require authentication and TLS at the single external ingress;
- keep Opera's Chromium sandbox enabled for production targets when host/container configuration supports it;
- run as a non-root user without passwordless sudo;
- default to ephemeral browser profiles and short artifact retention;
- assume webpage content can be hostile prompt-injection input.

The MVP container is not a complete sandbox for mutually hostile users or arbitrary untrusted code. Stronger isolation, such as one container/VM per user or per task, is required for hostile multi-tenant deployments.

## Minimal desktop container MVP

This repository currently provides a Docker/Compose foundation for a local graphical Linux desktop running Opera behind noVNC.

### What is included

- Debian 12 slim base image.
- Non-root `pi` runtime user; no sudo package and no passwordless sudo.
- `dumb-init` + `supervisord` process supervision.
- Xvfb virtual display, Fluxbox window manager, x11vnc, noVNC/websockify, and Opera Stable.
- Direct VNC is relayed only on container IPv4 loopback (`127.0.0.1:5900`); x11vnc runs per connection in inetd mode without opening its own TCP listener, container IPv6 is disabled by Compose, and no VNC port is published by Compose.
- Opera CDP is enabled on container loopback only (`127.0.0.1:9222`) for internal automation; no CDP port is published by Compose.
- A minimal browser MCP-compatible smoke bridge is packaged as a stdio-only child process at `/usr/local/bin/pi-computer-browser-mcp`; no MCP port is published by Compose.
- Authenticated noVNC operator access is published only on host loopback by default: `127.0.0.1:6080` (override with `NOVNC_HOST_PORT` for local port conflicts). The published endpoint is a Node.js auth gate; the noVNC/websockify backend listens only on container loopback.
- An authenticated Node.js browser-task API is published on host loopback by default: `127.0.0.1:8080` (override `API_HOST_PORT`; set `PI_COMPUTER_API_TOKEN` before shared use).
- Compose allocates `1gb` `/dev/shm` for browser stability.
- Healthcheck verifies X display, Fluxbox, VNC IPv4 loopback relay, noVNC/websockify, Opera process, local noVNC HTTP, loopback VNC readiness/no IPv6 VNC reachability, and CDP `/json/version` readiness without wildcard CDP binding.

### Quick start

Build and start locally:

```sh
docker compose build pi-computer
docker compose up -d pi-computer
```

Watch startup and health:

```sh
docker compose logs -f pi-computer
docker compose ps pi-computer
```

Open the desktop with the noVNC operator token/basic credentials:

```sh
export PI_COMPUTER_NOVNC_TOKEN=local-novnc-token-change-me
# Browser basic-auth URL for local manual access; username defaults to operator and password defaults to the token.
xdg-open "http://operator:${PI_COMPUTER_NOVNC_TOKEN}@127.0.0.1:6080/vnc.html"
```

You can also authenticate with `Authorization: Bearer $PI_COMPUTER_NOVNC_TOKEN` for scripted checks. Set `PI_COMPUTER_NOVNC_USERNAME` and `PI_COMPUTER_NOVNC_PASSWORD` to use explicit basic-auth credentials distinct from the bearer token.

Stop and remove the container:

```sh
docker compose down
```

Remove the persisted browser home volume if you want a clean profile:

```sh
docker compose down -v
```

### Runtime validation commands

Useful checks after `docker compose up -d`:

```sh
docker compose exec pi-computer /usr/local/bin/pi-computer-healthcheck
docker compose exec pi-computer sh -lc 'ss -ltnp 2>/dev/null || netstat -ltnp'
docker compose exec pi-computer nc -vz 127.0.0.1 5900
# This should fail because container IPv6 is disabled and x11vnc must not listen on :::5900:
docker compose exec pi-computer nc -vz ::1 5900
docker compose exec pi-computer curl -fsS http://127.0.0.1:9222/json/version
./scripts/smoke-cdp.sh
./scripts/smoke-browser-mcp.sh
./scripts/smoke-host-boundary.sh
docker compose exec pi-computer opera --version
# Unauthenticated noVNC should return 401; authenticated access should return the UI.
curl -sS -o /tmp/novnc-unauth -w '%{http_code}\n' http://127.0.0.1:6080/vnc.html
curl -fsSI -H "Authorization: Bearer ${PI_COMPUTER_NOVNC_TOKEN:-local-novnc-token-change-me}" http://127.0.0.1:6080/vnc.html
curl -fsS http://127.0.0.1:8080/healthz
./scripts/smoke-api.sh
./scripts/smoke-novnc-auth.sh
docker compose port pi-computer 6080
# These should return nothing because raw VNC and CDP are intentionally not published:
docker compose port pi-computer 5900 || true
docker compose port pi-computer 9222 || true
```

### Browser task API

See [`docs/browser-task-api.md`](docs/browser-task-api.md) for authentication, request/response shapes, lifecycle states, SSE events, artifact storage, and MVP limitations. The smoke path is:

```sh
export PI_COMPUTER_API_TOKEN=local-dev-token-change-me
./scripts/smoke-api.sh
```

The API is intentionally declarative. It accepts an `open_url` browser task and does not expose arbitrary shell, raw CDP commands, raw MCP messages, filesystem paths, environment variables, or Pi CLI arguments.

### Security notes for the MVP

The container is intended for local development only. noVNC now has an MVP application-level auth gate, and Compose still binds it to host loopback by default. Change the default `PI_COMPUTER_NOVNC_TOKEN` before sharing access and place the endpoint behind TLS for any non-local deployment. Direct VNC uses `-nopw` only because x11vnc runs per connection in inetd mode without its own TCP listener, a TCP4-only relay listens on container IPv4 loopback, container IPv6 is disabled by Compose, and VNC is not exposed by Compose.

Opera is launched as the non-root `pi` user with CDP constrained to container loopback. It currently uses `--no-sandbox` because this Docker runtime cannot initialize Opera's Chromium sandbox with `no-new-privileges`; a later hardening slice should document the minimum required runtime exception rather than publishing raw browser-control ports.

See [`docs/protected-opera-cdp-mcp.md`](docs/protected-opera-cdp-mcp.md) for the CDP/MCP topology, environment variables, smoke scripts, and limitations.
