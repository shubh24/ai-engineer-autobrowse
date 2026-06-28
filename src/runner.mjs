// autobrowse — the self-improving training loop.
//  the outer loop (this file, trainer LLM) drives iterations of:
//    create Browserbase session (proxies/verified = false)
//      → run inner agent (vendored autobrowse/evaluate.mjs, executor LLM)
//      → read the run summary
//      → trainer LLM: study → ONE hypothesis → rewrite strategy.md → judge
//    repeat ≤N or until pass → graduate a SKILL.md
// Emits a structured event stream that the UI renders live.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // forge/
const round = (n) => Math.round(n * 100) / 100;

// Resolve the real `browse` CLI (avoid a shadowed node_modules/.bin/browse).
const BROWSE = (() => {
  if (process.env.BROWSE_BIN && existsSync(process.env.BROWSE_BIN)) return process.env.BROWSE_BIN;
  const known = `${process.env.HOME}/.nvm/versions/node/v24.11.1/bin/browse`;
  return existsSync(known) ? known : 'browse';
})();
const BROWSE_DIR = dirname(BROWSE);

async function browseJson(args, env) {
  const { stdout } = await exec(BROWSE, args, { env, maxBuffer: 1 << 24 });
  // CLI prints pretty (multi-line) JSON, sometimes after an "Update available" notice.
  const a = stdout.indexOf('{'), b = stdout.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error(`unexpected browse output: ${stdout.slice(0, 80)}`);
  return JSON.parse(stdout.slice(a, b + 1));
}

