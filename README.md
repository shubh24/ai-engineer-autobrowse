# autobrowse

**Train a browser skill for a frozen agent — and watch it hill-climb, live.**

You give it a website and a task. A *frozen* doer agent tries it, fails, and a teacher agent reads what went wrong, forms one hypothesis, and edits a `strategy.md`. Repeat a few times until it passes, then run once more with the graduated skill — and out comes a `SKILL.md` you can paste into Claude Code or Codex.

This is the hands-on companion to the **"Hill Climbing Skills"** talk (AI Engineer).

---

## Setup

```bash
npm install                 # two deps: @anthropic-ai/sdk + dotenv

cp .env.example .env        # then paste your two keys:
#   BROWSERBASE_API_KEY     → free account at https://browserbase.com
#   ANTHROPIC_API_KEY       → console.anthropic.com

npm start                   # → http://localhost:4317
```

You also need the Browserbase **`browse` CLI** on your PATH (`npm i -g browse`).

> **Cost:** the doer and teacher default to Opus, so a full training run is roughly **$10–15**. Switch either model to Sonnet or Haiku in the UI to spend much less.

---

## What you'll see
- **Live browser** — the doer driving a real Browserbase session, embedded in the page.
- **Doer (inner loop)** — the executor's turn-by-turn actions (open · snapshot · click · extract).
- **Teacher (outer loop)** — studies the trace → one hypothesis → edits `strategy.md` → judges.
- **strategy.md** — the skill growing, iteration over iteration (the hill-climb).
- **Final run** — one more pass with the graduated `SKILL.md`, so you can compare iteration 1 to the finished skill.
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
src/runner.mjs        the teacher (outer loop): hypothesis → edit strategy.md → judge → graduate → final run
autobrowse/scripts/   the doer (inner agent): drives the browse CLI, writes a trace
public/index.html     the live UI
```
The inner agent (`evaluate.mjs`) is vendored from [browserbase/skills](https://github.com/browserbase/skills) (MIT).
