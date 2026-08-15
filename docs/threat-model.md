# pi-computer threat model

## Scope

This threat model covers the MVP pi-computer container: Node task API, Pi AgentSession integration, internal MCP/browser bridge, Opera with CDP, Xvfb desktop, x11vnc, noVNC/websockify, task artifacts, and optional browser profile persistence.

## Assumptions

- The default deployment is single-user and single-tenant.
- One active browser task runs per container.
- External access is limited to loopback-published or otherwise trusted internal API/noVNC ports unless a separate ingress is added.
- Browser pages, downloads, screenshots, and task instructions may be hostile or sensitive.
- A normal Docker container reduces blast radius but is not a complete sandbox for hostile tenants or browser zero-days.

## Severity-ranked risks and mitigations

### Critical: unauthenticated or public noVNC/VNC exposure

Risk: noVNC or VNC gives interactive desktop control. An attacker can view pages, type into logged-in sessions, download files, alter tasks, and steal secrets.

Mitigations:

- Bind x11vnc only to `127.0.0.1:5900`.
- Do not publish host port `5900`.
- Keep the published noVNC endpoint on host loopback or another trusted internal boundary.
- If exposure broadens beyond that boundary, add TLS/auth/origin controls in a separate ingress layer.
- Add smoke tests that fail if VNC/CDP/MCP ports are reachable externally.

### Critical: public CDP exposure

Risk: CDP can inspect pages, execute JavaScript, navigate, read cookies/storage, drive downloads, and take over browser identity.

Mitigations:

- Bind Opera remote debugging only to loopback or a private internal boundary.
- Never return CDP websocket URLs from public APIs.
- Never attach CDP to a shared Docker network.
- Use task-scoped `--user-data-dir`; do not remote-debug a default personal profile.
- Keep Chromium sandbox enabled and patch Opera promptly.

### Critical: browser prompt injection

Risk: hostile webpage content can instruct the agent to exfiltrate secrets, ignore policies, click destructive controls, or invoke unrelated tools.

Mitigations:

- Treat webpage text as untrusted data, not authorization.
- Provide least-privilege MCP tool allowlists per task type.
- Require confirmation or explicit policy for sensitive domains/actions.
- Keep secrets out of prompts and logs where possible.
- Limit browser tasks to declared goals, allowed URL scopes, and bounded artifacts.

### Critical: SSRF, intranet reachability, and egress abuse

Risk: user-provided URLs or page redirects can reach cloud metadata services, link-local addresses, internal admin panels, or exfiltration endpoints.

Mitigations:

- Restrict accepted URL schemes to `http` and `https` by default.
- Block metadata, loopback, link-local, and private network ranges unless explicitly allowed.
- Add outbound allowlists for sensitive deployments.
- Cap redirects, downloads, request duration, and artifact size.
- Log destination domains/IP classes for audit without logging secrets.

### High: MCP/tool confused deputy

Risk: public callers or webpages could coerce Pi/MCP tools into using host, filesystem, secret, or browser privileges for a purpose outside the user's authorization.

Mitigations:

- Do not expose raw MCP messages publicly.
- Validate schemas and cap JSON-RPC message/result sizes.
- Attach task identity and policy to every tool call.
- Allowlist tools by task type and deny host/filesystem/secret tools unless explicitly required.
- Log tool name, duration, and outcome for audit; redact page and credential data.

### High: secrets and profile persistence

Risk: cookies, local storage, screenshots, downloaded files, task logs, videos, and artifact manifests may contain credentials or personal data.

Mitigations:

- Default to ephemeral profiles per task.
- Make persistent profiles optional, named, and explicit.
- Store artifacts under task-scoped directories with retention/deletion policy.
- Redact Authorization headers, cookies, and known secret formats from logs where practical.
- Avoid mounting broad host directories; use narrow named volumes only.

### High: container escape and browser zero-days

Risk: a compromised browser renderer, extension, download handler, or desktop service might escape the browser sandbox or container.

Mitigations:

- Run as a non-root UID with no passwordless sudo.
- Keep Opera's sandbox enabled; do not use `--no-sandbox`.
- Use Docker default seccomp, drop capabilities, set `no-new-privileges`, and avoid privileged mode.
- Use read-only root filesystem and bounded tmpfs where practical.
- Do not mount Docker socket or host devices.
- Patch OS/browser dependencies and consider VM/microVM isolation for hostile workloads.

### High: unintended API/noVNC exposure beyond the trusted boundary

Risk: the loopback/internal API can start tasks in authenticated browser contexts and retrieve artifacts, while noVNC exposes interactive desktop control.

Mitigations:

- Keep API and noVNC bound to host loopback or another trusted internal boundary by default.
- Add separate ingress-layer auth/TLS before publishing beyond that boundary.
- Separate task ownership from operator/admin abilities when a broader ingress is introduced.
- Rate-limit task creation at the ingress layer if exposure broadens.
- Cap concurrent tasks to one active task per container for MVP.

### High: Opera redistribution/licensing

Risk: Opera is proprietary; redistributing a public image containing Opera may violate license terms or block open-source publication.

Mitigations:

- Treat license verification as a release gate.
- Prefer a Dockerfile recipe that installs Opera from official sources at build time if redistribution is unclear.
- Document Chromium as a possible fully redistributable fallback if Opera cannot be bundled.
- Pin and smoke-test the selected browser version and automation flags.

### Medium: noVNC/websockify supply-chain drift

Risk: floating Git clones or unpinned assets can silently introduce vulnerabilities or breaking changes.

Mitigations:

- Use distro packages or pinned upstream releases with checksums.
- Track versions in the Dockerfile and release notes.
- Rebuild regularly for security patches.

### Medium: GUI reliability and artifact leakage

Risk: Xvfb, window manager, fonts, DBus, `/dev/shm`, downloads, or clipboard behavior may fail or leak across tasks.

Mitigations:

- Use readiness tests that open an actual page through Opera/CDP.
- Provide sufficient bounded `/dev/shm`.
- Clear clipboard/downloads/profile between ephemeral tasks.
- Record artifacts by manifest and retention policy.

## Default deny rules

The MVP should deny by default:

- direct host publication of VNC, CDP, MCP, or Supervisor;
- arbitrary shell commands from API requests;
- arbitrary filesystem path reads/writes;
- Docker socket access;
- privileged containers;
- passwordless sudo;
- persistent profiles unless explicitly requested;
- webpage-originated authorization changes.

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
