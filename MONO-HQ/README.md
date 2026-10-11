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

Stop with `Ctrl+C`. Data lives in `MONO-HQ/data/mono.db` (git-ignored, directory `0700`, file `0600`). Deleting that file resets the app.

Configuration is read from the environment; `npm start` / `npm run dev:server` also load `MONO-HQ/.env.local` if it exists (git-ignored). Keys: `MONO_HOST`, `MONO_PORT`, `MONO_DATA_DIR`, `MONO_ACCESS_TOKEN`, `CLAUDE_BIN`, `DRY_RUN`, `MAX_DAILY_COST_USD`, `MAX_MONTHLY_COST_USD`, `MAX_CONCURRENT_AI_JOBS`, `MAX_JOB_MINUTES`, `MAX_RETRIES` (see `.env.example`).

Verify: `npm run check` = typecheck + `vitest` (121 tests: event immutability, guardrails, DST schedules, CLI adapter against a fake `claude`, approvals, CSV dedup, HTTP auth, the security fixes below, safe defaults, repo hygiene) + `vite build` + `npm audit --audit-level=high` + `scripts/secret-scan.mjs` (fails on any key / IBAN / card-shaped string in a tracked file). The same command runs in GitHub Actions on every pull request (`.github/workflows/ci.yml`).

## What you see

| View | What it shows |
|---|---|
| המשרד החי | 8 desks. Bubbles show only the latest **logged** event; idle agents say ממתין למשימה. Animations run only while a task is actually running. |
| משימות | Task queue with steps, pause/resume/cancel/retry, pending approvals. |
| אוטומציות | Daily 21:30, weekly Sun 19:00, salary-day (draft 09:00), weekly research (draft), risk watch (on import). All disabled until confirmed. |
| הכסף שלי | Balances, budgets, transactions — empty until you import a CSV. Every figure is flagged מאומת / מדווח / משוער. |
| מחקר | SCOUT findings with source URL, date, official/unverified flag and change-since-last-check. |
| דוחות | Markdown + JSON artifacts produced by completed tasks. |
| מערכת | DRY_RUN toggle, kill switch, cost ceilings, model verification, permissions, sessions (logout / revoke all devices), audit log with chain-integrity status. |

**DEMO mode** (toggle in the header) plays a scripted, clearly-labelled scene. Demo events are stored with `isDemo=true` and can never appear in REAL mode.

## Turning on real AI

1. `claude --version` must be ≥ 2.1.257 and you must be logged in.
2. In מערכת, click **כבה מצב יבש** and confirm. Then **אמת עכשיו** runs a ~$0.01 probe and must report `verified` for `claude-sonnet-5-5`.
3. Every AI step runs `claude -p --model claude-sonnet-5-5 --agent <name> --tools <per-agent list> --max-budget-usd <cap>` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. If any other model shows up in the stream the run is killed and marked **failed** — there is no silent fallback.
   Tool lists are per agent and enforced by the CLI flag, not by the prompt: **MONO** summary steps get `--tools ""` (no tools at all), **SCOUT** gets `WebSearch,WebFetch` only and is told to fetch nothing outside `gov.il` / `boi.org.il` (the server discards any other URL it returns anyway), every other agent gets `Read,Glob,Grep`.

Default ceilings (editable in מערכת): **$2/day, $25/month, 2 concurrent AI jobs, 12-minute TTL, 1 retry**. These are application guardrails, not Anthropic billing limits. Spend is the `total_cost_usd` the CLI reports, never a token estimate.

## Security model

- Binds to `127.0.0.1` only. To reach it from your phone set `MONO_HOST` **and** a `MONO_ACCESS_TOKEN` (≥ 16 chars) — the server refuses to start otherwise.
- **Off-loopback access requires HTTPS.** With a token configured the session cookie is always `Secure` and `Strict-Transport-Security` is sent, so a plain-`http://` remote connection will not log in. Use Tailscale (`tailscale serve`) or a reverse proxy that terminates TLS in front of the port.
- **Host allowlist.** Requests are answered `421` unless their `Host` is `127.0.0.1`, `localhost`, `[::1]` or exactly `MONO_HOST` (any port). Set `MONO_HOST` to the address clients actually type (e.g. your Tailscale IP or hostname), not `0.0.0.0`. Browser `Origin` on mutations is checked against the same allowlist, never against the incoming `Host` (DNS-rebinding defence).
- **Sessions.** Login creates a random 256-bit session id (30 days) stored server-side as a hash; the cookie is HttpOnly, SameSite=Strict, Secure. `POST /api/logout` revokes the current session, `POST /api/sessions/revoke-all` every session (both reachable from מערכת). 5 wrong tokens/minute per IP are rate-limited.
- **Step-up.** With a token configured, turning DRY_RUN off, releasing the kill switch and raising `maxDailyCostUsd` / `maxMonthlyCostUsd` / `maxConcurrentAiJobs` require the token to be re-entered in that request (the UI asks for it in the confirm dialog). Engaging the kill switch, turning DRY_RUN on and lowering limits never do. In loopback-only mode (no token) the explicit `confirm` stays the gate.
- Agents get per-agent least-privilege tools (see above). No Bash, no file writes, no MCP. Imported text and web pages are treated as untrusted data in every prompt.
- Identifiers (cards, IBAN, IDs, phones, emails, API keys) are redacted before anything reaches the event log or a report (markdown, title and every string in the JSON artifact).
- Writes to your financial records (e.g. confirming duplicates) require an explicit approval and are written to the audit trail. Events and the audit log are append-only at the database level; each audit row carries `sha256(prev_hash, at, actor, action, detail)` and מערכת shows whether the chain still verifies. (A chain detects edits and deletions in the middle, not truncation of the newest rows.)
- Data directory `0700`, database `0600` (not applied on Windows). At most 20 live SSE connections (`503` beyond). Headers: CSP, `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, HSTS when a token is set.
- The repository is public: `data/`, `*.db`, `.env*` and bank exports are git-ignored; `npm run secret-scan` and a vitest case fail if a secret-looking string is ever tracked; `npm audit --audit-level=high` runs in `npm run check` and CI.

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
