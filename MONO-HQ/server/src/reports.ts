import type { Report } from '../../shared/contract.ts';
import type { Db } from './db.ts';
import { newId, nowIso } from './util.ts';

export class ReportStore {
  constructor(private db: Db) {}
  create(r: { kind: Report['kind']; titleHe: string; taskId: string | null; isDemo: boolean; markdown: string; data: unknown }): Report {
    const id = newId('rep'); const createdAt = nowIso();
    this.db.prepare('INSERT INTO reports (id, kind, title_he, created_at, task_id, is_demo, markdown, data) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, r.kind, r.titleHe, createdAt, r.taskId, r.isDemo ? 1 : 0, r.markdown, JSON.stringify(r.data));
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
