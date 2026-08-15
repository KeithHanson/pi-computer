#!/usr/bin/env node
'use strict';

const http = require('http');
const net = require('net');

const HOST = process.env.NOVNC_GATE_HOST || '0.0.0.0';
const PORT = Number(process.env.NOVNC_PORT || 6080);
const BACKEND_HOST = process.env.NOVNC_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.NOVNC_BACKEND_PORT || 6081);

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` };
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
  proxyHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(req.headers)) {
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
  console.log(`pi-computer noVNC loopback proxy listening on ${HOST}:${PORT}; backend=${BACKEND_HOST}:${BACKEND_PORT}`);
});
