import type { Report } from '../../shared/contract.ts';
import type { Db } from './db.ts';
import { redact } from './redact.ts';
import { newId, nowIso } from './util.ts';

/** Applies redact() to every string inside a JSON-like value; numbers, booleans and keys are left intact. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}

export class ReportStore {
  constructor(private db: Db) {}
  /** Title, markdown and every string in `data` are redacted before storage: a report is a long-lived artifact. */
  create(r: { kind: Report['kind']; titleHe: string; taskId: string | null; isDemo: boolean; markdown: string; data: unknown }): Report {
    const id = newId('rep'); const createdAt = nowIso();
    this.db.prepare('INSERT INTO reports (id, kind, title_he, created_at, task_id, is_demo, markdown, data) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, r.kind, redact(r.titleHe), createdAt, r.taskId, r.isDemo ? 1 : 0, redact(r.markdown), JSON.stringify(redactDeep(r.data) ?? null));
    return this.get(id)!;
  }
  get(id: string): Report | undefined {
    const r = this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    return r ? this.map(r) : undefined;
  }
  list(demo: boolean, limit = 50): Report[] {
    return (this.db.prepare('SELECT * FROM reports WHERE is_demo = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(demo ? 1 : 0, limit) as Array<Record<string, string | number | null>>).map((r) => this.map(r));
  }
  private map(r: Record<string, string | number | null>): Report {
    return { id: r.id as string, kind: r.kind as Report['kind'], titleHe: r.title_he as string, createdAt: r.created_at as string, taskId: (r.task_id as string) ?? null, isDemo: !!r.is_demo, markdown: r.markdown as string, data: JSON.parse(r.data as string) };
  }
}