export async function runAutobrowse(run, emit, ctx) {
  const o = run.opts || {};
  const innerModel = o.innerModel || 'claude-haiku-4-5-20251001';
  const outerModel = o.outerModel || 'claude-sonnet-4-6';
  const maxIters = Math.max(1, Math.min(8, o.iterations || 3));
  const maxTurns = o.maxTurns || 30; // compaction keeps context bounded, so a hard task has room to finish
  const env = { ...ctx.env, PATH: `${BROWSE_DIR}:${ctx.env.PATH}` };

  const { site, task } = parsePrompt(run.prompt);
  const slug = slugify(site);
  emit('run-started', { site, task, prompt: run.prompt, iterationsPlanned: maxIters, models: { executor: innerModel, trainer: outerModel } });

  // scaffold the task the way evaluate.mjs expects: <ws>/tasks/<slug>/task.md
  const taskDir = join(ctx.workspace, 'tasks', slug);
  await mkdir(taskDir, { recursive: true });
  await writeRel(ctx, emit, join('tasks', slug, 'task.md'), buildTaskMd(site, task));
  let strategy = `# ${slug} Navigation Skill\n\n(grows as the agent learns through iterations)\n`;
  await writeRel(ctx, emit, join('tasks', slug, 'strategy.md'), strategy);

  const anthropic = new Anthropic({ apiKey: ctx.env.ANTHROPIC_API_KEY, baseURL: ctx.env.ANTHROPIC_BASE_URL || undefined });

  let passed = false, lastMetrics = {};
  for (let iter = 1; iter <= maxIters && !passed; iter++) {
    emit('iteration-started', { iter });

    // 1) fresh isolated session — proxies/verified OFF (free-account friendly)
    let session;
    try {
      const created = await browseJson(['cloud', 'sessions', 'create', '--keep-alive'], env);
      const got = await browseJson(['cloud', 'sessions', 'get', created.id], env);
      const dbg = await browseJson(['cloud', 'sessions', 'debug', created.id], env);
      session = { id: created.id, connectUrl: got.connectUrl, live: dbg.debuggerFullscreenUrl };
    } catch (e) {
      emit('outer-reasoning', { iter, phase: 'study', text: `Could not create a Browserbase session: ${e.message}. Check BROWSERBASE_API_KEY.` });
      throw e;
    }
    emit('session', { iter, sessionId: session.id, liveViewUrl: session.live });

    // 2) inner agent — stream its turns
    let result;
    try {
      result = await runInner({ slug, workspace: ctx.workspace, connectUrl: session.connectUrl, model: innerModel, runNumber: iter, maxTurns, env, emit, iter });
    } finally {
      browseJson(['cloud', 'sessions', 'update', session.id, '--status', 'REQUEST_RELEASE'], env).catch(() => {});
    }
    lastMetrics = { cost: result.cost_usd, latency: Math.round(result.duration_sec), turns: result.turns };
    emit('metrics', { iter, ...lastMetrics });

    // 3) read what happened
    const summary = await readFile(join(result.trace_dir, 'summary.md'), 'utf8').catch(() => '(no summary written)');

    // 4) trainer: study → hypothesis → rewrite strategy.md → judge
    emit('outer-reasoning', { iter, phase: 'study', text: 'Reading the run trace…' });
    const review = await trainerStep({ anthropic, model: outerModel, prompt: run.prompt, strategy, summary, iter, isLast: iter === maxIters, status: result.status, steer: o.steer });
    emit('outer-reasoning', { iter, phase: 'study', text: review.study });
    emit('outer-reasoning', { iter, phase: 'hypothesis', text: review.hypothesis });

    const before = strategy;
    strategy = review.strategy_md || strategy;
    await writeRel(ctx, emit, join('tasks', slug, 'strategy.md'), strategy);
    emit('strategy-updated', { iter, added: review.added || [], diff: lineDiff(before, strategy) });
    emit('judged', { iter, verdict: review.verdict, pass: !!review.pass });
    passed = !!review.pass;
  }

  // 5) graduate → workspace copy + install into ./.claude/skills/<name>/ (usable by Claude Code)
  emit('outer-reasoning', { iter: 0, phase: 'study', text: 'Graduating the skill…' });
  const skill = await graduateSkill({ anthropic, model: outerModel, prompt: run.prompt, strategy, site, passed });
  await writeRel(ctx, emit, 'SKILL.md', skill);
  const skillName = (skill.match(/name:\s*["']?([a-z0-9-]+)/i) || [, slug])[1];
  const installDir = join(ROOT, '.claude', 'skills', skillName);
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, 'SKILL.md'), skill);
  emit('file-written', { name: `.claude/skills/${skillName}/SKILL.md`, path: join(installDir, 'SKILL.md'), bytes: Buffer.byteLength(skill) });
  emit('graduated', { skill, skillName, installPath: `.claude/skills/${skillName}/SKILL.md`, passed, metrics: lastMetrics });
}

// ── inner agent (vendored evaluate.mjs) ──────────────────────────────────────
function runInner({ slug, workspace, connectUrl, model, runNumber, maxTurns, env, emit, iter }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [
      join(ROOT, 'autobrowse', 'scripts', 'evaluate.mjs'),
      '--task', slug, '--workspace', workspace, '--env', 'remote',
      '--connect-url', connectUrl, '--model', model, '--run-number', String(runNumber),
    ], { env: { ...env, MAX_TURNS: String(maxTurns) } });

    let stdout = '', stderrBuf = '';
    const stderrTail = [];
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderrBuf += d;
      for (const l of String(d).split('\n')) if (l.trim()) { stderrTail.push(l); if (stderrTail.length > 12) stderrTail.shift(); }
      let nl;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, nl); stderrBuf = stderrBuf.slice(nl + 1);
        const m = line.match(/^\s*\[(\d+)\]\s+(\w+):\s*(.*)$/);
        if (!m) continue;
        const [, turn, kind, rest] = m;
        if (kind === 'reasoning') emit('inner-action', { iter, turn: +turn, action: 'think', detail: rest });
        else if (kind === 'exec') { const c = rest.replace(/^browse\s+/, ''); const verb = c.split(/\s+/)[0]; emit('inner-action', { iter, turn: +turn, action: verb, detail: c.slice(verb.length).trim() }); }
        else if (kind === 'snapshot') emit('inner-action', { iter, turn: +turn, action: 'snapshot', detail: rest });
        else if (kind === 'error') emit('inner-action', { iter, turn: +turn, action: 'error', detail: rest });
        else if (kind === 'ok') emit('inner-action', { iter, turn: +turn, action: 'ok', detail: rest.slice(0, 80) });
        else if (kind === 'done') emit('inner-action', { iter, turn: +turn, action: 'done', detail: '' });
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const json = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!json) return reject(new Error(`inner agent exited ${code} with no result. last stderr:\n${stderrTail.join('\n')}`));
      try { resolve(JSON.parse(json)); } catch (e) { reject(e); }
    });
  });
}

