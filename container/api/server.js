#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOST = process.env.API_HOST || '0.0.0.0';
const PORT = Number(process.env.API_PORT || 8080);
const STORE_DIR = process.env.PI_COMPUTER_TASK_STORE || '/home/pi/pi-computer/tasks';
const LOG_DIR = process.env.PI_COMPUTER_LOG_DIR || '/home/pi/pi-computer-logs';
const BRIDGE_LOG = path.join(LOG_DIR, 'browser-mcp.log');
const MAX_BODY = Number(process.env.API_MAX_BODY_BYTES || 16384);
const DEFAULT_TIMEOUT = Number(process.env.TASK_TIMEOUT_SECONDS || 60);
const MAX_TIMEOUT = Number(process.env.TASK_MAX_TIMEOUT_SECONDS || 300);
const MAX_INSTRUCTION = Number(process.env.TASK_MAX_INSTRUCTION_CHARS || 2000);
const MAX_PI_INSTRUCTION = Number(process.env.PI_HARNESS_MAX_INSTRUCTION_CHARS || 4000);
const MAX_NEWS_ARTICLES = Math.max(1, Number(process.env.PI_BROWSER_TASK_MAX_ARTICLES || 5));
const MAX_EVENT_CHUNK_BYTES = Number(process.env.PI_HARNESS_EVENT_CHUNK_BYTES || 4000);
const RUNTIME_LOG_DIR = process.env.PI_COMPUTER_RUNTIME_LOG_DIR || '/var/log/pi-computer';
const DEFAULT_RUNTIME_LOG_LINES = Number(process.env.PI_COMPUTER_RUNTIME_LOG_LINES || 200);
const MAX_RUNTIME_LOG_LINES = Number(process.env.PI_COMPUTER_RUNTIME_LOG_MAX_LINES || 1000);
const PI_TRANSCRIPT_POLL_MS = Math.max(100, Number(process.env.PI_HARNESS_TRANSCRIPT_POLL_MS || 500));
const PI_TRANSCRIPT_TAIL_BYTES = Math.max(1024, Number(process.env.PI_HARNESS_TRANSCRIPT_TAIL_BYTES || 262144));
const BRIDGE = process.env.BROWSER_MCP_BRIDGE || '/usr/local/bin/pi-computer-browser-mcp';
const PI_BIN = process.env.PI_HARNESS_BIN || '/usr/local/bin/pi';
const PI_MCP_CONFIG = process.env.PI_HARNESS_MCP_CONFIG || '/home/pi/.config/mcp/mcp.json';
const PI_PROVIDER = process.env.PI_HARNESS_PROVIDER || '';
const PI_MODEL = process.env.PI_HARNESS_MODEL || '';
const PI_SESSION_DIR = process.env.PI_HARNESS_SESSION_DIR || '/home/pi/pi-computer/pi-sessions';
const NEWS_START_URL = 'https://news.google.com/home?hl=en-US&gl=US&ceid=US:en';

const tasks = new Map();
const sseClients = new Map();
let activeTaskId = null;

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
function taskDir(taskId) { return path.join(STORE_DIR, taskId); }
function taskPath(taskId) { return path.join(taskDir(taskId), 'task.json'); }
function eventsPath(taskId) { return path.join(taskDir(taskId), 'events.jsonl'); }
function artifactsDir(taskId) { return path.join(taskDir(taskId), 'artifacts'); }
function progressLogPath(taskId) { return path.join(taskDir(taskId), 'progress.log'); }
function transcriptMirrorPath(taskId) { return path.join(taskDir(taskId), 'pi-session.jsonl'); }
function runtimeLogPath(name) { return path.join(RUNTIME_LOG_DIR, name); }
function taskSessionDir(taskId) { return path.join(PI_SESSION_DIR, taskId); }

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
    runner: task.runner || null,
    result: task.result || null,
    artifacts: task.artifacts || [],
    error: task.error || null,
    eventsUrl: `/v1/tasks/${task.taskId}/events`,
    progressUrl: `/v1/tasks/${task.taskId}/progress?lines=${DEFAULT_RUNTIME_LOG_LINES}`,
    transcriptUrl: `/v1/tasks/${task.taskId}/transcript?lines=${DEFAULT_RUNTIME_LOG_LINES}`,
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

