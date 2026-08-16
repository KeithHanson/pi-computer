# pi-computer

pi-computer is an open-source, containerized browser computer for Pi. It aims to be an open alternative to Perplexity Computer: a full Pi harness running inside a Docker container with a remotely viewable desktop, Opera browser automation, an MCP bridge, and a Node.js API that accepts browser-related tasks and has Pi perform them in Opera.

## MVP vision

The MVP is a single-user, single-tenant browser-agent appliance:

- a pinned Debian/Ubuntu LTS container image;
- a non-root desktop/browser user with no passwordless sudo at runtime;
- Xvfb plus a lightweight desktop, x11vnc, noVNC/websockify, and `tini` + Supervisor process management;
- Opera launched with a task-scoped profile and loopback-only Chrome DevTools Protocol (CDP);
- an internal Opera/browser MCP setup exposed only to Pi, not to public callers;
- a loopback-published Node.js task API for declarative browser requests;
- one active task per container at first, with ephemeral profiles by default;
- loopback-published API and noVNC access by default, with host/network boundaries as the protection layer.

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
- keep published API/noVNC access on trusted loopback or internal network boundaries, and add TLS/auth at a separate ingress if exposure broadens;
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
- The real Pi harness CLI is installed in-container as `/usr/local/bin/pi` via `@earendil-works/pi-coding-agent`, along with Node.js 22 runtime support required by the package.
- A minimal browser MCP-compatible smoke bridge is packaged as a stdio-only child process at `/usr/local/bin/pi-computer-browser-mcp`; no MCP port is published by Compose.
- noVNC operator access is published only on host loopback by default: `127.0.0.1:6080` (override with `NOVNC_HOST_PORT` for local port conflicts). The published endpoint is a Node.js loopback proxy; the noVNC/websockify backend listens only on container loopback.
- A Node.js browser-task API is published on host loopback by default: `127.0.0.1:8080` (override `API_HOST_PORT`).
- Compose allocates `1gb` `/dev/shm` for browser stability.
- Healthcheck verifies X display, Fluxbox, VNC IPv4 loopback relay, noVNC/websockify, Opera process, local noVNC HTTP, loopback VNC readiness/no IPv6 VNC reachability, CDP `/json/version`, and a non-mutating browser websocket readiness probe across the Runtime and Page CDP domains without wildcard CDP binding.

### Quick start

Build and start locally:

```sh
docker compose build pi-computer
docker compose up -d pi-computer
```

### Pi harness auth/bootstrap

The image now bootstraps Pi in a narrowly scoped way for browser-task validation:

1. The image preconfigures Pi to load `pi-mcp-adapter` and points `/home/pi/.mcp.json` at the local `opera-devtools-mcp` server for browser work.
2. For local validation, mount only the host `auth.json` file by setting `HOST_PI_AUTH_JSON`; `/usr/local/bin/pi-computer-bootstrap-pi` copies only that file into `/home/pi/.pi/agent/auth.json` on startup.
3. Use `.env.example` to override the bounded browser-task provider/model via `PI_HARNESS_PROVIDER`, `PI_HARNESS_MODEL`, and `PI_BROWSER_TASK_MAX_ARTICLES`.

Recommended local first run:

```sh
cp .env.example .env
$EDITOR .env

docker compose up -d --build pi-computer
```

Set `HOST_PI_AUTH_JSON` in `.env` to the host auth file path, for example `/home/keith/.pi/agent/auth.json`. Do not mount the broader host `~/.pi/agent` directory into the container.

Verify the harness and auth state inside the container:

```sh
docker compose exec pi-computer pi --version
docker compose exec pi-computer pi auth check --provider openai --json --no-refresh
```

If you update the mounted auth-only directory, re-run bootstrap with:

```sh
docker compose exec pi-computer /usr/local/bin/pi-computer-bootstrap-pi
```

Watch startup and health:

```sh
docker compose logs -f pi-computer
docker compose ps pi-computer
```

Open the desktop directly with noVNC:

```sh
xdg-open "http://127.0.0.1:6080/vnc.html"
```

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
curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null
curl -fsS http://127.0.0.1:8080/healthz
./scripts/smoke-api.sh
./scripts/smoke-novnc-auth.sh
./scripts/smoke-pi-harness.sh

docker compose port pi-computer 6080
# These should return nothing because raw VNC and CDP are intentionally not published:
docker compose port pi-computer 5900 || true
docker compose port pi-computer 9222 || true
```

### Browser task API

See [`docs/browser-task-api.md`](docs/browser-task-api.md) for access model, request/response shapes, lifecycle states, SSE events, artifact storage, and Pi bootstrap details. The smoke path is:

```sh
./scripts/smoke-api.sh
```

The API is intentionally declarative. It accepts a simple `open_url` smoke task plus a bounded `news_browse_summary` task that routes a human-English instruction through the real Pi harness with `pi-mcp-adapter` and the local Opera browser MCP path. It does not expose arbitrary shell, raw CDP commands, raw MCP messages, filesystem paths, environment variables, or arbitrary Pi CLI arguments.

For local validation with existing Pi authentication, point `.env` at the host auth file only:

```sh
cp .env.example .env
$EDITOR .env
```

Set `HOST_PI_AUTH_JSON` to the host auth file path. Do not mount the broader host `~/.pi/agent` directory into the container.

## Current Pi integration boundary

The real Pi harness is now installed and operator-authenticatable inside the container, but the supervised `/v1/*` browser task API still drives the repo-local stdio browser bridge directly for this slice. That keeps the existing noVNC/API/raw-port boundaries intact while making Pi available for interactive operator use, future task-runner cutover, and in-container auth/bootstrap validation.


### Runtime hardening baseline

Default Compose publishes only loopback-bound ingress ports: noVNC on `127.0.0.1:6080` and the task API on `127.0.0.1:8080`. Those endpoints are currently unauthenticated at the application layer and are intended for trusted local/internal use only. Raw VNC (`5900`), Opera CDP (`9222`), browser MCP, Supervisor, and noVNC backend internals are not host-published.

The container runs as UID/GID `1000:1000` with `no-new-privileges`, `cap_drop: [ALL]`, a read-only root filesystem, bounded tmpfs writable surfaces, `/dev/shm`, memory/CPU limits, and a PID limit. There is no built-in API/noVNC bearer-token or basic-auth gate in the current runtime; if you need broader exposure, add TLS/auth at a separate ingress instead of changing the default loopback binds. If you use local `.env` overrides, never commit real credentials or copied Pi auth material.

Run `./scripts/smoke-hardening.sh` after startup to verify runtime isolation, unpublished raw ports, sudo absence, compatibility sandbox flag reporting, and basic secret-redaction expectations for recent logs.

### Security notes for the MVP

The container is intended for local development and trusted internal access. noVNC and the task API are directly reachable on host loopback by default, so keep the default host binds unless a separate ingress adds the needed auth/TLS controls. Direct VNC uses `-nopw` only because x11vnc runs per connection in inetd mode without its own TCP listener, a TCP4-only relay listens on container IPv4 loopback, container IPv6 is disabled by Compose, and VNC is not exposed by Compose.

Opera is launched as the non-root `pi` user with CDP constrained to container loopback. This runtime keeps `no-new-privileges`; current Opera fails to initialize its setuid/user-namespace sandbox under that setting, so the existing `--no-sandbox` compatibility flag remains a residual risk until a sandbox-compatible runtime profile is available.

See [`docs/protected-opera-cdp-mcp.md`](docs/protected-opera-cdp-mcp.md) for the CDP/MCP topology, environment variables, smoke scripts, and limitations.
