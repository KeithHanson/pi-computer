# pi-computer

An open-source, containerized Pi-powered browser computer with remote desktop access and a task API.

## Minimal desktop container MVP

This repository currently provides a Docker/Compose foundation for a local graphical Linux desktop running Opera behind noVNC.

### What is included

- Debian 12 slim base image.
- Non-root `pi` runtime user; no sudo package and no passwordless sudo.
- `dumb-init` + `supervisord` process supervision.
- Xvfb virtual display, Fluxbox window manager, x11vnc, noVNC/websockify, and Opera Stable.
- Direct VNC listens only on container loopback (`127.0.0.1:5900`) and is not published by Compose.
- noVNC is published only on host loopback by default: `127.0.0.1:6080`.
- Compose allocates `1gb` `/dev/shm` for browser stability.
- Healthcheck verifies X display, Fluxbox, x11vnc, noVNC/websockify, Opera process, local noVNC HTTP, and loopback VNC readiness.

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

Open the desktop:

```text
http://127.0.0.1:6080/vnc.html
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
docker compose exec pi-computer opera --version
curl -fsSI http://127.0.0.1:6080/vnc.html
docker compose port pi-computer 6080
# This should return nothing because VNC is intentionally not published:
docker compose port pi-computer 5900 || true
```

### Security notes for the MVP

The container is intended for local development only. noVNC has no application-level authentication in this MVP, so Compose binds it to host loopback. Do not publish port 6080 on a public interface without adding authentication and transport security. Direct VNC uses `-nopw` only because it listens on container loopback and is not exposed by Compose.

Opera is launched with `--no-sandbox` because Chromium-family browsers commonly cannot initialize their sandbox inside restricted containers without additional host configuration. The container compensates partially with a non-root browser user and Compose `no-new-privileges`, but this is still a known MVP limitation.
