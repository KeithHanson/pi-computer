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
- A minimal browser MCP-compatible smoke bridge is packaged as a stdio-only child process at `/usr/local/bin/pi-computer-browser-mcp`; no MCP port is published by Compose.
- noVNC operator access is published only on host loopback by default: `127.0.0.1:6080` (override with `NOVNC_HOST_PORT` for local port conflicts). The published endpoint is a Node.js loopback proxy; the noVNC/websockify backend listens only on container loopback.
- A Node.js browser-task API is published on host loopback by default: `127.0.0.1:8080` (override `API_HOST_PORT`).
- Compose allocates `1gb` `/dev/shm` for browser stability.
- Healthcheck verifies X display, Fluxbox, VNC IPv4 loopback relay, noVNC/websockify, Opera process, local noVNC HTTP, loopback VNC readiness/no IPv6 VNC reachability, CDP `/json/version`, and a non-mutating browser websocket readiness probe across the Runtime and Page CDP domains without wildcard CDP binding.
- Host-accessible runtime logs are written to `./runtime-logs/` by default.
- Host profile import is fail-fast and supports only a closed exported `opera-stable` snapshot created by `scripts/export-opera-profile.sh`; raw live profile mounts are rejected, empty profile DB files are allowed, and populated authenticated/session stores are rejected.

### Quick start

Build and start locally:

```sh
mkdir -p runtime-logs operator/opera-profile-export
docker compose build pi-computer
docker compose up -d pi-computer
```

Watch startup and health:

```sh
tail -F runtime-logs/*.log
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

### Supported host profile workflow

Primary blocker: authenticated Opera login/session state is not reliably portable by raw profile copy across machines or installs.
Secondary symptoms: importing a live profile or mixing Opera channels/version families makes restore even less reliable.

Supported import workflow:

1. Close the source Opera browser first.
2. Export a closed `opera-stable` snapshot on the host. The exporter allows normal empty Opera DB files from a signed-out closed profile, but still rejects populated login/session stores:
   ```sh
   ./scripts/export-opera-profile.sh --source /absolute/path/to/opera-profile --dest ./operator/opera-profile-export --browser-product opera-stable
   ```
3. Start the container with the default export mount or override `HOST_OPERA_PROFILE_EXPORT_DIR`.
4. If you need an authenticated session, sign in inside the container and keep the named `/home/pi` volume. Imported host login state is intentionally rejected.

### Runtime validation commands

Useful checks after `docker compose up -d`:

```sh
docker compose exec pi-computer /usr/local/bin/pi-computer-healthcheck
docker compose exec pi-computer sh -lc 'ss -ltnp 2>/dev/null || netstat -ltnp'
docker compose exec pi-computer nc -vz 127.0.0.1 5900
# This should fail because container IPv6 is disabled and x11vnc must not listen on :::5900:
docker compose exec pi-computer nc -vz ::1 5900
docker compose exec pi-computer curl -fsS http://127.0.0.1:9222/json/version
cat runtime-logs/profile-import-error.log
./scripts/smoke-cdp.sh
./scripts/smoke-browser-mcp.sh
./scripts/smoke-host-boundary.sh
docker compose exec pi-computer opera --version
curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null
curl -fsS http://127.0.0.1:8080/healthz
./scripts/smoke-api.sh
./scripts/smoke-novnc-auth.sh
docker compose port pi-computer 6080
# These should return nothing because raw VNC and CDP are intentionally not published:
docker compose port pi-computer 5900 || true
docker compose port pi-computer 9222 || true
```

### Browser task API

See [`docs/browser-task-api.md`](docs/browser-task-api.md) for access model, request/response shapes, lifecycle states, SSE events, artifact storage, and MVP limitations. The smoke path is:

```sh
./scripts/smoke-api.sh
```

The API is intentionally declarative. It accepts an `open_url` browser task and does not expose arbitrary shell, raw CDP commands, raw MCP messages, filesystem paths, environment variables, or Pi CLI arguments.


### Runtime hardening baseline

Default Compose publishes only loopback-bound authenticated ingress ports: noVNC on `127.0.0.1:6080` and the task API on `127.0.0.1:8080`. Raw VNC (`5900`), Opera CDP (`9222`), browser MCP, Supervisor, and noVNC backend internals are not host-published.

The container runs as UID/GID `1000:1000` with `no-new-privileges`, `cap_drop: [ALL]`, a read-only root filesystem, bounded tmpfs writable surfaces, `/dev/shm`, memory/CPU limits, and a PID limit. Change placeholder local tokens (`PI_COMPUTER_API_TOKEN`, `PI_COMPUTER_NOVNC_TOKEN`, `PI_COMPUTER_NOVNC_USERNAME`, `PI_COMPUTER_NOVNC_PASSWORD`) before shared use, and never commit real token values.

Run `./scripts/smoke-hardening.sh` after startup to verify runtime isolation, unpublished raw ports, sudo absence, compatibility sandbox flag reporting, and log token redaction expectations.

### Security notes for the MVP

The container is intended for local development and trusted internal access. noVNC and the task API are directly reachable on host loopback by default, so keep the default host binds unless a separate ingress adds the needed auth/TLS controls. Direct VNC uses `-nopw` only because x11vnc runs per connection in inetd mode without its own TCP listener, a TCP4-only relay listens on container IPv4 loopback, container IPv6 is disabled by Compose, and VNC is not exposed by Compose.

Opera is launched as the non-root `pi` user with CDP constrained to container loopback. This runtime keeps `no-new-privileges`; current Opera fails to initialize its setuid/user-namespace sandbox under that setting, so the existing `--no-sandbox` compatibility flag remains a residual risk until a sandbox-compatible runtime profile is available.

See [`docs/protected-opera-cdp-mcp.md`](docs/protected-opera-cdp-mcp.md) for the CDP/MCP topology, environment variables, smoke scripts, and limitations.
