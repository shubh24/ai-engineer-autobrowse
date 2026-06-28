#!/usr/bin/env node
// npm run demo -- --task "<prompt>" --skill <name|none> [--skill <name2>] [--inner <model>] [--turns N]
// Runs the SAME task once per variant in a fresh Browserbase session (proxies/verified off),
// then prints an efficacy table. `none` = naive (no skill). Default: none vs the newest skill.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnv();
const BROWSE = resolveBrowse();
const ENV = { ...process.env, PATH: `${dirname(BROWSE)}:${process.env.PATH}` };
const SKILLS_DIR = join(ROOT, '.claude', 'skills');

const C = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, o: s => `\x1b[38;5;202m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m` };

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const task = a.task || a._.join(' ');
  const inner = a.inner || 'claude-haiku-4-5-20251001';
  const turns = Number(a.turns) || 16;
  const available = await listSkills();

  if (!task) {
    console.log(`\nUsage: npm run demo -- --task "<prompt>" --skill <name|none> [--skill <name2>]\n`);
    console.log('Available graduated skills (.claude/skills):', available.length ? available.join(', ') : '(none yet — run npm run forge first)');
    process.exit(1);
  }
  let skills = [].concat(a.skill || []);
  if (!skills.length) skills = available[0] ? ['none', available[0]] : ['none'];

  console.log(`\n${C.o('━━━ FORGE demo · before/after ━━━')}`);
  console.log(`${C.dim('task:')} ${task}`);
  console.log(`${C.dim('comparing:')} ${skills.join('  vs  ')}   ${C.dim('(inner: ' + inner + ', turns≤' + turns + ')')}\n`);

  const results = [];
  for (const s of skills) {
    const strategy = s === 'none' ? '# No skill — naive attempt\n' : await readSkill(s);
    const ws = join(ROOT, 'workspace', 'demo', sanitize(s) + '-' + Date.now());
    await mkdir(join(ws, 'tasks', 'demo'), { recursive: true });
    await writeFile(join(ws, 'tasks', 'demo', 'task.md'), `# Task\n\n${task}\n`);
    await writeFile(join(ws, 'tasks', 'demo', 'strategy.md'), strategy);

    const sess = await createSession();
    console.log(`${C.b('▶ ' + s)}  ${C.dim('live: ' + sess.live.slice(0, 64) + '…')}`);
    let r;
    try { r = await runEval(ws, sess.connectUrl, inner, turns); }
    finally { release(sess.id); }
    const ok = r.status === 'completed';
    console.log(`  ${ok ? C.g('✓ completed') : C.r('✗ ' + r.status)}  ${r.turns} turns · $${r.cost_usd} · ${r.duration_sec}s\n`);
    results.push({ skill: s, ...r, ok });
  }

  // table
  console.log(C.o('━━━ RESULTS ━━━'));
  console.log(C.dim('skill'.padEnd(28) + 'turns'.padEnd(8) + 'cost'.padEnd(9) + 'latency'.padEnd(9) + 'status'));
  for (const r of results) {
    console.log((r.skill).padEnd(28) + String(r.turns).padEnd(8) + ('$' + r.cost_usd).padEnd(9) + (r.duration_sec + 's').padEnd(9) + (r.ok ? C.g('completed') : C.r(r.status)));
  }
  if (results.length === 2 && results[0].skill === 'none') {
    const [n, s] = results;
    const dT = n.turns - s.turns, dC = (n.cost_usd - s.cost_usd).toFixed(2);
    console.log(`\n${C.o('Δ with skill:')} ${dT >= 0 ? C.g(dT + ' fewer turns') : C.r(-dT + ' more turns')} · ${dC >= 0 ? C.g('$' + dC + ' cheaper') : C.r('$' + -dC + ' costlier')}`);
  }
  process.exit(0);
}

// ── inner agent ──
function runEval(ws, connectUrl, model, maxTurns) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(ROOT, 'autobrowse', 'scripts', 'evaluate.mjs'),
      '--task', 'demo', '--workspace', ws, '--env', 'remote', '--connect-url', connectUrl, '--model', model, '--run-number', '1'],
      { env: { ...ENV, MAX_TURNS: String(maxTurns) } });
    let out = '', tail = [];
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => { for (const l of String(d).split('\n')) { const m = l.match(/^\s*\[(\d+)\]\s+(exec|snapshot|done|error):\s*(.*)/); if (m) process.stdout.write(`\r  ${C.dim('turn ' + m[1] + ' · ' + m[2] + ' ' + m[3].slice(0, 40))}          `); if (l.trim()) { tail.push(l); if (tail.length > 8) tail.shift(); } } });
    child.on('close', c => { process.stdout.write('\r' + ' '.repeat(70) + '\r'); const j = out.split('\n').filter(l => l.trim().startsWith('{')).pop(); if (!j) return reject(new Error('no result (exit ' + c + ')\n' + tail.join('\n'))); try { resolve(JSON.parse(j)); } catch (e) { reject(e); } });
    child.on('error', reject);
  });
}

// ── browserbase helpers ──
async function browseJson(args) { const { stdout } = await exec(BROWSE, args, { env: ENV, maxBuffer: 1 << 24 }); const a = stdout.indexOf('{'), b = stdout.lastIndexOf('}'); return JSON.parse(stdout.slice(a, b + 1)); }
async function createSession() { const c = await browseJson(['cloud', 'sessions', 'create', '--keep-alive']); const g = await browseJson(['cloud', 'sessions', 'get', c.id]); const d = await browseJson(['cloud', 'sessions', 'debug', c.id]); return { id: c.id, connectUrl: g.connectUrl, live: d.debuggerFullscreenUrl }; }
function release(id) { browseJson(['cloud', 'sessions', 'update', id, '--status', 'REQUEST_RELEASE']).catch(() => {}); }

// ── misc ──
async function listSkills() { try { const ds = await readdir(SKILLS_DIR, { withFileTypes: true }); return ds.filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } }
async function readSkill(name) { const p = join(SKILLS_DIR, name, 'SKILL.md'); if (!existsSync(p)) { console.error(`skill not found: ${name} (${p})`); process.exit(1); } return readFile(p, 'utf8'); }
function sanitize(s) { return s.replace(/[^a-z0-9]+/gi, '-'); }
function resolveBrowse() { if (process.env.BROWSE_BIN && existsSync(process.env.BROWSE_BIN)) return process.env.BROWSE_BIN; const k = `${process.env.HOME}/.nvm/versions/node/v24.11.1/bin/browse`; return existsSync(k) ? k : 'browse'; }
function loadEnv() { try { for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {} }
function parseArgs(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (t.startsWith('--')) { const k = t.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; if (o[k] === undefined) o[k] = v; else o[k] = [].concat(o[k], v); } else o._.push(t); } return o; }

main().catch(e => { console.error('\n' + C.r('demo failed: ' + e.message)); process.exit(1); });
