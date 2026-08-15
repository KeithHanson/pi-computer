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
- keep Opera's Chromium sandbox enabled;
- run as a non-root user without passwordless sudo;
- default to ephemeral browser profiles and short artifact retention;
- assume webpage content can be hostile prompt-injection input.

The MVP container is not a complete sandbox for mutually hostile users or arbitrary untrusted code. Stronger isolation, such as one container/VM per user or per task, is required for hostile multi-tenant deployments.

## Quick-start placeholder

Implementation is intentionally not present yet. The expected development shape is:

```bash
# future, illustrative only
cp .env.example .env
# set API auth token and ingress settings
docker compose up --build
curl -H "Authorization: Bearer $PI_COMPUTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instruction":"Open example.com and summarize the page"}' \
  http://localhost:8080/v1/tasks
```

Until the container, API, and compose files are implemented, use the docs in `docs/` as the source of truth for scope and security constraints.
