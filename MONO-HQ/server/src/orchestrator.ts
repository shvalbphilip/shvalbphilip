import { REQUIRED_MODEL, type AgentId, type Approval, type EventOrigin, type EventType, type Task } from '../../shared/contract.ts';
import type { AiRunner, ToolNote } from './ai.ts';
import type { Db } from './db.ts';
import type { EventBus } from './events.ts';
import type { Guard } from './guard.ts';
import { MoneyStore, resolveDuplicates, suspectedDuplicates } from './money.ts';
import { clip, redact } from './redact.ts';
import type { ReportStore } from './reports.ts';
import type { ResearchStore } from './research.ts';
import { TaskStore } from './tasks.ts';
import { newId, nowIso } from './util.ts';
import { WORKFLOWS, type StepCtx, type StepOutput, type WorkflowDef } from './workflows.ts';

export interface OrchestratorDeps {
  db: Db; bus: EventBus; tasks: TaskStore; guard: Guard; money: MoneyStore; research: ResearchStore; reports: ReportStore; runner: AiRunner;
  maxConcurrentTasks?: number;
  retryBackoffMs?: number; // base for exponential backoff
}

export interface EnqueueSpec {
  workflow: string; origin: 'user' | 'scheduler'; title?: string; prompt?: string; automationId?: string; dedupKey?: string; maxCostUsd?: number;
}

