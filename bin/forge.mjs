#!/usr/bin/env node
// npm run forge -- --prompt "go to <site> and do <task>" [--inner <model>] [--outer <model>] [--iters N] [--steer "hint"]
// Headless CLI for the training loop — same engine as the UI.
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnv();
const { runAutobrowse } = await import('../src/runner.mjs');

const C = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, o: s => `\x1b[38;5;202m${s}\x1b[0m`, p: s => `\x1b[38;5;141m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m` };
const a = parseArgs(process.argv.slice(2));
const prompt = a.prompt || a._.join(' ');
if (!prompt) { console.log('\nUsage: npm run forge -- --prompt "go to flights.google.com and find cheapest SFO→JFK" [--inner m] [--outer m] [--iters N] [--steer "hint"]\n'); process.exit(1); }

const ws = join(ROOT, 'workspace', 'cli-' + randomUUID().slice(0, 8));
await mkdir(ws, { recursive: true });
const run = { prompt, opts: { innerModel: a.inner, outerModel: a.outer, iterations: Number(a.iters) || 3, steer: a.steer || undefined } };

let turn = 0;
function emit(type, d = {}) {
  switch (type) {
    case 'run-started': console.log(`\n${C.o('▲ autobrowse')} ${C.dim(d.models.executor + ' (exec) / ' + d.models.trainer + ' (train) · ≤' + d.iterationsPlanned + ' iters')}\n${C.dim('task:')} ${prompt}`); break;
    case 'iteration-started': turn = 0; console.log(`\n${C.o('── iteration ' + d.iter + ' ──')}`); break;
    case 'session': console.log(C.dim('  session ' + (d.sessionId || '').slice(0, 8) + ' · live: ' + (d.liveViewUrl || '').slice(0, 60) + '…')); break;
    case 'inner-action': if (d.action !== 'think') process.stdout.write(`\r  ${C.dim('turn ' + d.turn + ' · ' + d.action + ' ' + (d.detail || '').slice(0, 44))}            `); break;
    case 'metrics': process.stdout.write('\r' + ' '.repeat(72) + '\r'); console.log(C.dim(`  inner: ${d.turns} turns · $${d.cost} · ${d.latency}s`)); break;
    case 'outer-reasoning': if (d.phase === 'hypothesis') console.log(`  ${C.p('hypothesis:')} ${d.text}`); else if (d.text && !/^reading|graduating/i.test(d.text)) console.log(`  ${C.dim('study: ' + d.text)}`); break;
    case 'strategy-updated': for (const x of (d.added || [])) console.log(`  ${C.g('+ ' + x)}`); break;
    case 'judged': console.log(`  ${C.b('verdict:')} ${d.verdict}${d.pass ? C.g('  ✓ PASS') : ''}`); break;
    case 'graduated': console.log(`\n${C.o('✦ graduated')} → ${C.b(d.installPath)}\n${C.dim('use it: it is now in ./.claude/skills — Claude Code will pick it up here.')}`); break;
    case 'run-error': console.error(`\n${C.o('error:')} ${d.message}`); break;
  }
}

runAutobrowse(run, emit, { workspace: ws, env: process.env })
  .then(() => process.exit(0))
  .catch(e => { console.error('forge failed:', e.message); process.exit(1); });

function loadEnv() { try { for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {} }
function parseArgs(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (t.startsWith('--')) { const k = t.slice(2); o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else o._.push(t); } return o; }
