import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { AGENT_IDS, type AgentId, type EventOrigin, type EventType, type PublicEvent } from '../../shared/contract.ts';
import type { Db } from './db.ts';
import { clip, redact, redactUrl } from './redact.ts';
import { newId, nowIso } from './util.ts';

const TYPES = ['queued', 'started', 'tool_started', 'tool_completed', 'progress', 'awaiting_input', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'paused', 'heartbeat', 'skipped', 'blocked'] as const;
const ORIGINS = ['claude-hook', 'agent-sdk', 'claude-cli', 'scheduler', 'local-rules', 'user', 'demo'] as const;

export const EventInputSchema = z.object({
  runId: z.string().min(1),
  agentId: z.enum(AGENT_IDS),
  type: z.enum(TYPES),
  publicSummary: z.string().min(1),
  origin: z.enum(ORIGINS),
  isDemo: z.boolean(),
  toolCategory: z.string().max(60).optional(),
  modelId: z.string().optional(),
  sourceUrl: z.string().optional(),
  lastVerifiedAt: z.string().optional(),
  estimatedCostUsd: z.number().min(0).optional(),
  actualCostUsd: z.number().min(0).optional(),
  occurredAt: z.string().optional(),
});
export type EventInput = z.input<typeof EventInputSchema>;

interface Row {
  seq: number; event_id: string; run_id: string; agent_id: string; type: string; occurred_at: string;
  public_summary: string; origin: string; is_demo: number; tool_category: string | null; model_id: string | null;
  source_url: string | null; last_verified_at: string | null; estimated_cost_usd: number | null; actual_cost_usd: number | null;
}

function toEvent(r: Row): PublicEvent {
  const e: PublicEvent = {
    seq: r.seq, eventId: r.event_id, runId: r.run_id, agentId: r.agent_id as AgentId, type: r.type as EventType,
    occurredAt: r.occurred_at, publicSummary: r.public_summary, origin: r.origin as EventOrigin, isDemo: !!r.is_demo,
  };
  if (r.tool_category) e.toolCategory = r.tool_category;
  if (r.model_id) e.modelId = r.model_id;
  if (r.source_url) e.sourceUrl = r.source_url;
  if (r.last_verified_at) e.lastVerifiedAt = r.last_verified_at;
  if (r.estimated_cost_usd != null) e.estimatedCostUsd = r.estimated_cost_usd;
  if (r.actual_cost_usd != null) e.actualCostUsd = r.actual_cost_usd;
  return e;
}

/** Append-only event store + in-process fan-out. The DB (with immutability triggers) is the source of truth. */
export class EventBus extends EventEmitter {
  constructor(private db: Db) { super(); this.setMaxListeners(100); }

  emitEvent(input: EventInput): PublicEvent {
    const v = EventInputSchema.parse(input);
    if (v.origin === 'demo' && !v.isDemo) throw new Error('demo origin must be flagged isDemo');
    if (v.isDemo && v.origin !== 'demo') throw new Error('isDemo events must have demo origin');
    const occurredAt = v.occurredAt ?? nowIso();
    const sourceUrl = v.sourceUrl ? redactUrl(v.sourceUrl) : undefined;
    const res = this.db.prepare(
      `INSERT INTO events (event_id, run_id, agent_id, type, occurred_at, public_summary, origin, is_demo, tool_category, model_id, source_url, last_verified_at, estimated_cost_usd, actual_cost_usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      newId('evt'), v.runId, v.agentId, v.type, occurredAt, clip(redact(v.publicSummary)), v.origin, v.isDemo ? 1 : 0,
      v.toolCategory ? clip(redact(v.toolCategory), 60) : null, v.modelId ?? null, sourceUrl ?? null, v.lastVerifiedAt ?? null,
      v.estimatedCostUsd ?? null, v.actualCostUsd ?? null,
    );
    const row = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(Number(res.lastInsertRowid)) as unknown as Row;
    const ev = toEvent(row);
    this.emit('event', ev);
    return ev;
  }

  list(opts: { after?: number; limit?: number; demo?: boolean; agentId?: AgentId; runId?: string } = {}): PublicEvent[] {
    const where: string[] = ['seq > ?'];
    const args: Array<string | number> = [opts.after ?? 0];
    if (opts.demo !== undefined) { where.push('is_demo = ?'); args.push(opts.demo ? 1 : 0); }
    if (opts.agentId) { where.push('agent_id = ?'); args.push(opts.agentId); }
    if (opts.runId) { where.push('run_id = ?'); args.push(opts.runId); }
    args.push(Math.min(opts.limit ?? 200, 1000));
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`).all(...args) as unknown as Row[];
    return rows.map(toEvent);
  }

  /** newest first */
  recentForAgent(agentId: AgentId, demo: boolean, n: number): PublicEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE agent_id = ? AND is_demo = ? ORDER BY seq DESC LIMIT ?').all(agentId, demo ? 1 : 0, n) as unknown as Row[];
    return rows.map(toEvent);
  }

  lastSeq(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events').get() as { s: number };
    return r.s;
  }
}
