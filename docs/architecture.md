# pi-computer MVP architecture

## Goals and context

pi-computer is a Dockerized Pi browser computer: a remotely observable desktop, Opera browser automation, an internal MCP bridge, and a Node.js API for browser-related tasks. It borrows the useful display/process ideas from the prior `arch-no-vnc-xfce4-docker` attempt (Xvfb, XFCE, x11vnc, noVNC, `tini`, Supervisor) while replacing unsafe defaults such as rolling Arch base images, passwordless sudo, direct public VNC, and floating Git clones.

## Architecture decisions

### Base image

- Use Debian 12 or Ubuntu 24.04 LTS, pinned by digest in release builds.
- Prefer distro packages or pinned upstream release artifacts with checksums for noVNC/websockify; do not clone a moving Git branch at build time.
- Install Opera from the official Opera repository or installer path only after confirming redistribution terms. If redistribution is not acceptable, publish an image recipe that installs Opera at build time and keep Chromium as a possible redistributable fallback.
- Use multi-stage builds for Node dependencies and runtime assets.
- Run the final image as a dedicated non-root app/browser UID. No passwordless sudo is installed or needed in the runtime image.

### Desktop and browser stack

Decision: use Xvfb plus Openbox for the smallest MVP desktop unless early manual testing proves XFCE is needed for Opera usability, input methods, or file dialogs.

Rationale:

- Openbox is lighter, faster to start, and easier to supervise.
- XFCE remains an allowed fallback because the prior image already proved the Xvfb/XFCE/x11vnc/noVNC pattern works.
- The MVP does not need a full end-user desktop environment; noVNC exists mainly for operator inspection and emergency control.

Opera runs inside the X display as the non-root browser user with:

- a dedicated `--user-data-dir` per task by default;
- CDP bound only to loopback or an equivalent private internal boundary;
- Chromium sandbox enabled;
- adequate `/dev/shm` supplied by Docker/Compose rather than `--no-sandbox` workarounds.

### Process graph

`tini` is PID 1 and execs Supervisor. Supervisor starts and monitors collaborating processes:

```text
tini
└── supervisord
    ├── Xvfb :99
    ├── dbus/session helpers as needed
    ├── openbox (or xfce4-session fallback)
    ├── x11vnc bound to 127.0.0.1:5900
    ├── websockify/noVNC bound to loopback
    ├── Opera launcher/readiness helper
    ├── MCP browser bridge bound to stdio or loopback only
    ├── Node.js API/task worker
    └── ingress proxy (or external sidecar in later deployments)
```

Supervisor config should forward logs to stdout/stderr, use stop groups, set restart limits, and avoid shell loops as the primary lifecycle mechanism. Readiness must validate a real browser/CDP target and API health, not just process existence.

### Ports and ingress

Default published port: one authenticated HTTP(S) ingress, initially `8080` for local development.

Internal-only ports/boundaries:

- `127.0.0.1:5900` x11vnc only;
- loopback websockify/noVNC backend only;
- loopback/private CDP only;
- loopback or stdio MCP only;
- Node API may bind loopback if fronted by an internal proxy.

The ingress routes:

- `/v1/*` to the Node API;
- `/events/*` or task-scoped SSE/WebSocket endpoint to the API;
- `/novnc/*` to authenticated noVNC assets/websocket proxy.

No default deployment publishes raw VNC, CDP, MCP, or Supervisor control ports.

### Volumes and filesystem

Default writable areas:

- task workspace/artifacts, bounded and retained according to policy;
- task-scoped browser profile under a runtime directory;
- downloads directory scoped to the task;
- `/tmp`, browser runtime dirs, and `/dev/shm` as tmpfs or bounded Docker mounts.

Recommended runtime controls:

- read-only root filesystem where practical;
- `tmpfs` for temporary paths;
- explicit named volume only for optional persistent profiles/artifacts;
- no Docker socket mount;
- no `--privileged`;
- drop Linux capabilities and use `no-new-privileges` unless a documented browser dependency requires an exception.

### Node API and session model

The public API is asynchronous, authenticated, and declarative. It accepts browser tasks, not arbitrary automation commands.

Initial endpoints:

- `POST /v1/tasks` returns `202 { "taskId": "..." }`.
- `GET /v1/tasks/:taskId` returns task status, timestamps, result summary, and artifact manifest when available.
- `GET /v1/tasks/:taskId/events` streams authenticated SSE events; WebSocket can be added if bidirectional client events become necessary.
- `POST /v1/tasks/:taskId/cancel` requests cooperative cancellation.
- `GET /v1/artifacts/:artifactId` serves authorized artifacts by manifest reference.

