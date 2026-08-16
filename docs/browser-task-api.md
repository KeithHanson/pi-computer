# Browser task API

The pi-computer container includes a supervised Node.js task API inside the desktop container. It accepts constrained browser tasks. The simple `open_url` smoke task still uses the internal stdio browser MCP bridge directly, while the richer `news_browse_summary` task delegates a bounded natural-language instruction through the real Pi harness (`pi`) with `pi-mcp-adapter` and the local Opera browser MCP configuration.

## Access model

`/healthz` and `/v1/*` are directly reachable on the loopback-published API port. This deployment model assumes host firewalls and internal network boundaries provide the protection layer, so the API does not expose bearer-token auth in this MVP.

## Pi harness bootstrap

The image installs and uses:

- the Pi harness CLI at `/usr/local/bin/pi`;
- `pi-mcp-adapter` in the container Pi agent environment;
- `opera-devtools-mcp` configured through the standard shared MCP file `/home/pi/.config/mcp/mcp.json` to target `http://127.0.0.1:9222`.

At container start, `/usr/local/bin/pi-computer-bootstrap-pi` imports only `auth.json` from an optional host-provided auth-only bind mount and writes the shared MCP config that `pi-mcp-adapter` auto-discovers for this Pi version. The richer task path does not pass `--mcp-config`; it relies on supported ambient config discovery. Bootstrap does **not** import host prompts, skills, sessions, subagents, or broader Pi settings.

Use `.env.example` as the template for local setup. If you want the container to reuse host Pi authentication, create a narrow directory containing only `auth.json` and set:

```dotenv
HOST_PI_AUTH_JSON=/absolute/path/to/auth.json
```

That single host file is mounted read-only at `/opt/pi-host-auth/auth.json` and consumed only during bootstrap.

## Endpoints

### `GET /healthz`

Returns API readiness, task store path, and the configured Pi harness binary/MCP config path plus config-discovery mode.

### `POST /v1/tasks`

Submits one asynchronous browser task. This implementation allows one active task per container.

#### `taskType: "open_url"`

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
- `profilePolicy` must be `ephemeral`.
- unsupported fields are rejected.

#### `taskType: "news_browse_summary"`

Request:

```json
{
  "taskType": "news_browse_summary",
  "instruction": "Open the top news articles on news.google.com and summarize their contents.",
  "timeoutSeconds": 180,
  "profilePolicy": "ephemeral",
  "maxArticles": 3
}
```

Behavior:

- the landing page is fixed to Google News;
- the caller supplies a natural-language instruction only, not raw browser commands;
- the API builds a bounded Pi prompt, runs `pi -p` with only MCP-backed browser access, and expects structured JSON back;
- the Pi run uses the installed `pi-mcp-adapter` shared-config discovery path instead of an explicit `--mcp-config` flag;
- `maxArticles` is capped server-side;
- callers cannot pass shell commands, raw MCP messages, raw CDP commands, filesystem paths, environment variables, or arbitrary Pi CLI flags.

Response: `202` with a task document and `Location: /v1/tasks/<taskId>`.

### `GET /v1/tasks/:taskId`

Returns status, timestamps, request echo, selected runner metadata, result summary, artifact manifest, and any categorized error.

Task states used by this implementation: `queued`, `starting`, `running`, `cancelling`, `succeeded`, `failed`, and `cancelled`.

### `GET /v1/tasks/:taskId/events`

Streams task events as unauthenticated Server-Sent Events (`text/event-stream`). Events include state transitions plus runner milestones such as `runner.selected`, `browser.navigate`, `pi.started`, and `pi.completed`.

For `news_browse_summary`, the API now also emits incremental `pi.stdout` and `pi.stderr` events while the Pi harness is still running, so an operator can watch the bounded harness output live instead of waiting only for terminal artifacts.

### `GET /v1/runtime/logs/:name?lines=<n>`

Returns the last `n` lines of a supervised runtime log as plain text (`text/plain`). This is intended for live debugging from outside the container without opening a shell.

Useful names include:

