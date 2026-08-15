# syntax=docker/dockerfile:1
FROM debian:12-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG USERNAME=pi
ARG UID=1000
ARG GID=1000
ARG NODE_VERSION=v22.23.2
ARG PI_VERSION=0.84.1
ARG PI_MCP_ADAPTER_VERSION=2.21.2
ARG OPERA_DEVTOOLS_MCP_VERSION=latest

ENV DISPLAY=:1 \
    NOVNC_PORT=6080 \
    NOVNC_BACKEND_PORT=6081 \
    VNC_PORT=5900 \
    CDP_HOST=127.0.0.1 \
    CDP_PORT=9222 \
    BROWSER_MCP_TRANSPORT=stdio \
    API_HOST=0.0.0.0 \
    API_PORT=8080 \
    PI_COMPUTER_TASK_STORE=/home/pi/pi-computer/tasks \
    PI_HARNESS_BIN=/usr/local/bin/pi \
    PI_HARNESS_MCP_CONFIG=/home/pi/.mcp.json \
    PI_HARNESS_PROVIDER=openai-codex \
    PI_HARNESS_MODEL=gpt-5.4 \
    PI_HARNESS_SESSION_DIR=/home/pi/pi-computer/pi-sessions \
    PI_HARNESS_MAX_INSTRUCTION_CHARS=4000 \
    PI_BROWSER_TASK_MAX_ARTICLES=5 \
    PI_HOST_AUTH_DIR=/opt/pi-host-auth \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    SCREEN_DEPTH=24 \
    HOME=/home/pi \
    XDG_CONFIG_HOME=/home/pi/.config \
    XDG_CACHE_HOME=/home/pi/.cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl wget xz-utils gnupg apt-transport-https \
      dumb-init supervisor procps net-tools netcat-openbsd socat \
      python3 python3-websocket \
      xvfb x11-utils x11vnc fluxbox dbus-x11 gsettings-desktop-schemas \
      novnc websockify \
      fonts-liberation fonts-dejavu-core libasound2 libatk-bridge2.0-0 libatk1.0-0 \
      libcups2 libdrm2 libgbm1 libgtk-3-0 libnss3 libu2f-udev libxcomposite1 \
      libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
    && install -d -m 0755 /etc/apt/keyrings /opt/pi-node \
    && wget -qO- https://deb.opera.com/archive.key | gpg --dearmor > /etc/apt/keyrings/opera.gpg \
    && echo 'deb [signed-by=/etc/apt/keyrings/opera.gpg] https://deb.opera.com/opera-stable/ stable non-free' > /etc/apt/sources.list.d/opera-stable.list \
    && wget -qO /tmp/node.tar.xz "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
    && tar -xJf /tmp/node.tar.xz -C /opt/pi-node \
    && ln -s "/opt/pi-node/node-${NODE_VERSION}-linux-x64" /opt/pi-node/current \
    && ln -sf /opt/pi-node/current/bin/node /usr/local/bin/node \
    && ln -sf /opt/pi-node/current/bin/npm /usr/local/bin/npm \
    && ln -sf /opt/pi-node/current/bin/npx /usr/local/bin/npx \
    && ln -sf /opt/pi-node/current/bin/node /usr/bin/node \
    && ln -sf /opt/pi-node/current/bin/npm /usr/bin/npm \
    && ln -sf /opt/pi-node/current/bin/npx /usr/bin/npx \
    && npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" "opera-devtools-mcp@${OPERA_DEVTOOLS_MCP_VERSION}" \
    && ln -sf /opt/pi-node/current/bin/pi /usr/local/bin/pi \
    && ln -sf /opt/pi-node/current/bin/pi /usr/bin/pi \
    && ln -sf /opt/pi-node/current/bin/opera-devtools-mcp /usr/local/bin/opera-devtools-mcp \
    && ln -sf /opt/pi-node/current/bin/opera-devtools-mcp /usr/bin/opera-devtools-mcp \
    && ln -sf /opt/pi-node/current/bin/opera-devtools /usr/local/bin/opera-devtools \
    && ln -sf /opt/pi-node/current/bin/opera-devtools /usr/bin/opera-devtools \
    && apt-get update \
    && apt-get install -y --no-install-recommends opera-stable \
    && groupadd --gid "${GID}" "${USERNAME}" \
    && useradd --uid "${UID}" --gid "${GID}" --create-home --shell /bin/bash "${USERNAME}" \
    && mkdir -p /var/log/pi-computer /var/run/pi-computer /home/pi/.config/opera /home/pi/Downloads /home/pi/pi-computer/pi-sessions /home/pi/.pi/agent/npm \
    && printf '{\n  "defaultProvider": "openai-codex",\n  "defaultModel": "gpt-5.4",\n  "packages": [\n    "npm:pi-mcp-adapter"\n  ]\n}\n' > /home/pi/.pi/agent/settings.json \
    && printf '{"name":"pi-extensions","private":true,"dependencies":{"pi-mcp-adapter":"^%s"}}\n' "${PI_MCP_ADAPTER_VERSION}" > /home/pi/.pi/agent/npm/package.json \
    && npm --prefix /home/pi/.pi/agent/npm install \
    && chown -R "${USERNAME}:${USERNAME}" /var/log/pi-computer /var/run/pi-computer /home/pi \
    && node --version \
    && pi --version \
    && apt-get clean \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY container/supervisor/supervisord.conf /etc/supervisor/supervisord.conf
COPY container/bin/ /usr/local/bin/
COPY container/api/ /opt/pi-computer/api/
COPY container/novnc-gate/ /opt/pi-computer/novnc-gate/
RUN chmod +x /usr/local/bin/pi-computer-* /opt/pi-computer/api/server.js /opt/pi-computer/novnc-gate/server.js

USER pi
WORKDIR /home/pi
EXPOSE 6080 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=35s --retries=5 CMD ["/usr/local/bin/pi-computer-healthcheck"]
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/pi-computer-entrypoint"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