const TOOL_LABEL: Record<string, string> = { WebSearch: 'חיפוש ברשת', WebFetch: 'קריאת מקור', Read: 'קריאת קבצי פרויקט', Glob: 'קריאת קבצי פרויקט', Grep: 'קריאת קבצי פרויקט' };
const TRANSIENT = new Set(['cli-error', 'timeout']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Orchestrator {
  private live = new Map<string, AbortController>();
  private maxCost = new Map<string, number>();
  private timers = new Set<NodeJS.Timeout>();
  private runningAi = 0;
  private pumping = false;
  private stopped = false;

  constructor(private d: OrchestratorDeps) {}

  get runningAiJobs(): number { return this.runningAi; }

  /* ---------- events ---------- */
  private ev(task: Task, agentId: AgentId, type: EventType, summary: string, origin: EventOrigin, extra: { toolCategory?: string; modelId?: string; sourceUrl?: string; actualCostUsd?: number; estimatedCostUsd?: number } = {}) {
    return this.d.bus.emitEvent({ runId: task.id, agentId, type, publicSummary: summary, origin, isDemo: false, ...extra });
  }

  /* ---------- lifecycle ---------- */
  enqueue(spec: EnqueueSpec): Task {
    const wf = WORKFLOWS[spec.workflow];
    if (!wf) throw new Error(`unknown workflow ${spec.workflow}`);
    const g = this.d.guard.get();
    const { task, created } = this.d.tasks.create({
      title: spec.title ?? wf.titleHe, kind: wf.kind, leadAgent: wf.leadAgent, isDemo: false, dryRun: g.dryRun, origin: spec.origin,
      automationId: spec.automationId, prompt: spec.prompt, dedupKey: spec.dedupKey, estimatedCostUsd: wf.steps.some((s) => s.kind === 'ai') ? (spec.maxCostUsd ?? wf.maxCostUsd) : 0,
      steps: wf.steps.map((s) => ({ agentId: s.agentId, kind: s.kind, title: s.titleHe })),
    });
    if (!created) return task;
    this.maxCost.set(task.id, spec.maxCostUsd ?? wf.maxCostUsd);
    this.ev(task, wf.leadAgent, 'queued', `בתור: ${task.title}`, spec.origin === 'scheduler' ? 'scheduler' : 'user');
    if (wf.needsApproval) {
      const ap = this.createApproval(task, 'guarded-write', wf.needsApproval.titleHe, wf.needsApproval.detailHe(this.ctxFor(task, wf)), 0);
      const t = this.d.tasks.transition(task.id, 'awaiting_approval', { approvalId: ap.id });
      this.ev(t, wf.leadAgent, 'awaiting_approval', `ממתין לאישורך: ${wf.needsApproval.titleHe}`, 'local-rules');
      return t;
    }
    this.pump();
    return task;
  }

  private createApproval(task: Task, action: string, titleHe: string, detailHe: string, cost: number): Approval {
    const id = newId('apr');
    this.d.db.prepare('INSERT INTO approvals (id, task_id, automation_id, action, title_he, detail_he, estimated_cost_usd, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, task.id, task.automationId ?? null, action, titleHe, detailHe, cost, 'pending', nowIso());
    return this.getApproval(id)!;
  }
  getApproval(id: string): Approval | undefined {
    const r = this.d.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    return r ? this.mapApproval(r) : undefined;
  }
  pendingApprovals(): Approval[] {
    return (this.d.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC").all() as Array<Record<string, string | number | null>>).map((r) => this.mapApproval(r));
  }
  private mapApproval(r: Record<string, string | number | null>): Approval {
    const a: Approval = { id: r.id as string, taskId: (r.task_id as string) ?? null, automationId: (r.automation_id as string) ?? null, action: r.action as string, titleHe: r.title_he as string, detailHe: r.detail_he as string, estimatedCostUsd: r.estimated_cost_usd as number, status: r.status as Approval['status'], createdAt: r.created_at as string };
    if (r.decided_at) a.decidedAt = r.decided_at as string;
    return a;
  }

  decideApproval(id: string, approve: boolean, actor = 'user'): Approval {
    const ap = this.getApproval(id);
    if (!ap) throw new Error('approval not found');
    if (ap.status !== 'pending') throw new Error(`approval already ${ap.status}`);
    this.d.db.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', nowIso(), id);
    this.d.guard.audit(actor, approve ? 'approval.approve' : 'approval.reject', `${ap.action} ${ap.taskId ?? ap.automationId ?? ''}`);
    if (ap.taskId) {
      const t = this.d.tasks.get(ap.taskId);
      if (t && t.status === 'awaiting_approval') {
        if (approve) { this.d.tasks.transition(t.id, 'queued'); this.pump(); }
        else { const c = this.d.tasks.transition(t.id, 'cancelled', { blocker: 'האישור נדחה' }); this.ev(c, c.leadAgent, 'cancelled', 'האישור נדחה — לא בוצע שינוי', 'user'); }
      }
    }
    return this.getApproval(id)!;
  }

  pump(): void {
    if (this.stopped) return;
    setImmediate(() => this.pumpNow());
  }
  private pumpNow(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      if (this.d.guard.get().killSwitch) return;
      const max = this.d.maxConcurrentTasks ?? 3;
      const queued = this.d.tasks.list({ demo: false, status: 'queued', limit: 50 }).reverse();
      for (const t of queued) {
        if (this.live.size >= max) break;
        if (this.live.has(t.id)) continue;
        void this.execute(t.id);
      }
    } finally { this.pumping = false; }
  }

  private ctxFor(task: Task, _wf: WorkflowDef, out: Record<number, StepOutput> = {}): StepCtx {
    return { db: this.d.db, money: this.d.money, research: this.d.research, task, now: new Date(), userPrompt: this.d.tasks.prompt(task.id), out };
  }

  /* ---------- execution ---------- */
  private async execute(id: string): Promise<void> {
    const wf0 = this.d.tasks.get(id);
    if (!wf0) return;
    const wf = WORKFLOWS[wf0.kind]!;
    const ac = new AbortController();
    this.live.set(id, ac);
    const ttl = setTimeout(() => ac.abort(new Error('ttl')), this.d.guard.get().maxJobMinutes * 60_000);
    let task = this.d.tasks.transition(id, 'running');
    this.ev(task, wf.leadAgent, 'started', `התחלתי: ${task.title}`, task.origin === 'scheduler' ? 'scheduler' : 'user');
    const out: Record<number, StepOutput> = {};
    const skipped: string[] = [];
    try {
      for (const [idx, stepDef] of wf.steps.entries()) {
        if (ac.signal.aborted) throw new Cancelled();
        task = this.d.tasks.get(id)!;
        const ctx = this.ctxFor(task, wf, out);
        this.d.tasks.setStep(id, idx, 'running');

        if (wf.kind === 'resolve-duplicates') {
          const n = resolveDuplicates(this.d.db, suspectedDuplicates(this.d.db).map((x) => x.txId), 'confirmed', task.approvalId ?? 'unknown');
          out[idx] = { summaryHe: `סומנו ${n} כפילויות מאומתות (נרשם ביומן הביקורת)`, data: { confirmed: n } };
          this.d.tasks.setStep(id, idx, 'completed');
          this.ev(task, stepDef.agentId, 'completed', out[idx]!.summaryHe, 'local-rules');
          continue;
        }

        if (stepDef.kind === 'local') {
          this.ev(task, stepDef.agentId, 'started', stepDef.titleHe, 'local-rules', { toolCategory: 'כללים מקומיים' });
          const res = stepDef.run!(ctx);
          if (res.waitingHe) {
            out[idx] = res;
            this.d.tasks.setStep(id, idx, 'pending');
            return this.waitFor(task, stepDef.agentId, res.waitingHe);
          }
          out[idx] = res;
          this.d.tasks.setStep(id, idx, 'completed');
          this.ev(task, stepDef.agentId, 'completed', res.summaryHe, 'local-rules', { toolCategory: 'כללים מקומיים' });
          continue;
        }

        /* AI step */
        const est = this.maxCost.get(id) ?? wf.maxCostUsd;
        let denial = this.d.guard.canStartAi(est, this.runningAi);
        for (let w = 0; !denial.ok && denial.code === 'concurrency' && w < 120 && !ac.signal.aborted; w++) { await sleep(500); denial = this.d.guard.canStartAi(est, this.runningAi); }
        if (!denial.ok) {
          if (denial.code === 'dry-run') {
            if (stepDef.optional) {
              this.d.tasks.setStep(id, idx, 'skipped'); skipped.push(stepDef.titleHe);
              this.ev(task, stepDef.agentId, 'skipped', `דולג: ${denial.messageHe}`, 'local-rules');
              continue;
            }
            this.d.tasks.setStep(id, idx, 'pending');
            return this.waitFor(task, stepDef.agentId, `${denial.messageHe} כבה את המצב היבש במסך "מערכת" כדי להריץ את המשימה.`);
          }
          this.d.tasks.setStep(id, idx, 'pending');
          this.ev(task, stepDef.agentId, 'blocked', denial.messageHe, 'local-rules');
          const unfinished = task.steps.filter((s) => s.idx >= idx).map((s) => s.title).join(', ');
          if (denial.code === 'kill-switch') { throw new Cancelled(); }
          this.d.tasks.transition(id, 'paused', { blocker: `${denial.messageHe} לא הושלמו: ${unfinished}` });
          this.ev(this.d.tasks.get(id)!, task.leadAgent, 'paused', `${denial.messageHe} המשימה הושהתה.`, 'local-rules');
          return this.finishBookkeeping(id);
        }

        const res = await this.runAiStep(task, idx, stepDef.agentId, stepDef.prompt!(ctx), est, ac.signal);
        if (!res.ok) {
          this.d.tasks.setStep(id, idx, 'failed');
          if (res.failure === 'cancelled') throw new Cancelled();
          return this.fail(task, stepDef.agentId, res.detail ?? 'כשל בריצת AI', res.failure);
        }
        out[idx] = stepDef.handleAi ? stepDef.handleAi(ctx, res.text) : { summaryHe: clip(res.text, 160), markdown: res.text };
        this.d.tasks.setStep(id, idx, 'completed');
        this.ev(task, stepDef.agentId, 'completed', out[idx]!.summaryHe, 'claude-cli', { modelId: res.observedModels[0], actualCostUsd: res.costUsd });
      }

      task = this.d.tasks.get(id)!;
      const fresh = this.d.tasks.get(id)!;
      const rep = wf.buildReport?.(this.ctxFor(fresh, wf, out)) ?? null;
      const report = rep ? this.d.reports.create({ kind: wf.reportKind, titleHe: fresh.title, taskId: id, isDemo: false, markdown: rep.markdown, data: rep.data }) : null;
      const summary = Object.values(out).map((o) => o.summaryHe).slice(-3).join(' · ') + (skipped.length ? ` · דולג: ${skipped.join(', ')}` : '');
      const done = this.d.tasks.transition(id, 'completed', { resultSummary: clip(summary, 400), ...(report ? { reportId: report.id } : {}) });
      this.ev(done, wf.leadAgent, 'completed', `הושלם: ${done.title}${report ? ' · דוח מוכן' : ''}`, 'local-rules');
      this.finishBookkeeping(id);
    } catch (e) {
      const cur = this.d.tasks.get(id);
      if (cur && cur.status === 'running') {
        if (e instanceof Cancelled || ac.signal.aborted) {
          const ttlHit = (ac.signal.reason as Error | undefined)?.message === 'ttl';
          if (ttlHit) this.fail(cur, cur.leadAgent, 'חרג מזמן הריצה המרבי', 'timeout');
          else { const c = this.d.tasks.transition(id, 'cancelled', { blocker: 'בוטל' }); this.ev(c, c.leadAgent, 'cancelled', 'המשימה בוטלה', 'user'); this.finishBookkeeping(id); }
        } else this.fail(cur, cur.leadAgent, 'שגיאה פנימית בהרצת המשימה', 'cli-error', e);
      }
    } finally {
      clearTimeout(ttl);
      this.live.delete(id);
      this.pump();
    }
  }

  private waitFor(task: Task, agent: AgentId, blocker: string): void {
    const t = this.d.tasks.transition(task.id, 'awaiting_input', { blocker });
    this.ev(t, agent, 'awaiting_input', blocker, 'local-rules');
    this.finishBookkeeping(task.id, 'waiting_for_connection');
  }

  private fail(task: Task, agent: AgentId, detail: string, code?: string, err?: unknown): void {
    const cause = err instanceof Error ? `: ${err.message}` : '';
    const t = this.d.tasks.transition(task.id, 'failed', { blocker: redact(detail + cause).slice(0, 300) });
    this.ev(t, agent, 'failed', `נכשל: ${detail}`, 'local-rules');
    this.finishBookkeeping(task.id);
    const wf = WORKFLOWS[t.kind]!;
    const g = this.d.guard.get();
    if (code && TRANSIENT.has(code) && !wf.needsApproval && t.attempts <= g.maxRetries && !this.stopped) {
      const delay = (this.d.retryBackoffMs ?? 30_000) * 2 ** (t.attempts - 1);
      this.ev(t, task.leadAgent, 'progress', `ניסיון חוזר אוטומטי בעוד ${Math.round(delay / 1000)} שניות`, 'local-rules');
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        const cur = this.d.tasks.get(t.id);
        if (cur?.status === 'failed' && !this.d.guard.get().killSwitch) { this.d.tasks.transition(t.id, 'queued', { blocker: null }); this.pump(); }
      }, delay);
      timer.unref(); this.timers.add(timer);
    }
  }

  private finishBookkeeping(taskId: string, forceStatus?: string): void {
    const t = this.d.tasks.get(taskId);
    if (!t?.automationId) return;
    const at = nowIso();
    const success = t.status === 'completed';
    this.d.db.prepare('UPDATE automations SET last_run_at = ?, last_status = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, last_verified_at = CASE WHEN ? THEN ? ELSE last_verified_at END WHERE id = ?')
      .run(at, forceStatus ?? t.status, success ? 1 : 0, at, success ? 1 : 0, at, t.automationId);
  }

  private async runAiStep(task: Task, idx: number, agent: AgentId, prompt: string, estUsd: number, signal: AbortSignal) {
    this.runningAi++;
    let activity = false;
    const hb = setInterval(() => { if (activity) { activity = false; this.ev(task, agent, 'heartbeat', 'העבודה נמשכת — התקבלה פעילות מהמודל', 'claude-cli'); } }, 30_000);
    hb.unref();
    let announcedModel = false;
    try {
      this.ev(task, agent, 'started', this.d.tasks.get(task.id)!.steps[idx]!.title, 'claude-cli', { estimatedCostUsd: estUsd });
      const res = await this.d.runner.run({
        agentId: agent, prompt, maxBudgetUsd: Math.min(estUsd, this.d.guard.headroomUsd()), timeoutMs: this.d.guard.get().maxJobMinutes * 60_000,
        onActivity: () => { activity = true; },
        onModel: (m) => { if (!announcedModel) { announcedModel = true; this.ev(task, agent, 'progress', `המודל שרץ: ${m}`, 'claude-cli', { modelId: m }); } },
        onTool: (n: ToolNote) => {
          const label = TOOL_LABEL[n.toolName] ?? 'כלי קריאה בלבד';
          if (n.phase === 'started') this.ev(task, agent, 'tool_started', n.host ? `${label}: ${n.host}` : `${label}…`, 'claude-cli', { toolCategory: label });
          else this.ev(task, agent, 'tool_completed', n.failed ? `${label} נכשל` : `${label} הושלם`, 'claude-cli', { toolCategory: label });
        },
      }, signal);
      if (res.costUsd > 0) {
        this.d.guard.recordSpend(task.id, res.costUsd, res.observedModels.join(',') || null, false);
        this.d.db.prepare('UPDATE tasks SET actual_cost_usd = actual_cost_usd + ? WHERE id = ?').run(res.costUsd, task.id);
      }
      if (res.ok && !res.observedModels.every((m) => m === REQUIRED_MODEL || m.startsWith(`${REQUIRED_MODEL}[`))) {
        return { ...res, ok: false, failure: 'model-mismatch' as const, detail: 'המודל שרץ אינו claude-sonnet-5-5' };
      }
      return res;
    } finally { clearInterval(hb); this.runningAi--; }
  }

  /* ---------- user controls ---------- */
  cancel(id: string): Task {
    const t = this.d.tasks.get(id); if (!t) throw new Error('task not found');
    const ac = this.live.get(id);
    if (ac && t.status === 'running') { ac.abort(new Error('cancel')); return this.d.tasks.get(id)!; }
    const c = this.d.tasks.transition(id, 'cancelled', { blocker: 'בוטל על ידי המשתמש' });
    this.ev(c, c.leadAgent, 'cancelled', 'המשימה בוטלה', 'user'); this.finishBookkeeping(id);
    return c;
  }
  pause(id: string): Task {
    const t = this.d.tasks.get(id); if (!t) throw new Error('task not found');
    const ac = this.live.get(id);
    if (ac && t.status === 'running') { this.d.tasks.transition(id, 'paused', { blocker: 'הושהה על ידי המשתמש' }); ac.abort(new Error('pause')); }
    else this.d.tasks.transition(id, 'paused', { blocker: 'הושהה על ידי המשתמש' });
    const p = this.d.tasks.get(id)!; this.ev(p, p.leadAgent, 'paused', 'המשימה הושהתה', 'user');
    return p;
  }
  resume(id: string): Task {
    const t = this.d.tasks.transition(id, 'queued', { blocker: null });
    this.ev(t, t.leadAgent, 'queued', 'חודשה — חזרה לתור', 'user'); this.pump(); return t;
  }
  /** Bounded manual retry: only failed tasks, only while attempts <= maxRetries. */
  retry(id: string): Task {
    const t = this.d.tasks.get(id); if (!t) throw new Error('task not found');
    const wf = WORKFLOWS[t.kind]!;
    if (wf.needsApproval) throw new Error('משימות עם כתיבה מבוקרת לא מנסות שוב אוטומטית — צור משימה חדשה');
    if (t.status !== 'awaiting_input') {
      if (t.status !== 'failed') throw new Error('אפשר לנסות שוב רק משימה שנכשלה או שממתינה לקלט');
      if (t.attempts > this.d.guard.get().maxRetries) throw new Error('חרגת ממספר הניסיונות החוזרים המותר');
    }
    const q = this.d.tasks.transition(id, 'queued', { blocker: null });
    this.ev(q, q.leadAgent, 'queued', 'ניסיון חוזר ידני', 'user'); this.pump(); return q;
  }

  /** Kill switch: blocks new AI work and aborts everything running. */
  setKillSwitch(on: boolean, actor = 'user'): void {
    this.d.guard.update({ killSwitch: on }, actor);
    if (on) for (const [id, ac] of this.live) { void id; ac.abort(new Error('kill')); }
    else this.pump();
  }

  /** On boot, anything left "running" crashed mid-flight; never silently re-execute it. */
  recoverOnBoot(): number {
    const stuck = this.d.tasks.list({ demo: false, status: 'running', limit: 100 });
    for (const t of stuck) {
      const f = this.d.tasks.transition(t.id, 'failed', { blocker: 'השרת הופסק באמצע הריצה. לא בוצעה הרצה מחדש אוטומטית.' });
      this.ev(f, f.leadAgent, 'failed', 'נכשל: השרת הופסק באמצע הריצה', 'local-rules');
      this.finishBookkeeping(t.id);
    }
    this.pump();
    return stuck.length;
  }

  stop(): void { this.stopped = true; for (const t of this.timers) clearTimeout(t); for (const ac of this.live.values()) ac.abort(new Error('shutdown')); }
}

class Cancelled extends Error {}