- `opera.log`
- `opera.err.log`
- `opera-browser.log`
- `api.log`
- `api.err.log`
- `supervisord.log`

Example:

```sh
curl -fsS 'http://127.0.0.1:8080/v1/runtime/logs/opera-browser.log?lines=200'
```

### `POST /v1/tasks/:taskId/cancel`

Requests cooperative cancellation. Cancellation is best-effort and most reliable before a browser bridge or Pi harness run starts.

## Artifacts and persistence

Task state and artifacts are persisted under:

```text
/home/pi/pi-computer/tasks/<taskId>/
  task.json
  events.jsonl
  artifacts/<artifactId>-browser-observation.json
  artifacts/<artifactId>-news-summary.json
  artifacts/<artifactId>-pi-harness-output.txt
  artifacts/<artifactId>-pi-harness-stderr.txt
```

`open_url` writes a browser observation artifact with CDP version metadata, navigation response, and targets. `news_browse_summary` writes:

- the structured summary JSON returned through the Pi harness;
- raw Pi stdout;
- Pi stderr for troubleshooting.

For live observation during a running task, prefer `GET /v1/tasks/:taskId/events` and filter for `pi.stdout` / `pi.stderr`.

API responses include artifact IDs and metadata only; operators can inspect the local store out of band with `docker compose exec`.

## Limitations

- The bounded natural-language task currently targets Google News traversal/summarization only; it is not a general remote browser automation surface.
- The Pi harness run is constrained by prompt design and CLI flags, but browser prompt-injection risk still exists within the visited pages.
- noVNC operator access remains loopback-published for local development and still relies on host/network controls.
- The container now resets Opera to a fresh runtime profile/cache on each browser start to avoid stale-tab and profile-corruption reuse across restarts, but fully isolated per-task browser profile orchestration is still not implemented.

## Runtime hardening defaults

Compose runs the desktop as UID/GID `1000:1000` with `no-new-privileges`, `cap_drop: [ALL]`, a read-only root filesystem, bounded tmpfs writable surfaces, `/dev/shm`, CPU/memory limits, and a PID limit. The only default host-published ports are loopback-bound noVNC on `127.0.0.1:6080` and the task API on `127.0.0.1:8080`. Those endpoints are currently unauthenticated in-app and rely on host/network boundaries for protection. Raw VNC (`5900`), Opera CDP (`9222`), browser MCP stdio, Supervisor, and noVNC backend internals are not published.

Writable runtime surfaces are intentionally narrow:

- `/home/pi` via the `pi-computer-home` volume for the non-root home, Opera profile, downloads, Pi auth/task state, and task store;
- `/tmp`, `/run`, `/var/log/pi-computer`, and `/var/run/pi-computer` as bounded tmpfs mounts;
- Docker-managed `/dev/shm` sized by `shm_size` for browser stability.

Do not add host directory mounts, Docker socket mounts, `privileged: true`, `cap_add`, wildcard host binds, or raw `5900`/`9222` port mappings without a new threat-model review.

## Pi harness secrets and log hygiene

The current runtime does not configure application-layer API or noVNC tokens. Protect `127.0.0.1:8080` and `127.0.0.1:6080` with loopback/internal network boundaries, and add a separate ingress with TLS/auth if those endpoints must be shared beyond a trusted host or private network.

Pi/provider credentials remain sensitive. Keep real provider API keys, imported Pi `auth.json`, cookies, and other browser/session secrets out of the repository, shell history, screenshots, issue text, and committed Compose overrides.

Log expectations: services must not print Authorization headers, cookies, provider API keys, Pi auth material, CDP websocket URLs, or page secrets. Smoke checks scan recent Compose logs for obvious secret values, but that is not a substitute for reviewing new logging code.

Sandbox compatibility note: Opera currently retains the `--no-sandbox` flag because the tested Docker runtime blocks both the setuid sandbox under `no-new-privileges` and unprivileged namespace sandbox startup. This is a known residual risk, offset only partially by non-root execution, dropped capabilities, read-only rootfs, unpublished raw control ports, and Docker isolation. Revisit before production or hostile browsing use.
