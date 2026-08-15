#!/usr/bin/env node
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');

const HOST = process.env.NOVNC_GATE_HOST || '0.0.0.0';
const PORT = Number(process.env.NOVNC_PORT || 6080);
const BACKEND_HOST = process.env.NOVNC_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.NOVNC_BACKEND_PORT || 6081);
const TOKEN = process.env.PI_COMPUTER_NOVNC_TOKEN || process.env.NOVNC_AUTH_TOKEN || 'local-novnc-token-change-me';
const USERNAME = process.env.PI_COMPUTER_NOVNC_USERNAME || process.env.NOVNC_AUTH_USERNAME || 'operator';
const PASSWORD = process.env.PI_COMPUTER_NOVNC_PASSWORD || process.env.NOVNC_AUTH_PASSWORD || TOKEN;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseBasic(header) {
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch (_) {
    return null;
  }
}

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return safeEqual(auth.slice(7), TOKEN);
  const basic = parseBasic(auth);
  if (basic) return safeEqual(basic.username, USERNAME) && safeEqual(basic.password, PASSWORD);
  return false;
}

function reject(res) {
  res.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': `Basic realm="pi-computer noVNC", charset="UTF-8"`,
    'cache-control': 'no-store',
  });
  res.end('authentication required\n');
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` };
  delete headers.authorization;
  const upstream = http.request({
    host: BACKEND_HOST,
    port: BACKEND_PORT,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers, 'cache-control': upstreamRes.headers['cache-control'] || 'no-store' };
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`noVNC backend unavailable: ${err.message}\n`);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) return reject(res);
  proxyHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (!isAuthorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="pi-computer noVNC", charset="UTF-8"\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const upstream = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() === 'authorization') continue;
      if (Array.isArray(value)) for (const item of value) headerLines.push(`${name}: ${item}`);
      else if (value !== undefined) headerLines.push(`${name}: ${value}`);
    }
    upstream.write(`${headerLines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(`pi-computer noVNC auth gate listening on ${HOST}:${PORT}; backend=${BACKEND_HOST}:${BACKEND_PORT}; user=${USERNAME}`);
});
