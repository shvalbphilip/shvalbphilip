import { REQUIRED_MODEL, type AgentLiveStatus, type AgentState, type ModelVerification, type PublicEvent, type StateSnapshot } from '../../shared/contract.ts';
import { AGENTS } from './agents.ts';
import type { Db } from './db.ts';
import { getSetting } from './db.ts';
import type { EventBus } from './events.ts';
import type { Guard } from './guard.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { TaskStore } from './tasks.ts';
import type { Demo } from './demo.ts';

const WORKING = new Set(['started', 'tool_started', 'tool_completed', 'progress', 'heartbeat']);
export const STALE_AFTER_MS = 150_000;
const BUBBLE_FRESH_MS = 90_000;

export function deriveAgentStatus(last: PublicEvent | undefined, taskStatus: string | undefined, now: number): AgentLiveStatus {
  if (!last) return 'idle';
  if (WORKING.has(last.type)) {
    if (taskStatus !== 'running') return 'idle'; // task died/finished elsewhere: never show phantom work
    return now - Date.parse(last.occurredAt) > STALE_AFTER_MS ? 'stale' : 'working';
  }
  if (last.type === 'awaiting_approval' && taskStatus === 'awaiting_approval') return 'awaiting_approval';
  if (last.type === 'awaiting_input' && taskStatus === 'awaiting_input') return 'awaiting_input';
  if (last.type === 'blocked' && (taskStatus === 'paused' || taskStatus === 'running')) return 'blocked';
  if (last.type === 'failed' && taskStatus === 'failed') return 'failed';
  return 'idle';
}

export class StateBuilder {
  constructor(private db: Db, private bus: EventBus, private tasks: TaskStore, private guard: Guard, private orch: Orchestrator, private demo: Demo, private authRequired = false) {}

  modelVerification(): ModelVerification {
    return getSetting<ModelVerification>(this.db, 'modelVerification', { required: REQUIRED_MODEL, status: 'unverified', checkedAt: null, observedModels: [], cliVersion: null, detail: 'עדיין לא אומת. המודל יאומת בריצה האמיתית הראשונה.' });
  }

  agents(demoMode: boolean, now = Date.now()): AgentState[] {
    return AGENTS.map((m) => {
      const recent = this.bus.recentForAgent(m.id, demoMode, 20);
      const last = recent[0];
      const task = last ? this.tasks.get(last.runId) : undefined;
      const status = deriveAgentStatus(last, task?.status, now);
      const fresh = last ? now - Date.parse(last.occurredAt) < BUBBLE_FRESH_MS : false;
      const bubble = last && (status !== 'idle' || fresh) ? last.publicSummary : null;
      const hist = this.db.prepare(
        `SELECT DISTINCT t.id FROM tasks t JOIN task_steps s ON s.task_id = t.id WHERE s.agent_id = ? AND t.is_demo = ? ORDER BY t.created_at DESC LIMIT 10`,
      ).all(m.id, demoMode ? 1 : 0) as Array<{ id: string }>;
      const startedEv = status === 'working' || status === 'stale' ? recent.find((e) => e.type === 'started') : undefined;
      return {
        id: m.id, name: m.name, roleHe: m.roleHe, missionHe: m.missionHe, model: REQUIRED_MODEL, status, bubble,
        currentTaskId: status === 'idle' ? null : task?.id ?? null, currentTaskTitle: status === 'idle' ? null : task?.title ?? null,
        startedAt: startedEv?.occurredAt ?? null, lastEventAt: last?.occurredAt ?? null, lastEvents: recent.slice(0, 5),
        history: hist.map((h) => this.tasks.get(h.id)!).filter(Boolean).map((t) => ({ id: t.id, title: t.title, status: t.status, finishedAt: t.finishedAt, actualCostUsd: t.actualCostUsd })),
        toolCategory: status === 'working' || status === 'stale' ? last?.toolCategory ?? null : null,
        verifiedSources: [...new Set(recent.map((e) => e.sourceUrl).filter((u): u is string => !!u))].slice(0, 5),
        blocker: task && ['awaiting_input', 'paused', 'failed'].includes(task.status) ? task.blocker ?? null : null,
      };
    });
  }

  snapshot(demoMode: boolean): StateSnapshot {
    const now = new Date();
    return {
      now: now.toISOString(), timezone: 'Asia/Jerusalem', mode: demoMode ? 'demo' : 'real', demoRunning: this.demo.running,
      guardrails: this.guard.get(), spend: this.guard.summary(now), model: this.modelVerification(), agents: this.agents(demoMode, now.getTime()),
      runningAiJobs: this.orch.runningAiJobs, pendingApprovals: this.orch.pendingApprovals(), lastEventSeq: this.bus.lastSeq(),
      storageNote: 'כל הנתונים נשמרים מקומית בלבד (SQLite). לא נשלחים ל-GitHub.',
      authRequired: this.authRequired,
    };
  }
}
