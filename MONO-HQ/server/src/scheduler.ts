import type { Automation, TaskStatus } from '../../shared/contract.ts';
import type { Db } from './db.ts';
import type { Guard } from './guard.ts';
import type { MoneyStore } from './money.ts';
import type { EventBus } from './events.ts';
import type { Orchestrator } from './orchestrator.ts';
import { AUTOMATIONS, TZ, nextRun, type AutomationDef } from './automations.ts';
import { newId, nowIso } from './util.ts';

interface Row { id: string; enabled: number; time_confirmed: number; last_run_at: string | null; last_success_at: string | null; last_status: string | null; last_verified_at: string | null; enabled_at: string | null }

/**
 * Durable cron-style scheduler. It only *creates bounded tasks*; the orchestrator decides whether AI may run.
 * The tick itself is a cheap clock comparison — it never calls a model.
 * Missed runs (machine asleep, server down) beyond the grace window are recorded as missed, never back-filled.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private db: Db, private guard: Guard, private orch: Orchestrator, private money: MoneyStore, private bus: EventBus, private tickMs = 30_000) {
    for (const a of AUTOMATIONS) this.db.prepare('INSERT OR IGNORE INTO automations (id, enabled, time_confirmed) VALUES (?,0,?)').run(a.id, a.timeConfirmed ? 1 : 0);
  }

  start(): void { if (!this.timer) { this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private row(id: string): Row { return this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as unknown as Row; }

  private anchor(r: Row): Date { return new Date(r.last_run_at ?? r.enabled_at ?? nowIso()); }

  /** Evaluate all enabled cron automations at `now`. Exposed for deterministic tests. */
  tick(now = new Date()): string[] {
    const created: string[] = [];
    if (this.guard.get().killSwitch) return created;
    for (const def of AUTOMATIONS) {
      if (def.trigger !== 'cron' || !def.cron) continue;
      const r = this.row(def.id);
      if (!r.enabled) continue;
      const due = nextRun(def.cron, this.anchor(r));
      if (!due || due.getTime() > now.getTime()) continue;
      const lateMin = (now.getTime() - due.getTime()) / 60_000;
      if (lateMin > def.graceMinutes) {
        this.db.prepare('UPDATE automations SET last_run_at = ?, last_status = ? WHERE id = ?').run(now.toISOString(), 'cancelled', def.id);
        this.guard.audit('scheduler', 'automation.missed', `${def.id} scheduled ${due.toISOString()} missed by ${Math.round(lateMin)}m (not back-filled)`);
        continue;
      }
      const t = this.orch.enqueue({ workflow: def.workflow, origin: 'scheduler', automationId: def.id, dedupKey: `${def.id}:${due.toISOString()}`, maxCostUsd: def.maxModelCostUsd, title: def.nameHe });
      this.db.prepare('UPDATE automations SET last_run_at = ? WHERE id = ?').run(now.toISOString(), def.id);
      created.push(t.id);
    }
    return created;
  }

  /** Event trigger: called after a CSV import. Cheap local rules only. */
  onImport(batchId: string): void {
    const def = AUTOMATIONS.find((a) => a.id === 'risk-watch')!;
    if (!this.row(def.id).enabled || this.guard.get().killSwitch) return;
    this.orch.enqueue({ workflow: def.workflow, origin: 'scheduler', automationId: def.id, dedupKey: `risk-watch:${batchId}`, title: def.nameHe });
  }

  setEnabled(id: string, enabled: boolean, confirm: boolean, actor = 'user'): void {
    const def = AUTOMATIONS.find((a) => a.id === id);
    if (!def) throw new Error('automation not found');
    if (enabled && !confirm) throw new Error('הפעלת אוטומציה דורשת אישור מפורש (confirm)');
    const at = nowIso();
    this.db.prepare('UPDATE automations SET enabled = ?, time_confirmed = CASE WHEN ? THEN 1 ELSE time_confirmed END, enabled_at = CASE WHEN ? THEN ? ELSE enabled_at END, last_run_at = CASE WHEN ? THEN NULL ELSE last_run_at END WHERE id = ?')
      .run(enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 1 : 0, at, enabled ? 1 : 0, id);
    if (enabled) {
      this.db.prepare("INSERT INTO approvals (id, task_id, automation_id, action, title_he, detail_he, estimated_cost_usd, status, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(newId('apr'), null, id, 'enable-automation', `הפעלת ${def.nameHe}`, `${def.scheduleHe} · תקרת עלות למשימה ${def.maxModelCostUsd}$`, def.maxModelCostUsd, 'approved', at, at);
    }
    this.guard.audit(actor, enabled ? 'automation.enable' : 'automation.disable', id);
  }

  runNow(id: string): string {
    const def = AUTOMATIONS.find((a) => a.id === id);
    if (!def) throw new Error('automation not found');
    return this.orch.enqueue({ workflow: def.workflow, origin: 'user', automationId: def.id, title: `${def.nameHe} (הרצה ידנית)`, maxCostUsd: def.maxModelCostUsd }).id;
  }

  list(now = new Date()): Automation[] {
    const dataMissing = this.money.count() === 0;
    return AUTOMATIONS.map((def) => this.map(def, this.row(def.id), dataMissing, now));
  }

  private map(def: AutomationDef, r: Row, dataMissing: boolean, _now: Date): Automation {
    const needsMoney = def.requiredSources.some((s) => s.includes('עסקאות'));
    const next = r.enabled && def.cron ? nextRun(def.cron, this.anchor(r))?.toISOString() ?? null : null;
    return {
      id: def.id, nameHe: def.nameHe, descriptionHe: def.descriptionHe, schedule: def.scheduleHe, cron: def.cron, trigger: def.trigger,
      enabled: !!r.enabled, timeStatus: r.time_confirmed ? 'confirmed' : 'draft-awaiting-confirmation',
      nextRunAt: next, lastRunAt: r.last_run_at, lastSuccessAt: r.last_success_at,
      lastStatus: (r.last_status as TaskStatus | 'waiting_for_connection' | null) ?? (r.enabled && needsMoney && dataMissing ? 'waiting_for_connection' : null),
      requiresAi: def.requiresAi, requiredSources: def.requiredSources, maxDurationMinutes: def.maxDurationMinutes, maxAttempts: def.maxAttempts,
      maxModelCostUsd: def.maxModelCostUsd, approvalPolicy: def.approvalPolicy, lastVerifiedAt: r.last_verified_at,
      waitingFor: needsMoney && dataMissing ? 'ממתין לייבוא עסקאות (CSV) — עדיין לא חובר מקור נתונים' : null,
    };
  }
}
export { TZ };