function chunkText(text, maxBytes = MAX_EVENT_CHUNK_BYTES) {
  const source = String(text || '');
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const char of source) {
    const charBytes = Buffer.byteLength(char);
    if (current && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

function appendBridgeLog(chunk) {
  try {
    require('fs').mkdirSync(LOG_DIR, { recursive: true });
    require('fs').appendFileSync(BRIDGE_LOG, `[${now()}] ${chunk}`);
  } catch (_) {
    // Ignore log write failures so task execution still reports the primary browser error.
  }
}

async function emitTextEvents(task, type, text) {
  for (const chunk of chunkText(text)) {
    await emitEvent(task, type, { text: chunk });
  }
}

function parsePositiveInt(value, fallback, maxValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maxValue);
}

async function readTailLines(filePath, lineCount) {
  const text = await fs.readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const trimmed = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return trimmed.slice(-lineCount).join('\n');
}

async function copyFileIfExists(fromPath, toPath) {
  try {
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.copyFile(fromPath, toPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function truncateText(text, maxChars = 240) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function summarizeToolArguments(args) {
  const source = args && typeof args === 'object' ? args : {};
  const summary = {};
  if (typeof source.url === 'string') summary.url = source.url;
  if (typeof source.title === 'string') summary.title = source.title;
  if (typeof source.selector === 'string') summary.selector = source.selector;
  if (typeof source.text === 'string') summary.text = truncateText(source.text, 160);
  if (!Object.keys(summary).length) return truncateText(JSON.stringify(source), 200);
  return truncateText(JSON.stringify(summary), 200);
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      if (part?.type === 'thinking' && typeof part.thinking === 'string') return part.thinking;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function formatTranscriptEntry(entry) {
  if (!entry || entry.type !== 'message' || !entry.message) return [];
  const message = entry.message;
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    const lines = [];
    for (const part of message.content) {
      if (part?.type === 'toolCall') {
        lines.push({
          type: 'pi.progress',
          data: {
            source: 'transcript',
            category: 'tool_call',
            toolName: part.name,
            text: `Pi called ${part.name}${part.arguments ? ` ${summarizeToolArguments(part.arguments)}` : ''}`,
          },
        });
      } else if (part?.type === 'text' && typeof part.text === 'string') {
        const text = truncateText(part.text, 240);
        if (text && !text.startsWith('{')) {
          lines.push({ type: 'pi.progress', data: { source: 'transcript', category: 'assistant', text: `Pi: ${text}` } });
        }
      }
    }
    return lines;
  }
  if (message.role === 'toolResult') {
    const toolText = truncateText(textFromContent(message.content), 200);
    const suffix = toolText ? ` -> ${toolText}` : '';
    return [{
      type: 'pi.progress',
      data: {
        source: 'transcript',
        category: 'tool_result',
        toolName: message.toolName,
        isError: message.isError === true,
        text: `Pi received ${message.toolName} result${message.isError ? ' (error)' : ''}${suffix}`,
      },
    }];
  }
  if (message.role === 'custom') {
    const text = truncateText(textFromContent(message.content), 240);
    if (!text) return [];
    return [{ type: 'pi.progress', data: { source: 'transcript', category: 'custom', customType: message.customType, text: `Pi ${message.customType}: ${text}` } }];
  }
  if (message.role === 'bashExecution') {
    return [{ type: 'pi.progress', data: { source: 'transcript', category: 'bash', text: `Pi ran bash: ${truncateText(message.command, 160)}` } }];
  }
  return [];
}

async function appendProgressLine(task, text) {
  const line = `[${now()}] ${text}`;
  await fs.mkdir(taskDir(task.taskId), { recursive: true });
  await fs.appendFile(progressLogPath(task.taskId), `${line}\n`);
}

async function emitProgressLine(task, text, extra = {}) {
  await appendProgressLine(task, text);
  await emitEvent(task, 'pi.progress', { text, ...extra });
}

async function discoverSessionFile(sessionDir) {
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(sessionDir, entry.name))
    .sort();
  return files[0] || null;
}

function startPiTranscriptMonitor(task, sessionDir) {
  let stopped = false;
  let busy = false;
  let sessionFile = null;
  let offset = 0;
  let buffer = '';
  const seenMessages = new Set();

  async function processLine(line) {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (entry?.id && seenMessages.has(entry.id)) return;
    if (entry?.id) seenMessages.add(entry.id);
    for (const progressEvent of formatTranscriptEntry(entry)) {
      await emitProgressLine(task, progressEvent.data.text, progressEvent.data);
    }
  }

  async function syncMirror(fromPath) {
    await copyFileIfExists(fromPath, transcriptMirrorPath(task.taskId));
  }

  async function tick(force = false) {
    if ((stopped && !force) || busy) return;
    busy = true;
    try {
      if (!sessionFile) {
        sessionFile = await discoverSessionFile(sessionDir);
        if (sessionFile) {
          task.runner = task.runner || {};
          task.runner.sessionDir = sessionDir;
          task.runner.sessionFile = sessionFile;
          task.runner.transcriptMirror = transcriptMirrorPath(task.taskId);
          await persist(task);
          await emitProgressLine(task, `Pi session transcript discovered at ${task.runner.transcriptMirror}`, {
            source: 'transcript',
            category: 'session',
            transcriptMirror: task.runner.transcriptMirror,
          });
          await syncMirror(sessionFile);
        }
      }
      if (!sessionFile) return;
      const handle = await fs.open(sessionFile, 'r');
      try {
        const stat = await handle.stat();
        if (stat.size <= offset) return;
        const toRead = Math.min(stat.size - offset, PI_TRANSCRIPT_TAIL_BYTES);
        if (toRead < stat.size - offset) {
          offset = stat.size - toRead;
          buffer = '';
        }
        const buf = Buffer.alloc(toRead);
        await handle.read(buf, 0, toRead, offset);
        offset += toRead;
        buffer += buf.toString('utf8');
      } finally {
        await handle.close();
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        await processLine(line);
      }
      await syncMirror(sessionFile);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => { tick().catch(() => {}); }, PI_TRANSCRIPT_POLL_MS);
  timer.unref();
  tick().catch(() => {});

  return {
    async stop() {
      clearInterval(timer);
      await tick(true).catch(() => {});
      stopped = true;
      if (sessionFile && buffer.trim()) await processLine(buffer);
      if (sessionFile) await syncMirror(sessionFile);
      return { sessionFile };
    },
  };
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
  const allowedKeys = new Set(['taskType', 'startUrl', 'instruction', 'timeoutSeconds', 'profilePolicy', 'maxArticles']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) throw new Error(`unsupported field: ${key}`);
  }
  const taskType = body.taskType || 'open_url';
  const timeoutSeconds = Math.min(Math.max(Number(body.timeoutSeconds || DEFAULT_TIMEOUT), 1), MAX_TIMEOUT);
  const profilePolicy = body.profilePolicy || 'ephemeral';
  if (profilePolicy !== 'ephemeral') throw new Error('only ephemeral profilePolicy is supported');

  if (taskType === 'open_url') {
    if (typeof body.startUrl !== 'string') throw new Error('startUrl is required');
    const parsed = new URL(body.startUrl);
    if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) throw new Error('startUrl must use http, https, or about');
    if (body.instruction !== undefined && (typeof body.instruction !== 'string' || body.instruction.length > MAX_INSTRUCTION)) {
      throw new Error(`instruction must be a string up to ${MAX_INSTRUCTION} characters`);
    }
    return { taskType, startUrl: parsed.toString(), instruction: body.instruction || '', timeoutSeconds, profilePolicy };
  }

  if (taskType === 'news_browse_summary') {
    if (typeof body.instruction !== 'string' || !body.instruction.trim()) throw new Error('instruction is required');
    if (body.instruction.length > MAX_PI_INSTRUCTION) throw new Error(`instruction must be a string up to ${MAX_PI_INSTRUCTION} characters`);
    const maxArticles = Math.min(Math.max(Number(body.maxArticles || 3), 1), MAX_NEWS_ARTICLES);
    if (body.startUrl !== undefined) throw new Error('startUrl is fixed for news_browse_summary');
    return {
      taskType,
      instruction: body.instruction.trim(),
      timeoutSeconds,
      profilePolicy,
      maxArticles,
      startUrl: NEWS_START_URL,
    };
  }

  throw new Error('taskType must be open_url or news_browse_summary');
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

async function writeArtifact(task, name, content, mediaType = 'application/json') {
  const artifactId = id('artifact');
  const fileName = `${artifactId}-${name}`;
  await fs.mkdir(artifactsDir(task.taskId), { recursive: true });
  const filePath = path.join(artifactsDir(task.taskId), fileName);
  await fs.writeFile(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  const stat = await fs.stat(filePath);
  const artifact = { artifactId, name, mediaType, bytes: stat.size };
  task.artifacts.push(artifact);
  return artifact;
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidateText = fenced ? fenced[1].trim() : trimmed;
  const starts = [];
  for (let i = 0; i < candidateText.length; i += 1) {
    if (candidateText[i] === '{') starts.push(i);
  }
  for (const start of starts) {
    for (let end = candidateText.length; end > start; end -= 1) {
      const slice = candidateText.slice(start, end).trim();
      if (!slice.endsWith('}')) continue;
      try {
        return JSON.parse(slice);
      } catch (_) {}
    }
  }
  throw new Error('pi harness did not return valid JSON');
}

function buildNewsPrompt(task) {
  return [
    'You are a bounded browser summarization worker inside pi-computer.',
    'Use the configured opera-devtools MCP tools to inspect pages in Opera.',
    'Do not use any shell, filesystem, or non-browser capabilities.',
    `Start at ${task.request.startUrl}.`,
    `Follow at most ${task.request.maxArticles} news article links from that page.`,
    'Prefer the visible top stories on the page. If some links are blocked, summarize the ones you can open.',
    'For each opened article, capture the title, publisher, URL, and a concise summary based on the article content or an explicit limitation.',
    'Return ONLY valid JSON with this exact top-level shape:',
    '{"taskSummary":"string","sourcePage":"string","visitedPages":[{"title":"string","url":"string","kind":"landing|article","status":"opened|blocked|skipped"}],"articleSummaries":[{"title":"string","publisher":"string","url":"string","status":"opened|blocked","summary":"string"}],"aggregateSummary":{"headline":"string","bullets":["string"]},"limitations":["string"]}',
    `User instruction: ${task.request.instruction}`,
  ].join('\n');
}

function runProcess(command, args, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const { onStdout, onStderr, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onStdout) onStdout(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onStderr) onStderr(text);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr, code });
      return reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

async function runPiNewsTask(task) {
  const timeoutMs = task.request.timeoutSeconds * 1000;
  const prompt = buildNewsPrompt(task);
  const sessionDir = taskSessionDir(task.taskId);
  const piArgs = ['-p', '--no-builtin-tools', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--session-dir', sessionDir];
  if (PI_PROVIDER) piArgs.push('--provider', PI_PROVIDER);
  if (PI_MODEL) piArgs.push('--model', PI_MODEL);
  piArgs.push(prompt);

  task.runner = {
    kind: 'pi_harness',
    command: PI_BIN,
    args: piArgs.filter((arg) => arg !== prompt).concat(['<prompt>']),
    mcpConfig: PI_MCP_CONFIG,
    mcpConfigMode: 'ambient_discovery',
    browserMcpServer: 'opera-devtools',
    sessionDir,
    transcriptMirror: transcriptMirrorPath(task.taskId),
  };
  await persist(task);
  await emitEvent(task, 'runner.selected', { runner: task.runner.kind, command: task.runner.command, browserMcpServer: 'opera-devtools', mcpConfig: PI_MCP_CONFIG, mcpConfigMode: 'ambient_discovery', sessionDir, transcriptMirror: task.runner.transcriptMirror });
  await emitEvent(task, 'pi.started', { command: PI_BIN });
  await emitProgressLine(task, `Started Pi news task; follow ${publicTask(task).eventsUrl}, ${publicTask(task).progressUrl}, or ${publicTask(task).transcriptUrl}`, { source: 'task_api', category: 'start' });

  const workDir = taskDir(task.taskId);
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  const transcriptMonitor = startPiTranscriptMonitor(task, sessionDir);
  let result;
  try {
    result = await runProcess(PI_BIN, piArgs, timeoutMs, {
      cwd: workDir,
      env: { ...process.env, HOME: process.env.HOME || '/home/pi' },
      onStdout: (text) => { emitTextEvents(task, 'pi.stdout', text).catch(() => {}); },
      onStderr: (text) => { emitTextEvents(task, 'pi.stderr', text).catch(() => {}); },
    });
  } finally {
    const transcriptState = await transcriptMonitor.stop();
    if (transcriptState.sessionFile) {
      task.runner.sessionFile = transcriptState.sessionFile;
      await persist(task);
    }
  }
  await emitEvent(task, 'pi.completed', { exitCode: 0, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) });
  await emitProgressLine(task, 'Pi process exited successfully; finalizing artifacts.', { source: 'task_api', category: 'completion' });

  const rawArtifact = await writeArtifact(task, 'pi-harness-output.txt', result.stdout, 'text/plain');
  const stderrArtifact = await writeArtifact(task, 'pi-harness-stderr.txt', result.stderr, 'text/plain');
  const progressArtifact = await writeArtifact(task, 'progress.log', await fs.readFile(progressLogPath(task.taskId), 'utf8'), 'text/plain');
  let transcriptArtifact = null;
  if (task.runner?.transcriptMirror) {
    const transcriptText = await fs.readFile(task.runner.transcriptMirror, 'utf8').catch(() => '');
    if (transcriptText) transcriptArtifact = await writeArtifact(task, 'pi-session.jsonl', transcriptText, 'application/jsonl');
  }
  const parsed = extractJsonObject(result.stdout);
  const summaryArtifact = await writeArtifact(task, 'news-summary.json', {
    request: task.request,
    runner: task.runner,
    output: parsed,
    observedAt: now(),
  });

  task.result = {
    summary: parsed.taskSummary || parsed.aggregateSummary?.headline || 'Completed news browse and summarize task through the Pi harness.',
    taskType: task.request.taskType,
    runner: task.runner.kind,
    startUrl: task.request.startUrl,
    maxArticles: task.request.maxArticles,
    visitedPages: Array.isArray(parsed.visitedPages) ? parsed.visitedPages.length : 0,
    articleCount: Array.isArray(parsed.articleSummaries) ? parsed.articleSummaries.length : 0,
    aggregateSummary: parsed.aggregateSummary || null,
    limitations: parsed.limitations || [],
    artifactIds: [summaryArtifact.artifactId, rawArtifact.artifactId, stderrArtifact.artifactId, progressArtifact.artifactId].concat(transcriptArtifact ? [transcriptArtifact.artifactId] : []),
  };
}

async function runOpenUrlTask(task) {
  const timeoutMs = task.request.timeoutSeconds * 1000;
  task.runner = { kind: 'browser_mcp_bridge', command: BRIDGE };
  await persist(task);
  await emitEvent(task, 'runner.selected', { runner: task.runner.kind, command: BRIDGE });
  const readiness = await callBridge('tools/call', { name: 'browser.probe', arguments: {} }, timeoutMs);
  await emitEvent(task, 'browser.probe', { ok: true });
  const version = await callBridge('tools/call', { name: 'browser.version', arguments: {} }, timeoutMs);
  await emitEvent(task, 'browser.version', { ok: true });
  const navigation = await callBridge('tools/call', { name: 'browser.navigate', arguments: { url: task.request.startUrl } }, timeoutMs);
  await emitEvent(task, 'browser.navigate', { url: task.request.startUrl });
  const targets = await callBridge('tools/call', { name: 'browser.targets', arguments: {} }, timeoutMs);
  const artifact = await writeArtifact(task, 'browser-observation.json', { request: task.request, runner: task.runner, readiness, version, navigation, targets, observedAt: now() });
  task.result = { summary: `Opened ${task.request.startUrl} in Opera through the internal browser MCP/CDP bridge.`, runner: task.runner.kind, artifactIds: [artifact.artifactId] };
}

async function runTask(task) {
  activeTaskId = task.taskId;
  task.state = 'starting'; task.startedAt = now(); task.updatedAt = now();
  await persist(task); await emitEvent(task, 'state', { state: task.state });
  try {
    task.state = 'running'; task.updatedAt = now();
    await persist(task); await emitEvent(task, 'state', { state: task.state });
    if (task.cancelRequested) throw new Error('cancelled before browser work started');
    if (task.request.taskType === 'news_browse_summary') await runPiNewsTask(task);
    else await runOpenUrlTask(task);
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
  await fs.mkdir(PI_SESSION_DIR, { recursive: true });
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
  const progress = pathname.match(/^\/v1\/tasks\/([^/]+)\/progress$/);
  const transcript = pathname.match(/^\/v1\/tasks\/([^/]+)\/transcript$/);
  const runtimeLog = pathname.match(/^\/v1\/runtime\/logs\/([A-Za-z0-9._-]+)$/);
  return {
    taskId: task && task[1],
    cancelId: cancel && cancel[1],
    eventsId: events && events[1],
    progressId: progress && progress[1],
    transcriptId: transcript && transcript[1],
    runtimeLogName: runtimeLog && runtimeLog[1],
  };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, {
      ok: true,
      service: 'pi-computer-api',
      storeDir: STORE_DIR,
      activeTaskId,
      piHarness: { bin: PI_BIN, mcpConfig: PI_MCP_CONFIG, mcpConfigMode: 'ambient_discovery', sessionDir: PI_SESSION_DIR },
      runtimeLogs: {
        dir: RUNTIME_LOG_DIR,
        available: ['api.err.log', 'api.log', 'opera.err.log', 'opera.log', 'opera-browser.log', 'supervisord.log', 'xvfb.err.log', 'xvfb.log'],
        tailEndpoint: '/v1/runtime/logs/<name>?lines=200',
      },
    });
  }
  const match = routeMatch(url.pathname);
  try {
    if (req.method === 'POST' && url.pathname === '/v1/tasks') {
      if (activeTaskId) return sendError(res, 409, 'one active task is already running');
      const request = validateRequest(await readJson(req));
      const task = { taskId: id('task'), state: 'queued', createdAt: now(), updatedAt: now(), request, artifacts: [], events: [], cancelRequested: false, runner: null };
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
    if (req.method === 'GET' && match.progressId) {
      const task = tasks.get(match.progressId); if (!task) return sendError(res, 404, 'task not found');
      const lines = parsePositiveInt(url.searchParams.get('lines'), DEFAULT_RUNTIME_LOG_LINES, MAX_RUNTIME_LOG_LINES);
      const text = await readTailLines(progressLogPath(task.taskId), lines).catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text ? `${text}\n` : '');
      return;
    }
    if (req.method === 'GET' && match.transcriptId) {
      const task = tasks.get(match.transcriptId); if (!task) return sendError(res, 404, 'task not found');
      const lines = parsePositiveInt(url.searchParams.get('lines'), DEFAULT_RUNTIME_LOG_LINES, MAX_RUNTIME_LOG_LINES);
      const filePath = task.runner?.transcriptMirror || transcriptMirrorPath(task.taskId);
      const text = await readTailLines(filePath, lines).catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      res.writeHead(200, { 'content-type': 'application/jsonl; charset=utf-8' });
      res.end(text ? `${text}\n` : '');
      return;
    }
    if (req.method === 'GET' && match.runtimeLogName) {
      const lines = parsePositiveInt(url.searchParams.get('lines'), DEFAULT_RUNTIME_LOG_LINES, MAX_RUNTIME_LOG_LINES);
      const filePath = runtimeLogPath(match.runtimeLogName);
      let text;
      try {
        text = await readTailLines(filePath, lines);
      } catch (error) {
        return sendError(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'runtime log not found' : `could not read runtime log: ${error.message}`);
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text ? `${text}\n` : '');
      return;
    }
    return sendError(res, 404, 'not found');
  } catch (e) {
    return sendError(res, e.message.includes('too large') ? 413 : 400, e.message);
  }
}

loadExisting().then(() => {
  http.createServer(handler).listen(PORT, HOST, () => {
    console.log(`pi-computer-api listening on ${HOST}:${PORT}; store=${STORE_DIR}; pi=${PI_BIN}`);
  });
}).catch((e) => { console.error(e); process.exit(1); });
