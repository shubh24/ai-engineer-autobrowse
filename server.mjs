// autobrowse — local server: serves the UI, runs the training loop, streams events (SSE).
// Serves the UI, runs a skill-training job, and streams every event over SSE.
// The training loop lives in src/runner.mjs (the inner agent is autobrowse/scripts/evaluate.mjs).
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs';
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
  try { appendFileSync(join(run.dir, 'events.ndjson'), JSON.stringify(ev) + '\n'); } catch {}
  if (type === 'run-started') updateMeta(run, { site: data.site, models: data.models });
  if (type === 'graduated') updateMeta(run, { skillName: data.skillName, passed: !!data.passed, status: 'graduated' });
  if (type === 'run-finished') updateMeta(run, { status: run.status === 'error' ? 'error' : 'done' });
  if (type === 'run-error') updateMeta(run, { status: 'error', error: data.message });
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of run.clients) { try { res.write(payload); } catch {} }
}

function writeMeta(run) {
  const meta = { id: run.id, prompt: run.prompt, innerModel: run.opts.innerModel, outerModel: run.opts.outerModel,
    iterations: run.opts.iterations, startedAt: run.startedAt, status: run.status };
  try { writeFileSync(join(run.dir, 'meta.json'), JSON.stringify(meta, null, 2)); } catch {}
}
function updateMeta(run, patch) {
  const p = join(run.dir, 'meta.json');
  let m = {};
  try { m = JSON.parse(readFileSync(p, 'utf8')); } catch {}
  try { writeFileSync(p, JSON.stringify({ ...m, ...patch }, null, 2)); } catch {}
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
    const run = { id: runId, prompt, opts, status: 'running', events: [], clients: new Set(), dir, startedAt: Date.now() };
    runs.set(runId, run);
    writeMeta(run);
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

  // history: list past runs
  if (u.pathname === '/api/history') {
    const out = [];
    try {
      for (const id of readdirSync(WORKSPACE)) {
        const mp = join(WORKSPACE, id, 'meta.json');
        if (existsSync(mp)) { try { out.push(JSON.parse(readFileSync(mp, 'utf8'))); } catch {} }
      }
    } catch {}
    out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  // stored events for a run (replay a past run, or backlog for a live one)
  const em = u.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (req.method === 'GET' && em) {
    const live = runs.get(em[1]);
    if (live) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(live.events)); }
    const ep = join(WORKSPACE, em[1], 'events.ndjson');
    if (existsSync(ep)) {
      const events = readFileSync(ep, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(events));
    }
    res.writeHead(404); return res.end('[]');
  }

  // session replay (HLS) for a finished run's browser — proxy the playlist (keeps the API key server-side)
  const rp = u.pathname.match(/^\/api\/replay\/([^/]+)$/);
  if (req.method === 'GET' && rp) {
    const key = process.env.BROWSERBASE_API_KEY;
    try {
      const list = await (await fetch(`https://api.browserbase.com/v1/sessions/${rp[1]}/replays`, { headers: { 'X-BB-API-Key': key } })).json();
      const pageId = list?.pages?.[0]?.pageId ?? '0';
      const r = await fetch(`https://api.browserbase.com/v1/sessions/${rp[1]}/replays/${pageId}`, { headers: { 'X-BB-API-Key': key } });
      const m3u8 = await r.text();
      res.writeHead(r.ok ? 200 : r.status, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
      return res.end(m3u8);
    } catch (e) { res.writeHead(502); return res.end('replay unavailable'); }
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
