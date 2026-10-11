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
  failure?: 'cli-missing' | 'model-mismatch' | 'timeout' | 'cancelled' | 'cli-error' | 'budget';
  detail?: string;
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
        ...(tools ? ['--allowedTools', tools] : []),
        '--max-budget-usd', String(req.maxBudgetUsd),
        '--no-session-persistence',
      ];
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: REQUIRED_MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' };
      delete env.MONO_ACCESS_TOKEN;
      const child = spawn(this.bin, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

      const observed = new Set<string>();
      let text = '', cost = 0, buf = '', stderr = '', settled = false, mismatch: string | null = null;
      let timedOut = false, cancelled = false, resultErr: string | null = null, budgetHit = false;
      const toolById = new Map<string, string>();

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
        if (msg.type === 'system' && msg.subtype === 'init') noteModel(msg.model);
        else if (msg.type === 'assistant') {
          noteModel(msg.message?.model);
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_use') {
              toolById.set(b.id, b.name);
              let host: string | undefined;
              try { if (typeof b.input?.url === 'string') host = new URL(b.input.url).hostname; } catch { /* ignore */ }
              req.onTool?.({ phase: 'started', toolName: String(b.name), host });
            }
          }
        } else if (msg.type === 'user') {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_result') req.onTool?.({ phase: 'completed', toolName: toolById.get(b.tool_use_id) ?? 'tool', failed: !!b.is_error });
          }
        } else if (msg.type === 'result') {
          if (typeof msg.total_cost_usd === 'number') cost = msg.total_cost_usd;
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
        const base = { text, costUsd: cost, observedModels: models };
        if (mismatch) return finish({ ...base, ok: false, text: '', failure: 'model-mismatch', detail: `זוהה מודל לא מורשה: ${mismatch}` });
        if (cancelled) return finish({ ...base, ok: false, failure: 'cancelled', detail: 'בוטל על ידי המשתמש או מתג החירום' });
        if (timedOut) return finish({ ...base, ok: false, failure: 'timeout', detail: 'חרג מזמן הריצה המרבי' });
        if (budgetHit) return finish({ ...base, ok: false, failure: 'budget', detail: 'הושג תקרת העלות למשימה' });
        if (models.length === 0 && code === 0) return finish({ ...base, ok: false, failure: 'model-mismatch', detail: 'לא ניתן היה לאמת איזה מודל רץ' });
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
