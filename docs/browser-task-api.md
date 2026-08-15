# Browser task API

The pi-computer container now includes a minimal Node.js task API supervised inside the desktop container. It accepts constrained browser tasks and performs the MVP browser work through the internal stdio browser MCP bridge (`/usr/local/bin/pi-computer-browser-mcp`), which in turn talks to Opera CDP on container loopback.

## Access model

`/healthz` and `/v1/*` are directly reachable on the loopback-published API port. This deployment model assumes host firewalls and internal network boundaries provide the protection layer, so the API no longer enforces bearer tokens.

## Endpoints

### `GET /healthz`

Returns readiness for the API process and task store path.

### `POST /v1/tasks`

Submits one asynchronous browser task. The MVP allows one active task per container and supports only `open_url`.

Request:

```json
{
  "taskType": "open_url",
  "startUrl": "https://example.com/",
  "instruction": "Open the page for smoke validation.",
  "timeoutSeconds": 60,
  "profilePolicy": "ephemeral"
}
```

Constraints:

- `startUrl` must use `http`, `https`, or `about`.
- only `taskType: "open_url"` is implemented;
- only `profilePolicy: "ephemeral"` is accepted;
- unsupported fields are rejected;
- callers cannot provide shell commands, raw CDP, raw MCP, filesystem paths, environment variables, or Pi CLI arguments.

Response: `202` with a task document and `Location: /v1/tasks/<taskId>`.

### `GET /v1/tasks/:taskId`

Returns status, timestamps, request echo, result summary, artifact manifest, and any categorized error.

Task states used by this implementation: `queued`, `starting`, `running`, `cancelling`, `succeeded`, `failed`, and `cancelled`.

### `GET /v1/tasks/:taskId/events`

Streams task events as unauthenticated Server-Sent Events (`text/event-stream`). Events include state transitions and browser bridge milestones.

### `POST /v1/tasks/:taskId/cancel`

Requests cooperative cancellation. The MVP task is intentionally short, so cancellation is most reliable before browser bridge calls begin; completed tasks are returned unchanged.

## Artifacts and persistence

Task state and artifacts are persisted under:

```text
/home/pi/pi-computer/tasks/<taskId>/
  task.json
  events.jsonl
  artifacts/<artifactId>-browser-observation.json
```

The browser observation artifact records the submitted request, CDP browser version metadata, navigation response, and target list returned through the internal bridge. API responses include artifact IDs and metadata only; operators can inspect the local store out of band with `docker compose exec`.

## Limitations and next steps

- The implementation proves the loopback-published API shape and real Opera/CDP/MCP browser path; it is not yet a full Pi `AgentSession` integration.
- noVNC operator access is also direct on the loopback-published local development port; rely on host/network controls for non-local deployments.
- Ephemeral profile cleanup is still provided by the existing browser/container lifecycle rather than a per-task Opera profile manager; deeper Pi SDK execution and task-scoped profile orchestration are the next runtime slice.

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
