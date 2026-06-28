# ▲ autobrowse

**Train a browser skill for a frozen agent — and watch it hill-climb, live.**

You give it a website and a task. A *frozen* agent tries it, fails, and a trainer agent reads what went wrong, forms one hypothesis, and edits a `strategy.md`. Repeat a few times until it works — then out comes a `SKILL.md` you can paste into Claude Code or Codex.

This is the hands-on companion to the **"Skills are the New Weights"** talk (AI Engineer).

---

## Setup

```bash
npm install                 # two deps: @anthropic-ai/sdk + dotenv

cp .env.example .env        # then paste your two keys:
#   BROWSERBASE_API_KEY     → free account at https://browserbase.com
#   ANTHROPIC_API_KEY       → console.anthropic.com  (budget ~$2 of usage)

npm start                   # → http://localhost:4317
```

You also need the Browserbase **`browse` CLI** on your PATH (`npm i -g browse`).

---

## What you'll see
- **Live browser** — the agent driving a real Browserbase session, embedded in the page.
- **Inner loop** — the executor's turn-by-turn actions (open · snapshot · click · extract).
- **Outer loop** — the trainer: study the trace → one hypothesis → judge.
- **strategy.md** — the skill growing, iteration over iteration (the hill-climb).
- **Files on disk** — every artifact written to `./workspace/<run>/` in real time.
- **SKILL.md** — the graduated skill, installed to `./.claude/skills/<name>/`.

## Commands
```bash
npm start                                   # the live UI (the demo)
npm run forge -- --prompt "<task>" \        # headless training run
  [--inner <model>] [--outer <model>] [--iters N] [--steer "hint"]
npm run demo  -- --task "<task>" \           # before/after: naive vs trained
  --skill <name|none> [--skill <name2>]
```

## How it works
```
server.mjs            local server — serves the UI, runs the loop, streams events (SSE)
src/runner.mjs        the trainer (outer loop): hypothesis → edit strategy.md → judge → graduate
autobrowse/scripts/   the executor (inner agent): drives the browse CLI, writes a trace
public/index.html     the live UI
```
The inner agent (`evaluate.mjs`) is vendored from [browserbase/skills](https://github.com/browserbase/skills) (MIT).
