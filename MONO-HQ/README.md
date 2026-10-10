# MONO HQ · Financial AI Office

A Hebrew-RTL personal finance command center: eight Claude Sonnet 5.5 specialists at animated desks, a durable task queue, a DST-aware scheduler, approvals, cost guardrails and a kill switch. Everything runs locally; the only AI calls go through your own Claude Code CLI.

> **Honest scope.** This is a working local application, not a bank connector or a licensed adviser. Financial data enters only through CSV import you perform yourself. AI runs are **off by default** (`DRY_RUN=true`) and every automation ships **disabled** until you approve it in the UI.

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`)
- Claude Code CLI **2.1.257+** on your `PATH`, logged in (`claude`) — only needed for REAL mode

## Run it

```bash
cd MONO-HQ
npm install
npm run build          # builds the web app into dist/
npm start              # http://127.0.0.1:8787
```

Development (two terminals):

```bash
npm run dev:server     # API on :8787 with reload
npm run dev:web        # Vite on :5173, proxies /api
```

Stop with `Ctrl+C`. Data lives in `MONO-HQ/data/mono.db` (git-ignored). Deleting that file resets the app.

Verify: `npm run typecheck` and `npm test` (90 tests: event immutability, guardrails, DST schedules, CLI adapter against a fake `claude`, approvals, CSV dedup, HTTP auth, repo hygiene).

## What you see

| View | What it shows |
|---|---|
| המשרד החי | 8 desks. Bubbles show only the latest **logged** event; idle agents say ממתין למשימה. Animations run only while a task is actually running. |
| משימות | Task queue with steps, pause/resume/cancel/retry, pending approvals. |
| אוטומציות | Daily 21:30, weekly Sun 19:00, salary-day (draft 09:00), weekly research (draft), risk watch (on import). All disabled until confirmed. |
| הכסף שלי | Balances, budgets, transactions — empty until you import a CSV. Every figure is flagged מאומת / מדווח / משוער. |
| מחקר | SCOUT findings with source URL, date, official/unverified flag and change-since-last-check. |
| דוחות | Markdown + JSON artifacts produced by completed tasks. |
| מערכת | DRY_RUN toggle, kill switch, cost ceilings, model verification, permissions, audit log. |

**DEMO mode** (toggle in the header) plays a scripted, clearly-labelled scene. Demo events are stored with `isDemo=true` and can never appear in REAL mode.

## Turning on real AI

1. `claude --version` must be ≥ 2.1.257 and you must be logged in.
2. In מערכת, click **כבה מצב יבש** and confirm. Then **אמת עכשיו** runs a ~$0.01 probe and must report `verified` for `claude-sonnet-5-5`.
3. Every AI step runs `claude -p --model claude-sonnet-5-5 --agent <name> --tools Read,Glob,Grep,WebSearch,WebFetch --max-budget-usd <cap>` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. If any other model shows up in the stream the run is killed and marked **failed** — there is no silent fallback.

Default ceilings (editable in מערכת): **$2/day, $25/month, 2 concurrent AI jobs, 12-minute TTL, 1 retry**. These are application guardrails, not Anthropic billing limits. Spend is the `total_cost_usd` the CLI reports, never a token estimate.

## Security model

- Binds to `127.0.0.1` only. To reach it from your phone set `MONO_HOST` **and** a `MONO_ACCESS_TOKEN` (≥ 16 chars) — the server refuses to start otherwise — and put it behind HTTPS (Tailscale or a reverse proxy).
- Login sets an HttpOnly, SameSite=Strict cookie; 5 wrong tokens/minute are rate-limited.
- Agents get read-only tools. No Bash, no file writes, no MCP. Imported text and web pages are treated as untrusted data in every prompt.
- Identifiers (cards, IBAN, IDs, phones, emails, API keys) are redacted before anything reaches the event log or a report.
- Writes to your financial records (e.g. confirming duplicates) require an explicit approval and are written to an audit trail. Events are append-only at the database level.
- The repository is public: `data/`, `*.db`, `.env*` and bank exports are git-ignored; a test fails if a secret-looking string is ever tracked.

## After laptop sleep

The scheduler is a local process. A run missed by more than its grace window (2h daily, 6h weekly, 24h monthly/research) is logged as **missed** and never back-filled. Tasks interrupted by a crash are marked **failed** on the next start and are not re-run automatically. Cowork cloud scheduled tasks are **not** connected to this local queue.

## Layout

```
shared/contract.ts      API types shared by server and web
server/src              Node + SQLite backend (orchestrator, scheduler, guard, CLI adapter, HTTP/SSE)
server/test             vitest suite
web/src                 React 19 front end
fixtures/               synthetic CSV sample
spec/events.schema.json public event schema
../.claude/agents       the eight subagent definitions (repo root)
```
