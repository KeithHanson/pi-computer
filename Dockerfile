# syntax=docker/dockerfile:1
FROM debian:12-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG USERNAME=pi
ARG UID=1000
ARG GID=1000

ENV DISPLAY=:1 \
    NOVNC_PORT=6080 \
    NOVNC_BACKEND_PORT=6081 \
    VNC_PORT=5900 \
    CDP_HOST=127.0.0.1 \
    CDP_PORT=9222 \
    BROWSER_MCP_TRANSPORT=stdio \
    API_HOST=0.0.0.0 \
    API_PORT=8080 \
    PI_COMPUTER_TASK_STORE=/home/pi/pi-computer-tasks \
    PI_COMPUTER_LOG_DIR=/home/pi/pi-computer-logs \
    OPERA_PROFILE_DIR=/home/pi/.config/opera \
    OPERA_FROZEN_PROFILE_DIR=/home/pi/opera-profile-frozen \
    OPERA_HOST_PROFILE_EXPORT_DIR=/mnt/host-opera-profile-export \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    SCREEN_DEPTH=24 \
    HOME=/home/pi \
    XDG_CONFIG_HOME=/home/pi/.config \
    XDG_CACHE_HOME=/home/pi/.cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg apt-transport-https \
      dumb-init supervisor procps net-tools netcat-openbsd socat feh \
      nodejs \
      python3 python3-websocket \
      xvfb x11-utils x11vnc fluxbox dbus-x11 gsettings-desktop-schemas \
      novnc websockify \
      fonts-liberation fonts-dejavu-core libasound2 libatk-bridge2.0-0 libatk1.0-0 \
      libcups2 libdrm2 libgbm1 libgtk-3-0 libnss3 libu2f-udev libxcomposite1 \
      libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
    && install -d -m 0755 /etc/apt/keyrings \
    && wget -qO- https://deb.opera.com/archive.key | gpg --dearmor > /etc/apt/keyrings/opera.gpg \
    && echo 'deb [signed-by=/etc/apt/keyrings/opera.gpg] https://deb.opera.com/opera-stable/ stable non-free' > /etc/apt/sources.list.d/opera-stable.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends opera-stable \
    && groupadd --gid "${GID}" "${USERNAME}" \
    && useradd --uid "${UID}" --gid "${GID}" --create-home --shell /bin/bash "${USERNAME}" \
    && mkdir -p /var/log/pi-computer /var/run/pi-computer /home/pi/.config/opera /home/pi/Downloads /home/pi/pi-computer-logs /home/pi/pi-computer-tasks /home/pi/opera-profile-frozen /mnt/host-opera-profile-export \
    && chown -R "${USERNAME}:${USERNAME}" /var/log/pi-computer /var/run/pi-computer /home/pi /mnt/host-opera-profile-export \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY container/supervisor/supervisord.conf /etc/supervisor/supervisord.conf
COPY container/bin/ /usr/local/bin/
COPY container/api/ /opt/pi-computer/api/
COPY container/novnc-gate/ /opt/pi-computer/novnc-gate/
COPY container/fluxbox-init /opt/pi-computer/fluxbox-init
COPY container/fluxbox-menu /opt/pi-computer/fluxbox-menu
RUN chmod +x /usr/local/bin/pi-computer-* /opt/pi-computer/api/server.js /opt/pi-computer/novnc-gate/server.js

USER pi
WORKDIR /home/pi
EXPOSE 6080 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=35s --retries=5 CMD ["/usr/local/bin/pi-computer-healthcheck"]
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
