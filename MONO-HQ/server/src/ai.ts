import { spawn, execFile } from 'node:child_process';
import { REQUIRED_MODEL, type AgentId, type ModelVerification } from '../../shared/contract.ts';

export interface ToolNote { phase: 'started' | 'completed'; toolName: string; host?: string; failed?: boolean }
export interface AiRunRequest {
  agentId: AgentId;
  prompt: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  onTool?: (n: ToolNote) => void;
  onModel?: (model: string) => void;
  onActivity?: () => void;
}
export interface AiRunResult {
  ok: boolean;
  text: string;
  costUsd: number;
  observedModels: string[];
  failure?: 'cli-missing' | 'model-mismatch' | 'tool-mismatch' | 'timeout' | 'cancelled' | 'cli-error' | 'budget';
  detail?: string;
  /** true only when the CLI's final result line reported total_cost_usd; a killed run usually has no such line. */
  costReported?: boolean;
  /** true once the CLI's start-up (system/init) line arrived; before that no model request can have been made. */
  started?: boolean;
  /** URLs of WebFetch calls the CLI allowed and completed (tool_result without an error), in order. */
  fetchedUrls?: string[];
}
export interface AiRunner {
  cliVersion(): Promise<string | null>;
  run(req: AiRunRequest, signal: AbortSignal): Promise<AiRunResult>;
}

/** Only the exact required model (optionally with a context-window suffix such as [1m]) is acceptable. */
export function isRequiredModel(model: string): boolean {
  return model === REQUIRED_MODEL || model.startsWith(`${REQUIRED_MODEL}[`);
}

export const MIN_CLI_VERSION = '2.1.257';
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}

/**
 * Least-privilege, per-agent tool allowlists. No Bash/Edit/Write, no MCP for anyone.
 * - mono only summarises data the server already computed: no tools at all.
 * - scout is the single agent allowed on the web (and only gov.il / boi.org.il per its prompt; research.ts re-validates URLs).
 * - everyone else may read project files only.
 */
export function toolsForAgent(agent: AgentId): string {
  if (agent === 'mono') return '';
  if (agent === 'scout') return 'WebSearch,WebFetch';
  return 'Read,Glob,Grep';
}

/**
 * Compares the tool surface the CLI reports in its init message with the agent's allowlist.
 * Returns a reason when anything extra is available (built-in tool or MCP server), null when it matches.
 * Observed on 2.1.296: an agent file's `tools:` frontmatter can re-add Glob/Grep on top of `--tools ""`,
 * and without --strict-mcp-config every user/plugin MCP server is loaded, so this is checked on every run.
 */
export function toolSurfaceViolation(agent: AgentId, init: { tools?: unknown; mcp_servers?: unknown }): string | null {
  if (!Array.isArray(init.tools)) return 'the CLI did not report its tool list';
  const allowed = new Set(toolsForAgent(agent).split(',').filter(Boolean));
  const extra = init.tools.map(String).filter((t) => !allowed.has(t));
  if (extra.length) return `unexpected tools: ${extra.join(', ')}`;
  if (init.mcp_servers !== undefined && (!Array.isArray(init.mcp_servers) || init.mcp_servers.length)) return 'unexpected MCP servers';
  return null;
}

/**
 * SCOUT may fetch only these hosts. Enforced by the CLI permission system (WebFetch(domain:...) allow rules under
 * dontAsk), not just by the prompt. Observed on 2.1.296: `domain:boi.org.il` matches only the bare host, so each
 * official domain is listed bare and as a `*.` wildcard (www.boi.org.il, www.gov.il, btl.gov.il, ...).
 */
export const SCOUT_FETCH_DOMAINS = ['boi.org.il', '*.boi.org.il', 'gov.il', '*.gov.il'] as const;

/** Pre-approvals under dontAsk: WebSearch as is, WebFetch only for the official domains. Read/Glob/Grep stay unlisted. */
export function preApprovedTools(tools: string): string {
  const out: string[] = [];
  for (const t of tools.split(',')) {
    if (t === 'WebSearch') out.push('WebSearch');
    if (t === 'WebFetch') out.push(...SCOUT_FETCH_DOMAINS.map((d) => `WebFetch(domain:${d})`));
  }
  return out.join(',');
}

/** Claude/Anthropic variables a child CLI may inherit: authentication and config location only. */
const CLAUDE_ENV_KEEP = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_VERTEX_PROJECT_ID',
]);