// ── trainer LLM ──────────────────────────────────────────────────────────────
async function trainerStep({ anthropic, model, prompt, strategy, summary, iter, isLast, status, steer }) {
  const sys = `You are the TRAINER in a self-improving browser-agent loop. A frozen executor agent just attempted a task using the current strategy.md. Read its run summary, then improve the skill.

Your job each round:
1. STUDY: in 1-2 sentences, what happened — did it achieve the goal? what was the single biggest failure or friction point?
2. HYPOTHESIS: ONE concrete, testable heuristic that would fix that failure (a direct URL shortcut, a specific wait, an exact selector/sequence, a success check). IMPORTANT: if the executor burned many turns fighting a UI widget (date picker, dropdown, modal, autocomplete), do NOT propose a better way to click it — propose ELIMINATING it. Most sites encode the full query in the URL (query params, or a natural-language "?q=" search). Prefer constructing the URL directly and landing past the widget.
3. REWRITE strategy.md: keep everything that worked, add your heuristic. A good strategy has a fast-path (direct URLs/shortcuts), exact step sequence with timing notes, site-specific selectors, and a success check. Be concrete.
4. JUDGE: did the executor actually ACHIEVE THE TASK GOAL in this run? Set pass=true only if the final output clearly satisfies the goal.${isLast ? ' This is the final iteration — be decisive.' : ''}

Return via the submit_review tool only.`;

  const steerLine = steer ? `\n\nHUMAN STEER (high priority — incorporate this into your hypothesis & strategy): ${steer}` : '';
  const user = `TASK: ${prompt}\n\nCURRENT strategy.md:\n"""\n${strategy}\n"""\n\nRUN ${iter} SUMMARY (executor status: ${status}):\n"""\n${summary.slice(0, 12000)}\n"""${steerLine}`;

  const tool = {
    name: 'submit_review', description: 'Submit the training review.',
    input_schema: {
      type: 'object',
      properties: {
        study: { type: 'string' }, hypothesis: { type: 'string' },
        strategy_md: { type: 'string', description: 'the FULL rewritten strategy.md' },
        added: { type: 'array', items: { type: 'string' }, description: 'the new heuristic line(s)' },
        verdict: { type: 'string', description: 'short verdict, e.g. "progress — found the date picker" or "PASS"' },
        pass: { type: 'boolean' },
      },
      required: ['study', 'hypothesis', 'strategy_md', 'verdict', 'pass'],
    },
  };
  const r = await anthropic.messages.create({ model, max_tokens: 4096, system: sys, tools: [tool], tool_choice: { type: 'tool', name: 'submit_review' }, messages: [{ role: 'user', content: user }] });
  const block = r.content.find((b) => b.type === 'tool_use');
  return block ? block.input : { study: 'parse failed', hypothesis: '', strategy_md: strategy, verdict: 'error', pass: false };
}

async function graduateSkill({ anthropic, model, prompt, strategy, site, passed }) {
  const sys = `You convert a trained strategy into a clean, self-contained SKILL.md for a browser-driving agent (Claude Code / Codex). Output ONLY the SKILL.md via the submit_skill tool. It must have YAML frontmatter (name, description with trigger keywords) and sections: Purpose, When to Use, Workflow (exact browse steps), Heuristics learned. Make it usable by someone who has never seen this run.`;
  const user = `TASK: ${prompt}\nSITE: ${site}\nPASSED: ${passed}\n\nFINAL strategy.md:\n"""\n${strategy}\n"""`;
  const tool = { name: 'submit_skill', description: 'Submit the final SKILL.md', input_schema: { type: 'object', properties: { skill_md: { type: 'string' } }, required: ['skill_md'] } };
  const r = await anthropic.messages.create({ model, max_tokens: 4096, system: sys, tools: [tool], tool_choice: { type: 'tool', name: 'submit_skill' }, messages: [{ role: 'user', content: user }] });
  const block = r.content.find((b) => b.type === 'tool_use');
  return block ? block.input.skill_md : strategy;
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function writeRel(ctx, emit, rel, content) {
  const path = join(ctx.workspace, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  emit('file-written', { name: rel, path, bytes: Buffer.byteLength(content) });
}
function parsePrompt(prompt = '') {
  const url = (prompt.match(/https?:\/\/[^\s]+/) || [])[0];
  let site = url ? new URL(url).hostname.replace(/^www\./, '') : (prompt.match(/\b((?:[a-z0-9-]+\.)+(?:com|org|gov|io|ai|net|co))\b/i) || [])[1];
  if (!site) site = 'the-target-site';
  return { site, task: prompt };
}
function slugify(s) { return s.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40); }
function buildTaskMd(site, task) {
  return `# Task\n\n${task}\n\n- Target site: ${site}\n- Return the result as a clear JSON object when done.\n`;
}
function lineDiff(before, after) {
  const b = new Set(before.split('\n')); const out = [];
  for (const l of after.split('\n')) if (l.trim() && !b.has(l)) out.push({ op: '+', line: l });
  return out.slice(0, 40);
}
