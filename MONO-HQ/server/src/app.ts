import { fileURLToPath } from 'node:url';
import { REQUIRED_MODEL, type ModelVerification, type SystemView } from '../../shared/contract.ts';
import { ClaudeCliRunner, verifyModelStatus, type AiRunner } from './ai.ts';
import { verifyAuditChain } from './audit.ts';
import { loadConfig, type AppConfig } from './config.ts';
import { Demo } from './demo.ts';
import { openDb, setSetting, type Db } from './db.ts';
import { EventBus } from './events.ts';
import { Guard } from './guard.ts';
import { MoneyStore } from './money.ts';
import { Orchestrator } from './orchestrator.ts';
import { ReportStore } from './reports.ts';
import { ResearchStore } from './research.ts';
import { Scheduler } from './scheduler.ts';
import { SessionStore } from './sessions.ts';
import { StateBuilder } from './state.ts';
import { TaskStore } from './tasks.ts';

export interface App {
  cfg: AppConfig; db: Db; bus: EventBus; tasks: TaskStore; guard: Guard; money: MoneyStore; research: ResearchStore; reports: ReportStore;
  orch: Orchestrator; scheduler: Scheduler; demo: Demo; state: StateBuilder; runner: AiRunner; sessions: SessionStore;
  system(): SystemView; verifyModel(): Promise<ModelVerification>; close(): void;
}

export interface AppOptions { cfg?: AppConfig; runner?: AiRunner; dataDir?: string; startScheduler?: boolean; retryBackoffMs?: number; demoStepMs?: number }

export function createApp(opts: AppOptions = {}): App {
  const cfg = opts.cfg ?? loadConfig();
  const dataDir = opts.dataDir ?? cfg.dataDir;
  const db = openDb(dataDir);
  const bus = new EventBus(db);
  const tasks = new TaskStore(db);
  const guard = new Guard(db, cfg.defaults);
  const money = new MoneyStore(db);
  const research = new ResearchStore(db);
  const reports = new ReportStore(db);
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)); // .claude/agents lives at the repo root
  const runner = opts.runner ?? new ClaudeCliRunner(cfg.claudeBin, repoRoot);
  const orch = new Orchestrator({ db, bus, tasks, guard, money, research, reports, runner, retryBackoffMs: opts.retryBackoffMs });
  const scheduler = new Scheduler(db, guard, orch, money, bus);
  const demo = new Demo(db, bus, tasks, opts.demoStepMs);
  const state = new StateBuilder(db, bus, tasks, guard, orch, demo, !!cfg.accessToken);
  const sessions = new SessionStore(db);

  const spendRecordingRunner: AiRunner = {
    cliVersion: () => runner.cliVersion(),
    run: async (req, signal) => { const r = await runner.run(req, signal); if (r.costUsd > 0) guard.recordSpend('model-verification', r.costUsd, r.observedModels.join(',') || null, false); return r; },
  };

  async function verifyModel(): Promise<ModelVerification> {
    const g = guard.get();
    if (!g.dryRun && !g.killSwitch && !guard.canStartAi(0.05, orch.runningAiJobs).ok) {
      const v: ModelVerification = { required: REQUIRED_MODEL, status: 'failed', checkedAt: new Date().toISOString(), observedModels: [], cliVersion: await runner.cliVersion(), detail: 'האימות נחסם על ידי מגבלות העלות/הרצה.' };
      setSetting(db, 'modelVerification', v); return v;
    }
    const v = await verifyModelStatus(spendRecordingRunner, { dryRun: g.dryRun, killSwitch: g.killSwitch, maxBudgetUsd: 0.05 });
    setSetting(db, 'modelVerification', v);
    guard.audit('user', 'model.verify', v.status);
    return v;
  }

  function system(): SystemView {
    const audit = db.prepare('SELECT * FROM audit_log ORDER BY at DESC, rowid DESC LIMIT 100').all() as Array<{ id: string; at: string; actor: string; action: string; detail: string }>;
    return {
      guardrails: guard.get(), spend: guard.summary(), model: state.modelVerification(),
      permissions: [
        { scope: 'MONO: סיכום בלבד (ללא כלים)', granted: false, noteHe: 'שלב הסיכום רץ עם --tools "" — אין גישה לקבצים או לרשת' },
        { scope: 'SCOUT: WebSearch/WebFetch בלבד', granted: true, noteHe: 'רק gov.il / boi.org.il; כתובות נבדקות גם בשרת. תוכן אתרים נחשב נתונים לא אמינים, לא הוראות' },
        { scope: 'שאר הסוכנים: Read/Glob/Grep', granted: true, noteHe: 'קריאת קבצי פרויקט בלבד, ללא רשת, רק כשהסוכנים רצים באמת' },
        { scope: 'הרצת פקודות / כתיבת קבצים (Bash/Edit/Write)', granted: false, noteHe: 'חסום לסוכנים לצמיתות' },
        { scope: 'גישה לחשבונות בנק / העברות / הלוואות', granted: false, noteHe: 'לא מחובר. אין פעולות כספיות בשום מצב' },
        { scope: 'כתיבה לנתונים פיננסיים מקומיים', granted: true, noteHe: 'רק אחרי אישור מפורש ועם יומן ביקורת' },
      ],
      provenance: [
        { source: 'ייבוא CSV ידני', status: 'manual', noteHe: 'נתונים מסומנים "מדווח" — לא אומתו מול הבנק' },
        { source: 'Google Sheets / Drive', status: 'not-connected', noteHe: 'ממשק מתאם מוכן להרחבה, לא מחובר' },
        { source: 'Open Banking מוסדר', status: 'not-connected', noteHe: 'לא מחובר' },
        { source: 'ביט / דוחות כרטיס', status: 'manual', noteHe: 'דרך ייבוא CSV בלבד' },
        { source: 'אימייל', status: 'not-connected', noteHe: 'לא מחובר' },
      ],
      auditLog: audit.map((a) => ({ id: a.id, at: a.at, actor: a.actor, action: a.action, detail: a.detail })),
      auditChainValid: verifyAuditChain(db).valid,
      authRequired: !!cfg.accessToken, bindAddress: `${cfg.host}:${cfg.port}`,
    };
  }

  const close = () => { scheduler.stop(); orch.stop(); demo.stop(); db.close(); };
  if (opts.startScheduler !== false) scheduler.start();
  return { cfg, db, bus, tasks, guard, money, research, reports, orch, scheduler, demo, state, runner, sessions, system, verifyModel, close };
}