/**
 * Environment for the spawned CLI. Every other CLAUDE* variable is dropped: when MONO HQ is launched from a Claude Code
 * session or SDK host, variables such as CLAUDE_AGENT_SDK_VERSION leak in and change CLI behaviour (observed on 2.1.296:
 * an extra background claude-haiku-5-5 call per run, which the model guard then rejects). ANTHROPIC_* is reduced to
 * credentials: a model override (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL, ANTHROPIC_SMALL_FAST_MODEL) would change
 * what runs, and ANTHROPIC_BASE_URL could point at a proxy that reports one model while serving another.
 */
export function childEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (k === 'MONO_ACCESS_TOKEN') continue;
    if (/^(CLAUDE|ANTHROPIC_)/.test(k) && !CLAUDE_ENV_KEEP.has(k)) continue;
    env[k] = v;
  }
  env.CLAUDE_CODE_SUBAGENT_MODEL = REQUIRED_MODEL;
  env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
  // The CLI's small-model calls (WebFetch page processing, background helpers) default to claude-haiku-5-5, which made
  // every SCOUT run fail the model guard (observed on 2.1.296). Pin them to the required model as well.
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = REQUIRED_MODEL;
  env.ANTHROPIC_SMALL_FAST_MODEL = REQUIRED_MODEL;
  return env;
}

export class ClaudeCliRunner implements AiRunner {
  constructor(private bin: string, private cwd: string) {}

  cliVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(this.bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const m = /(\d+\.\d+\.\d+)/.exec(String(stdout));
        resolve(m ? m[1]! : null);
      });
    });
  }

  run(req: AiRunRequest, signal: AbortSignal): Promise<AiRunResult> {
    return new Promise((resolve) => {
      const tools = toolsForAgent(req.agentId);
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--model', REQUIRED_MODEL, // never pass --fallback-model: a silent downgrade must fail instead
        '--agent', req.agentId,
        '--tools', tools, // an empty list disables every built-in tool
        '--permission-mode', 'dontAsk',
        // Only the web tools need pre-approval under dontAsk. Read/Glob/Grep must NOT be listed: a bare `Read` allow rule
        // approves any path on disk (observed on 2.1.296), while unlisted they stay confined to the working directory.
        ...(preApprovedTools(tools) ? ['--allowedTools', preApprovedTools(tools)] : []),
        '--max-budget-usd', String(req.maxBudgetUsd),
        '--no-session-persistence',
        // Isolation from the operator's own Claude Code setup: no user/local settings (their hooks, plugins and
        // allow rules), no MCP servers from any config, no skills. Project settings (model pin, deny list) still load.
        '--setting-sources', 'project',
        '--strict-mcp-config',
        '--disable-slash-commands',
      ];
      const env = childEnv(process.env);
      const child = spawn(this.bin, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

      const observed = new Set<string>();
      let text = '', cost = 0, buf = '', stderr = '', settled = false, mismatch: string | null = null;
      let timedOut = false, cancelled = false, resultErr: string | null = null, budgetHit = false;
      let toolViolation: string | null = null, toolsChecked = false, costReported = false;
      const toolById = new Map<string, { name: string; url?: string }>();
      const fetchedUrls: string[] = [];

      const kill = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); };
      const finish = (r: AiRunResult) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(r); };
      const timer = setTimeout(() => { timedOut = true; kill(); }, req.timeoutMs);
      const onAbort = () => { cancelled = true; kill(); };
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });

      const noteModel = (m: unknown) => {
        if (typeof m !== 'string' || !m) return;
        observed.add(m);
        req.onModel?.(m);
        if (!isRequiredModel(m) && !mismatch) { mismatch = m; kill(); }
      };

      const handle = (line: string) => {
        req.onActivity?.();
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.type === 'system' && msg.subtype === 'init') {
          noteModel(msg.model);
          if (!toolsChecked) { toolsChecked = true; toolViolation = toolSurfaceViolation(req.agentId, msg); if (toolViolation) kill(); }
        }
        else if (msg.type === 'assistant') {
          noteModel(msg.message?.model);
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_use') {
              const url = typeof b.input?.url === 'string' ? b.input.url : undefined;
              toolById.set(b.id, { name: String(b.name), url });
              let host: string | undefined;
              try { if (url) host = new URL(url).hostname; } catch { /* ignore */ }
              req.onTool?.({ phase: 'started', toolName: String(b.name), host });
            }
          }
        } else if (msg.type === 'user') {
          for (const b of msg.message?.content ?? []) {
            if (b.type !== 'tool_result') continue;
            const used = toolById.get(b.tool_use_id);
            if (used?.name === 'WebFetch' && used.url && !b.is_error) fetchedUrls.push(used.url);
            req.onTool?.({ phase: 'completed', toolName: used?.name ?? 'tool', failed: !!b.is_error });
          }
        } else if (msg.type === 'result') {
          if (typeof msg.total_cost_usd === 'number') { cost = msg.total_cost_usd; costReported = true; }
          if (msg.modelUsage && typeof msg.modelUsage === 'object') for (const m of Object.keys(msg.modelUsage)) noteModel(m);
          if (msg.is_error) resultErr = String(msg.subtype ?? 'error');
          if (String(msg.subtype ?? '').includes('budget')) budgetHit = true;
          if (typeof msg.result === 'string') text = msg.result;
        }
      };

      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); }
      });
      child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-2000); });
      child.on('error', (e: NodeJS.ErrnoException) => {
        finish({ ok: false, text: '', costUsd: 0, observedModels: [...observed], failure: e.code === 'ENOENT' ? 'cli-missing' : 'cli-error', detail: e.code === 'ENOENT' ? 'Claude CLI לא נמצא' : e.message });
      });
      child.on('close', (code) => {
        if (buf.trim()) handle(buf.trim());
        const models = [...observed];
        const base = { text, costUsd: cost, observedModels: models, costReported, fetchedUrls, started: toolsChecked };
        if (mismatch) return finish({ ...base, ok: false, text: '', failure: 'model-mismatch', detail: `זוהה מודל לא מורשה: ${mismatch}` });
        if (toolViolation) return finish({ ...base, ok: false, text: '', failure: 'tool-mismatch', detail: `משטח הכלים אינו תואם להרשאות הסוכן (${toolViolation})` });
        if (cancelled) return finish({ ...base, ok: false, failure: 'cancelled', detail: 'בוטל על ידי המשתמש או מתג החירום' });
        if (timedOut) return finish({ ...base, ok: false, failure: 'timeout', detail: 'חרג מזמן הריצה המרבי' });
        if (budgetHit) return finish({ ...base, ok: false, failure: 'budget', detail: 'הושג תקרת העלות למשימה' });
        if (models.length === 0 && code === 0) return finish({ ...base, ok: false, failure: 'model-mismatch', detail: 'לא ניתן היה לאמת איזה מודל רץ' });
        if (!toolsChecked && code === 0) return finish({ ...base, ok: false, failure: 'tool-mismatch', detail: 'לא ניתן היה לאמת את משטח הכלים של הסוכן' });
        if (code !== 0 || resultErr) return finish({ ...base, ok: false, failure: 'cli-error', detail: resultErr ?? `קוד יציאה ${code}: ${stderr.slice(-200)}` });
        finish({ ...base, ok: true });
      });
      child.stdin.on('error', () => { /* process may exit early */ });
      child.stdin.end(req.prompt);
    });
  }
}

