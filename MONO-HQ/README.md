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

Configuration is read from the environment; `npm start` / `npm run dev:server` also load `MONO-HQ/.env.local` if it exists (git-ignored). Keys: `MONO_HOST`, `MONO_PUBLIC_HOST`, `MONO_PORT`, `MONO_DATA_DIR`, `MONO_ACCESS_TOKEN`, `CLAUDE_BIN`, `DRY_RUN`, `MAX_DAILY_COST_USD`, `MAX_MONTHLY_COST_USD`, `MAX_CONCURRENT_AI_JOBS`, `MAX_JOB_MINUTES`, `MAX_RETRIES` (see `.env.example`).

Verify: `npm run check` = typecheck + `vitest` (147 tests: event immutability, guardrails, DST schedules, CLI adapter against a fake `claude`, approvals, CSV dedup, HTTP auth, the security fixes below, safe defaults, repo hygiene) + `vite build` + `npm audit --audit-level=high` + `scripts/secret-scan.mjs` (fails on any key / IBAN / card-shaped string in a tracked file). The same command runs in GitHub Actions on every pull request (`.github/workflows/ci.yml`).

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
2. In מערכת, click **כבה מצב יבש** and confirm. Then **אמת עכשיו** runs a real probe (observed: ~$0.001–0.003) and must report `verified` for `claude-sonnet-5-5`.
3. Every AI step runs `claude -p --model claude-sonnet-5-5 --agent <name> --tools <per-agent list> --permission-mode dontAsk --max-budget-usd <cap> --no-session-persistence --setting-sources project --strict-mcp-config --disable-slash-commands` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. If any other model shows up in the stream (including the usage breakdown) the run is killed and marked **failed**; there is no silent fallback.
   Tool lists are per agent and enforced by the CLI, not by the prompt: **MONO** gets no tools at all, **SCOUT** gets `WebSearch,WebFetch` only, and the CLI itself denies any fetch outside `gov.il` / `boi.org.il` and their subdomains (`WebFetch(domain:…)` rules under `dontAsk`). The server also drops any finding that cites another site, and marks a finding "official" only when SCOUT actually fetched a page on that host during the run. Every other agent gets `Read,Glob,Grep`, confined to the repository (the project deny list blocks `data/`, `.env*`, `*.db`, `*.csv`). `.claude/agents/*.md` declare the same lists, and a test keeps them in sync.
