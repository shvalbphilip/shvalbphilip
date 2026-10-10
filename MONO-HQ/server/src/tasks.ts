import type { AgentId, Task, TaskStatus, TaskStep } from '../../shared/contract.ts';
import type { Db } from './db.ts';
import { newId, nowIso } from './util.ts';

/** Allowed state transitions. Terminal states have no outgoing edges except failed->queued (bounded retry). */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['running', 'awaiting_approval', 'cancelled', 'paused', 'failed'],
  running: ['awaiting_input', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'paused'],
  awaiting_input: ['queued', 'running', 'cancelled', 'failed'],
  awaiting_approval: ['queued', 'running', 'cancelled', 'failed'],
  paused: ['queued', 'running', 'cancelled'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean { return TRANSITIONS[from].includes(to); }

interface TaskRow {
  id: string; title: string; kind: string; status: string; lead_agent: string; is_demo: number; dry_run: number; origin: string;
  automation_id: string | null; prompt: string | null; created_at: string; started_at: string | null; finished_at: string | null;
  attempts: number; estimated_cost_usd: number; actual_cost_usd: number; result_summary: string | null; blocker: string | null;
  approval_id: string | null; report_id: string | null;
}
interface StepRow { idx: number; agent_id: string; kind: string; title: string; status: string }

export interface NewTask {
  title: string; kind: string; leadAgent: AgentId; isDemo: boolean; dryRun: boolean; origin: Task['origin'];
  automationId?: string; prompt?: string; dedupKey?: string; estimatedCostUsd?: number;
  steps: Array<{ agentId: AgentId; kind: 'local' | 'ai'; title: string }>;
}

export class TaskStore {
  constructor(private db: Db) {}

  /** Idempotent: a repeated dedupKey returns the existing task with created=false. */
  create(n: NewTask): { task: Task; created: boolean } {
    if (n.dedupKey) {
      const ex = this.db.prepare('SELECT id FROM tasks WHERE dedup_key = ?').get(n.dedupKey) as { id: string } | undefined;
      if (ex) return { task: this.get(ex.id)!, created: false };
    }
    const id = newId('task');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        `INSERT INTO tasks (id, title, kind, status, lead_agent, is_demo, dry_run, origin, automation_id, prompt, dedup_key, created_at, estimated_cost_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, n.title, n.kind, 'queued', n.leadAgent, n.isDemo ? 1 : 0, n.dryRun ? 1 : 0, n.origin, n.automationId ?? null, n.prompt ?? null, n.dedupKey ?? null, nowIso(), n.estimatedCostUsd ?? 0);
      n.steps.forEach((s, i) => this.db.prepare('INSERT INTO task_steps (task_id, idx, agent_id, kind, title, status) VALUES (?,?,?,?,?,?)').run(id, i, s.agentId, s.kind, s.title, 'pending'));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { task: this.get(id)!, created: true };
  }

  get(id: string): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
    return r ? this.hydrate(r) : undefined;
  }

  list(opts: { demo?: boolean; status?: TaskStatus; limit?: number } = {}): Task[] {
    const where: string[] = []; const args: Array<string | number> = [];
    if (opts.demo !== undefined) { where.push('is_demo = ?'); args.push(opts.demo ? 1 : 0); }
    if (opts.status) { where.push('status = ?'); args.push(opts.status); }
    args.push(opts.limit ?? 100);
    const rows = this.db.prepare(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args) as unknown as TaskRow[];
    return rows.map((r) => this.hydrate(r));
  }

  transition(id: string, to: TaskStatus, patch: Partial<{ blocker: string | null; resultSummary: string; approvalId: string | null; reportId: string; actualCostUsd: number }> = {}): Task {
    const t = this.get(id);
    if (!t) throw new Error(`task ${id} not found`);
    if (!canTransition(t.status, to)) throw new Error(`illegal transition ${t.status} -> ${to}`);
    const sets: string[] = ['status = ?']; const args: Array<string | number | null> = [to];
    if (to === 'running' && !t.startedAt) { sets.push('started_at = ?'); args.push(nowIso()); }
    if (to === 'running') { sets.push('attempts = attempts + 1'); }
    if (to === 'completed' || to === 'failed' || to === 'cancelled') { sets.push('finished_at = ?'); args.push(nowIso()); }
    if (to === 'queued' && t.status === 'failed') { sets.push('finished_at = NULL'); }
    if (patch.blocker !== undefined) { sets.push('blocker = ?'); args.push(patch.blocker); }
    if (patch.resultSummary !== undefined) { sets.push('result_summary = ?'); args.push(patch.resultSummary); }
    if (patch.approvalId !== undefined) { sets.push('approval_id = ?'); args.push(patch.approvalId); }
    if (patch.reportId !== undefined) { sets.push('report_id = ?'); args.push(patch.reportId); }
    if (patch.actualCostUsd !== undefined) { sets.push('actual_cost_usd = actual_cost_usd + ?'); args.push(patch.actualCostUsd); }
    args.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return this.get(id)!;
  }

  setStep(taskId: string, idx: number, status: TaskStep['status']): void {
    this.db.prepare('UPDATE task_steps SET status = ? WHERE task_id = ? AND idx = ?').run(status, taskId, idx);
  }

  setEstimate(id: string, usd: number): void { this.db.prepare('UPDATE tasks SET estimated_cost_usd = ? WHERE id = ?').run(usd, id); }

  private hydrate(r: TaskRow): Task {
    const steps = (this.db.prepare('SELECT idx, agent_id, kind, title, status FROM task_steps WHERE task_id = ? ORDER BY idx').all(r.id) as unknown as StepRow[])
      .map((s) => ({ idx: s.idx, agentId: s.agent_id as AgentId, kind: s.kind as 'local' | 'ai', title: s.title, status: s.status as TaskStep['status'] }));
    const t: Task = {
      id: r.id, title: r.title, kind: r.kind, status: r.status as TaskStatus, leadAgent: r.lead_agent as AgentId, isDemo: !!r.is_demo,
      dryRun: !!r.dry_run, origin: r.origin as Task['origin'], createdAt: r.created_at, attempts: r.attempts,
      estimatedCostUsd: r.estimated_cost_usd, actualCostUsd: r.actual_cost_usd, steps,
    };
    if (r.automation_id) t.automationId = r.automation_id;
    if (r.started_at) t.startedAt = r.started_at;
    if (r.finished_at) t.finishedAt = r.finished_at;
    if (r.result_summary) t.resultSummary = r.result_summary;
    if (r.blocker) t.blocker = r.blocker;
    if (r.approval_id) t.approvalId = r.approval_id;
    if (r.report_id) t.reportId = r.report_id;
    return t;
  }

  prompt(id: string): string | null {
    const r = this.db.prepare('SELECT prompt FROM tasks WHERE id = ?').get(id) as { prompt: string | null } | undefined;
    return r?.prompt ?? null;
  }
}
