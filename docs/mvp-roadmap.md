# pi-computer MVP roadmap

This roadmap maps the current Bead plan into an implementation order that preserves the security boundaries established in the architecture and threat model.

## Bead slices

- `pi-exoself-h67` - Epic: pi-computer.
- `pi-exoself-h67.1` - Container and desktop platform.
  - `pi-exoself-h67.1.1` - Define pi-computer MVP architecture and threat model.
  - `pi-exoself-h67.1.2` - Build minimal desktop container with Opera and noVNC.
- `pi-exoself-h67.2` - Pi runtime and task API.
  - `pi-exoself-h67.2.1` - Implement authenticated Node.js browser-task API.
- `pi-exoself-h67.3` - Opera and MCP browser automation.
  - `pi-exoself-h67.3.1` - Package protected Opera CDP and browser MCP integration.
- `pi-exoself-h67.4` - Remote desktop access.
  - `pi-exoself-h67.4.1` - Add authenticated VNC and noVNC operator access.
- `pi-exoself-h67.5` - Security, isolation, and operations.
  - `pi-exoself-h67.5.1` - Harden secrets, network boundaries, and runtime isolation.
- `pi-exoself-h67.6` - Open-source packaging and daily-briefing integration.
  - `pi-exoself-h67.6.1` - Document and validate daily-briefing as the first consumer.

## Recommended implementation order

1. **Architecture baseline (`h67.1.1`)**
   - Land README, architecture, threat model, and roadmap.
   - Make the security invariants reviewable before code exists.

2. **Minimal desktop container (`h67.1.2`)**
   - Build the pinned Debian/Ubuntu LTS image.
   - Add non-root user, Xvfb, Openbox/XFCE fallback, x11vnc loopback-only, noVNC/websockify, `tini`, and Supervisor.
   - Add Compose with one published ingress port placeholder and adequate `/dev/shm`.
   - Validate Opera launch, sandbox status, and no externally reachable raw VNC/CDP/MCP ports.

3. **Protected Opera CDP and MCP integration (`h67.3.1`)**
   - Launch Opera with task/profile directories and loopback/private CDP.
   - Package the Opera/browser MCP bridge internally with tool allowlists and logging.
   - Smoke-test CDP/MCP compatibility for the pinned browser version.
   - Keep raw CDP and MCP unavailable to public callers.

4. **Authenticated task API (`h67.2.1`)**
   - Implement `POST /v1/tasks`, `GET /v1/tasks/:id`, `GET /v1/tasks/:id/events`, cancellation, and artifact manifest endpoints.
   - Integrate Pi through `AgentSession` from `@earendil-works/pi-coding-agent` as the preferred path.
   - Enforce declarative browser-task validation and one active task per container.
   - Implement task states, timeouts, cancellation, and profile cleanup.

5. **Authenticated operator desktop (`h67.4.1`)**
   - Put noVNC behind the authenticated ingress.
   - Add origin/CSRF controls, idle timeout, and operator access documentation.
   - Confirm direct `5900` remains loopback-only and unpublished.

6. **Security and operations hardening (`h67.5.1`)**
   - Add capability drops, `no-new-privileges`, read-only root filesystem where practical, bounded tmpfs, resource limits, and egress controls.
   - Add secret redaction, artifact retention/deletion policy, and port-boundary tests.
   - Decide the minimum viable persistence model for named profiles.

7. **Packaging and first consumer (`h67.6.1`)**
   - Resolve Opera redistribution/licensing for public images.
   - Document local quick start and deployment warnings.
   - Validate `daily-briefing` against the authenticated task API without coupling pi-computer to that single consumer.

## Release gates

Before an MVP release:

- Opera licensing/redistribution path is documented.
- The image does not require root, passwordless sudo, `--privileged`, Docker socket, or `--no-sandbox`.
- Only the authenticated ingress port is published by default.
- Raw VNC, CDP, MCP, and Supervisor ports are private.
- `AgentSession` integration is proven or a documented fallback preserves the same boundaries.
- At least one end-to-end browser task completes, emits events, returns an artifact manifest, and cleans up its ephemeral profile.
- A `daily-briefing` smoke path demonstrates the first consumer while keeping the API reusable.