4. **Isolation from your own Claude Code setup.** The adapter loads project settings only (none of your user hooks, plugins or allow rules), no MCP servers from any config, and no skills. It also drops inherited `CLAUDE*` variables except auth/config (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, Bedrock/Vertex switches) and inherited `ANTHROPIC_*` variables except credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_VERTEX_PROJECT_ID`), so no model override or `ANTHROPIC_BASE_URL` redirect reaches an agent. The CLI's small-model calls are pinned to Sonnet too (`ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-5-5`). On every run the tool list the CLI reports at start-up is compared with the agent's allowlist, and any extra tool or MCP server fails the run (`tool-mismatch`) before the model is called.

   Observed on Claude Code 2.1.296, which is why each of these exists: without the isolation flags every user/plugin MCP server was loaded into the agents; an agent file's `tools:` line re-added `Glob`/`Grep` on top of `--tools ""`; `--allowedTools Read` let a read-only agent read files outside the repository; and `CLAUDE_AGENT_SDK_VERSION` inherited from a Claude desktop session made the CLI add a background `claude-haiku-5-5` call to every run; WebFetch processes every fetched page with `claude-haiku-5-5` unless that model is pinned, so every SCOUT run failed the model guard; and `WebFetch(domain:boi.org.il)` matches only the bare host, which is why the `*.` wildcards are listed too.

Default ceilings (editable in מערכת): **$2/day, $25/month, 2 concurrent AI jobs, 12-minute TTL, 1 retry**. These are application guardrails, not Anthropic billing limits. Spend is the `total_cost_usd` the CLI reports, never a token estimate. Each run holds its budget while it runs, so two concurrent jobs cannot jointly pass a cap, and a run stopped after the CLI started but before it reported its cost (cancel, kill switch, timeout, a model-guard kill) is charged its whole budget, recorded as `unreported-estimate` and shown in Missions as "up to $X (estimate)". A run that never reached start-up costs $0.

## Security model

- Binds to `MONO_HOST`, `127.0.0.1` by default. For phone access keep it on loopback and follow **Remote access from your phone** below. A non-loopback `MONO_HOST` or any `MONO_PUBLIC_HOST` requires a `MONO_ACCESS_TOKEN` (≥ 16 chars); the server refuses to start otherwise.
- **Off-loopback access requires HTTPS.** With a token configured the session cookie is always `Secure` and `Strict-Transport-Security` is sent, so a plain-`http://` remote connection will not log in.
- **Host allowlist.** Requests are answered `421` unless their `Host` is `127.0.0.1`, `localhost`, `[::1]`, exactly `MONO_HOST`, or exactly `MONO_PUBLIC_HOST` (any port). Set `MONO_HOST` to the address clients actually type, never `0.0.0.0`.
- **Writes are same-origin JSON only.** Every non-GET request must be `Content-Type: application/json` (which forces a CORS preflight for any cross-site write) and its `Origin`, when present, must be this server exactly: an allowed host on the port the request arrived on, or `https://MONO_PUBLIC_HOST`. Another app on a different localhost port is refused. The Vite dev server is allowed only through `MONO_DEV_ORIGINS`, which `npm run dev:server` sets. Origin is never compared with the incoming `Host` (DNS-rebinding defence).
- **Demo is a view.** In demo mode the server refuses every write that would act on the real system (409), the UI disables those controls, and no real approval is listed. Only the emergency stop can still be engaged, because it always acts on the real system.
- **Sessions.** Login creates a random 256-bit session id (30 days) stored server-side as a hash; the cookie is HttpOnly, SameSite=Strict, Secure. `POST /api/logout` revokes the current session, `POST /api/sessions/revoke-all` every session (both reachable from מערכת). 5 token attempts/minute per IP are allowed, counted when each request arrives, so parallel guesses use up attempts too.
- **Step-up.** With a token configured, turning DRY_RUN off, releasing the kill switch and raising `maxDailyCostUsd` / `maxMonthlyCostUsd` / `maxConcurrentAiJobs` require the token to be re-entered in that request (the UI asks for it in the confirm dialog). Engaging the kill switch, turning DRY_RUN on and lowering limits never do. In loopback-only mode (no token) the explicit `confirm` stays the gate.
- Agents get per-agent least-privilege tools (see above). No Bash, no file writes, no MCP. Imported text and web pages are treated as untrusted data in every prompt.
- Identifiers (cards, IBAN, IDs, phones, emails, API keys) are redacted before anything reaches the event log or a report (markdown, title and every string in the JSON artifact).
- Writes to your financial records (e.g. confirming duplicates) require an explicit approval and are written to the audit trail. Events and the audit log are append-only at the database level; each audit row carries `sha256(prev_hash, at, actor, action, detail)` and מערכת shows whether the chain still verifies. A one-row head checkpoint (`audit_head`, trigger-maintained, forward-only) records the entry count and newest hash, so truncating the newest rows is detected too. All of this stops tampering through the app or casual edits; someone with write access to `mono.db` who drops every trigger can still rewrite the whole log consistently.
- Data directory `0700`, database `0600` (not applied on Windows). At most 20 live SSE connections (`503` beyond). Headers: CSP, `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, HSTS when a token is set.
- The repository is public: `data/`, `*.db`, `.env*` and bank exports are git-ignored; `npm run secret-scan` and a vitest case fail if a secret-looking string is ever tracked; `npm audit --audit-level=high` runs in `npm run check` and CI.

## Remote access from your phone (Tailscale serve)

The supported path keeps the server on loopback and lets Tailscale put HTTPS in front of it, reachable only from devices in your own tailnet. There is no public exposure: do **not** use `tailscale funnel` or open a port on your router.

1. Install Tailscale on the Mac and the iPhone and sign both into the same tailnet. In the Tailscale admin console enable **MagicDNS** and **HTTPS certificates**. Optionally restrict access with an ACL so only your own devices reach the Mac.
2. Find the Mac's name: `tailscale status` (e.g. `my-mac.tail1234.ts.net`).
3. In `MONO-HQ/.env.local` (git-ignored):
   ```bash
   MONO_PUBLIC_HOST=my-mac.tail1234.ts.net   # what the phone types; allowlist only
   MONO_ACCESS_TOKEN=<openssl rand -hex 24>   # >= 16 chars; this is your password
   # leave MONO_HOST unset: the server keeps listening on 127.0.0.1 only
   ```
4. `npm start`, then `tailscale serve --bg 8787`. `tailscale serve status` should show `https://my-mac.tail1234.ts.net` → `http://127.0.0.1:8787`, tailnet only.
5. On the iPhone, with Tailscale connected, open `https://my-mac.tail1234.ts.net`, log in with the token, and use Share → **Add to Home Screen**.

To stop remote access: `tailscale serve reset`. Revoke phone sessions from מערכת (or `POST /api/sessions/revoke-all`).

Trade-offs: the Mac must be awake and online. Any device in your tailnet can reach the login page, so the token is the only credential beyond tailnet membership; keep it long and use ACLs if you share the tailnet. Requests proxied by `tailscale serve` arrive from `127.0.0.1`, so the login rate limit is shared rather than per device. Changing `MONO_PUBLIC_HOST` needs a restart. Not done: Tailscale identity headers are not used for authentication (the token is), and there is no push notification channel.

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