Example task shape:

```json
{
  "instruction": "Open the provided page and summarize the visible content.",
  "startUrl": "https://example.com/",
  "timeoutSeconds": 300,
  "profilePolicy": "ephemeral"
}
```

Validation requirements:

- authenticate every endpoint including noVNC;
- cap request body size, instruction length, timeout, redirects, artifact size, and event history;
- restrict URL schemes to `http`/`https` unless explicitly configured;
- reject arbitrary shell, process, environment, filesystem path, raw MCP, and raw CDP inputs;
- expose cancellation and idempotent status rather than synchronous long-running responses.

### Pi SDK integration

Preferred integration is the Node SDK `AgentSession` from `@earendil-works/pi-coding-agent`. Existing Pi documentation says Node apps should prefer `AgentSession` over subprocess RPC. The task runner therefore creates and owns an `AgentSession` per active task or per container lifecycle, depending on SDK startup cost discovered during implementation.

Responsibilities of the task runner:

- create task workspace, profile, and artifact manifest;
- construct a constrained prompt/instruction for Pi;
- attach only the browser MCP capabilities required for the task;
- stream state transitions/events back to the API;
- capture screenshots/downloads/log summaries as artifacts;
- redact secrets from logs where practical;
- cancel and clean up profiles/workspaces according to policy.

Fallback caveat: subprocess/RPC integration may be documented later only if the SDK cannot support long-running browser-task sessions, cancellation, or event streaming. That fallback must preserve the same API and security boundary.

### MCP and CDP topology

MCP is an internal capability boundary between Pi and browser automation. It is not a public API.

```text
Node task runner
  -> Pi AgentSession
      -> internal MCP bridge/tool allowlist
          -> browser MCP implementation
              -> Opera CDP bound to loopback/private boundary
```

Rules:

- MCP tools are allowlisted by task type.
- Tool calls are logged by task id, tool name, duration, and outcome; page secrets and full DOM dumps are not logged by default.
- JSON-RPC message sizes and result sizes are capped.
- Webpage content can influence task reasoning but cannot authorize host/filesystem/secret access, new tools, new network zones, or policy changes.
- CDP websocket URLs are never returned to API callers and never placed on a shared/public Docker network.

### Task state lifecycle

Initial states:

1. `queued` - task accepted and persisted.
2. `starting` - workspace/profile/session setup begins.
3. `running` - Pi is actively driving Opera.
4. `awaiting_attention` - optional operator intervention through noVNC is needed or policy requires confirmation.
5. `cancelling` - cancellation requested and cleanup is underway.
6. `succeeded` - task completed with result and artifact manifest.
7. `failed` - task ended with a categorized error.
8. `cancelled` - task was stopped by caller/operator.
9. `expired` - task exceeded timeout or retention window.

For MVP, one active task runs per container. Additional submissions may be rejected with `409/429` or placed in a small bounded queue. A fresh ephemeral profile is the default for every task. Persistent profile use must be explicit in the request and backed by a named profile id with operator-controlled retention.

### Scaling model

MVP scaling is horizontal: run more containers rather than multiple independent browser users inside one display/profile. A scheduler or consumer service can assign one task to one available container. Future versions may add an external queue, per-user containers, or VM/microVM isolation for hostile workloads.

SQLite or an in-memory store with durable artifact manifests is sufficient for the single-appliance MVP. External databases/queues are non-goals until there is real multi-container scheduling.

### Local development workflow

Expected future workflow:

1. Build the image with pinned dependencies.
2. Start Compose with one published ingress port, bounded `/dev/shm`, and security options.
3. Submit a task to the authenticated API.
4. Observe task events and, if necessary, inspect the desktop through authenticated noVNC.
5. Verify no raw VNC/CDP/MCP ports are reachable from the host.

### MVP non-goals

- Arbitrary shell/API execution as a service.
- Public raw CDP, MCP, VNC, or Supervisor access.
- Multi-tenant browser sessions within one container.
- Passwordless sudo or privileged containers.
- Fully autonomous handling of sensitive account actions without policy gates.
- Production-grade distributed scheduling.
- Confirming Opera legal redistribution through code; that is a release gate needing human/legal review.
- Replacing `daily-briefing`; it is a first consumer, not the only supported use case.