export async function verifyModelStatus(runner: AiRunner, opts: { dryRun: boolean; killSwitch: boolean; maxBudgetUsd: number }): Promise<ModelVerification> {
  const checkedAt = new Date().toISOString();
  const version = await runner.cliVersion();
  const base = { required: REQUIRED_MODEL, checkedAt, observedModels: [] as string[], cliVersion: version } as const;
  if (!version) return { ...base, status: 'cli-missing', detail: 'Claude CLI לא נמצא בנתיב. התקן Claude Code והתחבר כדי להפעיל ריצות אמיתיות.' };
  if (!versionAtLeast(version, MIN_CLI_VERSION)) return { ...base, status: 'failed', detail: `גרסת Claude Code ${version} ישנה מדי (נדרשת ${MIN_CLI_VERSION}+ לכפיית מודל תת-סוכנים). שדרג ל-Claude Code.` };
  if (opts.dryRun || opts.killSwitch) return { ...base, status: 'dry-run-skipped', detail: 'מצב יבש/מתג חירום פעיל — לא בוצעה קריאה אמיתית. המודל יאומת בקריאה האמיתית הראשונה.' };
  const res = await runner.run({ agentId: 'guardian', prompt: 'Reply with exactly: OK', maxBudgetUsd: opts.maxBudgetUsd, timeoutMs: 60_000 }, new AbortController().signal);
  if (res.ok && res.observedModels.length > 0 && res.observedModels.every(isRequiredModel)) {
    return { ...base, status: 'verified', observedModels: res.observedModels, detail: `אומת בריצה אמיתית: ${res.observedModels.join(', ')}` };
  }
  return { ...base, status: 'failed', observedModels: res.observedModels, detail: res.detail ?? 'האימות נכשל' };
}
