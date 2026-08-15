# Authenticated browser task API

The pi-computer container now includes a minimal Node.js task API supervised inside the desktop container. It accepts constrained browser tasks and performs the MVP browser work through the internal stdio browser MCP bridge (`/usr/local/bin/pi-computer-browser-mcp`), which in turn talks to Opera CDP on container loopback.

## Authentication

All `/v1/*` endpoints require a bearer token:

```http
Authorization: Bearer <PI_COMPUTER_API_TOKEN>
```

For local development Compose defaults `PI_COMPUTER_API_TOKEN` to `local-dev-token-change-me`; operators should override it before sharing the loopback port. `/healthz` is unauthenticated for container readiness only.

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

Streams task events as authenticated Server-Sent Events (`text/event-stream`). Events include state transitions and browser bridge milestones.

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

- The implementation proves the authenticated API shape and real Opera/CDP/MCP browser path; it is not yet a full Pi `AgentSession` integration.
- noVNC operator access is now protected by a separate bearer/basic auth gate on the loopback-published local development port. Its token (`PI_COMPUTER_NOVNC_TOKEN`) is distinct from the API token (`PI_COMPUTER_API_TOKEN`) so rotating one control plane does not silently change the other.
- The default local token must be changed for any shared environment.
- Ephemeral profile cleanup is still provided by the existing browser/container lifecycle rather than a per-task Opera profile manager; deeper Pi SDK execution and task-scoped profile orchestration are the next runtime slice.
