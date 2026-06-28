// autobrowse — local server: serves the UI, runs the training loop, streams events (SSE).
// Serves the UI, runs a skill-training job, and streams every event over SSE.
// The training loop lives in src/runner.mjs (the inner agent is autobrowse/scripts/evaluate.mjs).
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAutobrowse } from './src/runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv();
const PORT = process.env.PORT || 4317;
const PUBLIC = join(__dirname, 'public');
const WORKSPACE = join(__dirname, 'workspace');

/** runId -> { prompt, status, events[], clients:Set<res>, dir } */
const runs = new Map();

function emit(run, type, data = {}) {
  const ev = { seq: run.events.length, ts: Date.now(), type, ...data };
  run.events.push(ev);
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of run.clients) { try { res.write(payload); } catch {} }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // env/health for the UI (which keys are present — never the values)
  if (u.pathname === '/api/env') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      browserbase: !!process.env.BROWSERBASE_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'],
    }));
  }

  // start a run
  if (req.method === 'POST' && u.pathname === '/api/runs') {
    const body = await readBody(req);
    let b = {};
    try { b = JSON.parse(body || '{}'); } catch {}
    const prompt = (b.prompt || '').trim();
    if (!prompt) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"prompt required"}'); }
    const opts = {
      innerModel: b.innerModel || 'claude-haiku-4-5-20251001',
      outerModel: b.outerModel || 'claude-sonnet-4-6',
      iterations: Math.max(1, Math.min(10, Number(b.iterations) || 3)),
      steer: (b.steer || '').trim() || undefined,
    };
    const runId = randomUUID().slice(0, 8);
    const dir = join(WORKSPACE, runId);
    await mkdir(dir, { recursive: true });
    const run = { id: runId, prompt, opts, status: 'running', events: [], clients: new Set(), dir };
    runs.set(runId, run);
    runAutobrowse(run, (type, data) => emit(run, type, data), { workspace: dir, env: process.env })
      .then(() => { run.status = 'done'; emit(run, 'run-finished'); })
      .catch((e) => { run.status = 'error'; emit(run, 'run-error', { message: String(e?.message || e) }); });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ runId }));
  }

  // SSE stream for a run
  const sm = u.pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
  if (req.method === 'GET' && sm) {
    const run = runs.get(sm[1]);
    if (!run) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`); // backlog
    run.clients.add(res);
    req.on('close', () => run.clients.delete(res));
    return;
  }

  // static
  const p = u.pathname === '/' ? '/index.html' : u.pathname;
  const fp = join(PUBLIC, p);
  if (existsSync(fp) && fp.startsWith(PUBLIC)) {
    res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'text/plain' });
    return res.end(await readFile(fp));
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  ✦  autobrowse is running\n  →  http://localhost:${PORT}\n`);
  if (!process.env.BROWSERBASE_API_KEY) console.log('  ⚠  Missing BROWSERBASE_API_KEY in .env\n');
  if (!process.env.ANTHROPIC_API_KEY) console.log('  ⚠  Missing ANTHROPIC_API_KEY in .env\n');
});

function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }); }
function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
