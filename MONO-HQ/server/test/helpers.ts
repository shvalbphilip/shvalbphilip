import { createApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { AiRunner, AiRunResult, AiRunRequest } from '../src/ai.ts';

export function makeApp(over: Partial<ReturnType<typeof loadConfig>['defaults']> = {}, runner?: AiRunner, extra: { retryBackoffMs?: number } = {}): App {
  const cfg = loadConfig({} as NodeJS.ProcessEnv);
  cfg.defaults = { ...cfg.defaults, ...over };
  return createApp({ cfg, dataDir: ':memory:', runner, startScheduler: false, demoStepMs: 5, ...extra });
}

export async function waitFor<T>(fn: () => T | undefined | false | null, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export class FakeRunner implements AiRunner {
  calls: AiRunRequest[] = [];
  constructor(public behave: (req: AiRunRequest, signal: AbortSignal) => Promise<AiRunResult> | AiRunResult = () => ({ ok: true, text: '{"publicSummary":"סיכום","summaryHe":"הכל תקין","nextSteps":["צעד"],"answerHe":"תשובה"}', costUsd: 0.05, observedModels: ['claude-sonnet-5-5'] })) {}
  async cliVersion() { return '2.1.296'; }
  async run(req: AiRunRequest, signal: AbortSignal) { this.calls.push(req); return this.behave(req, signal); }
}

/** Today in Jerusalem as YYYY-MM-DD plus offset days, for date-relative fixtures. */
export function ymd(offsetDays = 0, now = new Date()): string {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
}
