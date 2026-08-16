#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOST = process.env.API_HOST || '0.0.0.0';
const PORT = Number(process.env.API_PORT || 8080);
const STORE_DIR = process.env.PI_COMPUTER_TASK_STORE || '/home/pi/pi-computer-tasks';
const LOG_DIR = process.env.PI_COMPUTER_LOG_DIR || '/home/pi/pi-computer-logs';
const BRIDGE_LOG = path.join(LOG_DIR, 'browser-mcp.log');
const MAX_BODY = Number(process.env.API_MAX_BODY_BYTES || 16384);
const DEFAULT_TIMEOUT = Number(process.env.TASK_TIMEOUT_SECONDS || 60);
const MAX_TIMEOUT = Number(process.env.TASK_MAX_TIMEOUT_SECONDS || 300);
const MAX_INSTRUCTION = Number(process.env.TASK_MAX_INSTRUCTION_CHARS || 2000);
const BRIDGE = process.env.BROWSER_MCP_BRIDGE || '/usr/local/bin/pi-computer-browser-mcp';

const tasks = new Map();
const sseClients = new Map();
let activeTaskId = null;

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
function taskDir(taskId) { return path.join(STORE_DIR, taskId); }
function taskPath(taskId) { return path.join(taskDir(taskId), 'task.json'); }
function eventsPath(taskId) { return path.join(taskDir(taskId), 'events.jsonl'); }
function artifactsDir(taskId) { return path.join(taskDir(taskId), 'artifacts'); }

function publicTask(task) {
  return {
    taskId: task.taskId,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    cancellationRequestedAt: task.cancellationRequestedAt || null,
    request: task.request,
    result: task.result || null,
    artifacts: task.artifacts || [],
    error: task.error || null,
    eventsUrl: `/v1/tasks/${task.taskId}/events`,
  };
}

async function persist(task) {
  await fs.mkdir(taskDir(task.taskId), { recursive: true });
  await fs.writeFile(taskPath(task.taskId), JSON.stringify(publicTask(task), null, 2));
}

async function emitEvent(task, type, data = {}) {
  const event = { ts: now(), taskId: task.taskId, type, data };
  task.events.push(event);
  if (task.events.length > 200) task.events.shift();
  await fs.mkdir(taskDir(task.taskId), { recursive: true });
  await fs.appendFile(eventsPath(task.taskId), `${JSON.stringify(event)}\n`);
  const clients = sseClients.get(task.taskId) || new Set();
  for (const res of clients) {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function sendError(res, status, message) { send(res, status, { error: { message } }); }

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateRequest(body) {
  const allowedKeys = new Set(['taskType', 'startUrl', 'instruction', 'timeoutSeconds', 'profilePolicy']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) throw new Error(`unsupported field: ${key}`);
  }
  const taskType = body.taskType || 'open_url';
  if (taskType !== 'open_url') throw new Error('taskType must be open_url for the MVP');
  if (typeof body.startUrl !== 'string') throw new Error('startUrl is required');
  const parsed = new URL(body.startUrl);
  if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) throw new Error('startUrl must use http, https, or about');
  if (body.instruction !== undefined && (typeof body.instruction !== 'string' || body.instruction.length > MAX_INSTRUCTION)) {
    throw new Error(`instruction must be a string up to ${MAX_INSTRUCTION} characters`);
  }
  const timeoutSeconds = Math.min(Math.max(Number(body.timeoutSeconds || DEFAULT_TIMEOUT), 1), MAX_TIMEOUT);
  const profilePolicy = body.profilePolicy || 'ephemeral';
  if (profilePolicy !== 'ephemeral') throw new Error('only ephemeral profilePolicy is supported for the MVP');
  return { taskType, startUrl: parsed.toString(), instruction: body.instruction || '', timeoutSeconds, profilePolicy };
}

function appendBridgeLog(chunk) {
  try {
    fss.mkdirSync(LOG_DIR, { recursive: true });
    fss.appendFileSync(BRIDGE_LOG, `[${now()}] ${chunk}`);
  } catch (_) {
    // Ignore log write failures so task execution still reports the primary browser error.
  }
}

function callBridge(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(BRIDGE, [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    let settled = false;
    let timer;
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill('SIGTERM');
      fn(value);
    }
    function tryResolve() {
      const line = out.split('\n').find((candidate) => candidate.trim().startsWith('{'));
      if (!line) return;
      try {
        const response = JSON.parse(line);
        if (response.error) finish(reject, new Error(response.error.message));
        else finish(resolve, response.result);
      } catch (_) {
        // Wait for a complete JSON line.
      }
    }
    timer = setTimeout(() => {
      finish(reject, new Error(`browser bridge timed out after ${timeoutMs}ms: ${err}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); tryResolve(); });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      err += text;
      appendBridgeLog(text);
    });
    child.on('error', (e) => finish(reject, e));
    child.on('close', () => {
      if (settled) return;
      tryResolve();
      if (!settled) finish(reject, new Error(`browser bridge returned no response: ${err}`));
    });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  });
}

async function writeArtifact(task, name, content) {
  const artifactId = id('artifact');
  const fileName = `${artifactId}-${name}`;
  await fs.mkdir(artifactsDir(task.taskId), { recursive: true });
  const filePath = path.join(artifactsDir(task.taskId), fileName);
  await fs.writeFile(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  const stat = await fs.stat(filePath);
  const artifact = { artifactId, name, mediaType: 'application/json', bytes: stat.size };
  task.artifacts.push(artifact);
  return artifact;
}

async function runTask(task) {
  activeTaskId = task.taskId;
  task.state = 'starting'; task.startedAt = now(); task.updatedAt = now();
  await persist(task); await emitEvent(task, 'state', { state: task.state });
  try {
    task.state = 'running'; task.updatedAt = now();
    await persist(task); await emitEvent(task, 'state', { state: task.state });
    if (task.cancelRequested) throw new Error('cancelled before browser work started');
    const timeoutMs = task.request.timeoutSeconds * 1000;
    const readiness = await callBridge('tools/call', { name: 'browser.probe', arguments: {} }, timeoutMs);
    await emitEvent(task, 'browser.probe', { ok: true });
    const version = await callBridge('tools/call', { name: 'browser.version', arguments: {} }, timeoutMs);
    await emitEvent(task, 'browser.version', { ok: true });
    const navigation = await callBridge('tools/call', { name: 'browser.navigate', arguments: { url: task.request.startUrl } }, timeoutMs);
    await emitEvent(task, 'browser.navigate', { url: task.request.startUrl });
    const targets = await callBridge('tools/call', { name: 'browser.targets', arguments: {} }, timeoutMs);
    const artifact = await writeArtifact(task, 'browser-observation.json', { request: task.request, readiness, version, navigation, targets, observedAt: now() });
    task.result = { summary: `Opened ${task.request.startUrl} in Opera through the internal browser MCP/CDP bridge.`, artifactIds: [artifact.artifactId] };
    task.state = task.cancelRequested ? 'cancelled' : 'succeeded';
  } catch (e) {
    if (task.cancelRequested || task.state === 'cancelling') {
      task.state = 'cancelled'; task.result = { summary: 'Task cancelled.' };
    } else {
      task.state = 'failed'; task.error = { category: 'browser_task_failed', message: e.message };
    }
  } finally {
    task.completedAt = now(); task.updatedAt = now();
    await persist(task); await emitEvent(task, 'state', { state: task.state });
    if (activeTaskId === task.taskId) activeTaskId = null;
  }
}

async function loadExisting() {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });
  const entries = await fs.readdir(STORE_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const saved = JSON.parse(await fs.readFile(path.join(STORE_DIR, entry.name, 'task.json'), 'utf8'));
      saved.events = [];
      if (['queued', 'starting', 'running', 'cancelling'].includes(saved.state)) saved.state = 'failed';
      tasks.set(saved.taskId, saved);
    } catch (_) {}
  }
}

function routeMatch(pathname) {
  const task = pathname.match(/^\/v1\/tasks\/([^/]+)$/);
  const cancel = pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
  const events = pathname.match(/^\/v1\/tasks\/([^/]+)\/events$/);
  return { taskId: task && task[1], cancelId: cancel && cancel[1], eventsId: events && events[1] };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, { ok: true, service: 'pi-computer-api', storeDir: STORE_DIR, activeTaskId });
  }
  const match = routeMatch(url.pathname);
  try {
    if (req.method === 'POST' && url.pathname === '/v1/tasks') {
      if (activeTaskId) return sendError(res, 409, 'one active task is already running');
      const request = validateRequest(await readJson(req));
      const task = { taskId: id('task'), state: 'queued', createdAt: now(), updatedAt: now(), request, artifacts: [], events: [], cancelRequested: false };
      tasks.set(task.taskId, task);
      await persist(task); await emitEvent(task, 'state', { state: 'queued' });
      setImmediate(() => runTask(task));
      return send(res, 202, publicTask(task), { location: `/v1/tasks/${task.taskId}` });
    }
    if (req.method === 'GET' && match.taskId) {
      const task = tasks.get(match.taskId); if (!task) return sendError(res, 404, 'task not found');
      return send(res, 200, publicTask(task));
    }
    if (req.method === 'POST' && match.cancelId) {
      const task = tasks.get(match.cancelId); if (!task) return sendError(res, 404, 'task not found');
      if (['succeeded', 'failed', 'cancelled', 'expired'].includes(task.state)) return send(res, 200, publicTask(task));
      task.cancelRequested = true; task.cancellationRequestedAt = now(); task.state = 'cancelling'; task.updatedAt = now();
      await persist(task); await emitEvent(task, 'state', { state: task.state });
      return send(res, 202, publicTask(task));
    }
    if (req.method === 'GET' && match.eventsId) {
      const task = tasks.get(match.eventsId); if (!task) return sendError(res, 404, 'task not found');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const event of task.events || []) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (!sseClients.has(task.taskId)) sseClients.set(task.taskId, new Set());
      sseClients.get(task.taskId).add(res);
      req.on('close', () => sseClients.get(task.taskId)?.delete(res));
      return;
    }
    return sendError(res, 404, 'not found');
  } catch (e) {
    return sendError(res, e.message.includes('too large') ? 413 : 400, e.message);
  }
}

loadExisting().then(() => {
  http.createServer(handler).listen(PORT, HOST, () => {
    console.log(`pi-computer-api listening on ${HOST}:${PORT}; store=${STORE_DIR}`);
  });
}).catch((e) => { console.error(e); process.exit(1); });
