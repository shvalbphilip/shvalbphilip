import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResearchItem } from '../../shared/contract.ts';
import type { Db } from './db.ts';
import { clip, redact } from './redact.ts';
import { newId, nowIso } from './util.ts';

const OFFICIAL_SUFFIXES = ['gov.il', 'boi.org.il'];
export function isOfficialSource(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return OFFICIAL_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith('.' + s));
  } catch { return false; }
}

const ItemSchema = z.object({
    titleHe: z.string().min(3).max(200),
    summaryHe: z.string().min(3).max(800),
    sourceUrl: z.string().url(),
    sourceName: z.string().min(2).max(120),
    publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullable().optional(),
    impactHe: z.string().max(400).default(''),
    uncertaintyHe: z.string().max(400).default(''),
});
export const ResearchOutputSchema = z.object({ items: z.array(z.unknown()).max(12) });

/** Extract the first top-level JSON object from model text (models sometimes wrap it in prose/fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

export class ResearchStore {
  constructor(private db: Db) {}

  /** Validates (GUARDIAN-style, deterministic) and stores items. Returns counts incl. rejects. */
  ingest(taskId: string, modelText: string): { stored: number; rejected: number; official: number } {
    const parsed = ResearchOutputSchema.safeParse(extractJson(modelText));
    if (!parsed.success) return { stored: 0, rejected: -1, official: 0 };
    let stored = 0, rejected = 0, official = 0;
    const checkedAt = nowIso();
    for (const raw of parsed.data.items) {
      const v = ItemSchema.safeParse(raw);
      if (!v.success) { rejected++; continue; }
      const it = v.data;
      const url = new URL(it.sourceUrl); url.hash = ''; url.username = ''; url.password = '';
      const off = isOfficialSource(url.toString());
      if (url.protocol !== 'https:') { rejected++; continue; }
      const hash = createHash('sha256').update(`${url}|${it.summaryHe.toLowerCase().replace(/\s+/g, ' ')}`).digest('hex');
      const prev = this.db.prepare('SELECT content_hash FROM research_items WHERE source_url = ? ORDER BY checked_at DESC LIMIT 1').get(url.toString()) as { content_hash: string } | undefined;
      const change = !prev ? 'new' : prev.content_hash === hash ? 'unchanged' : 'changed';
      this.db.prepare(`INSERT INTO research_items (id, task_id, title_he, summary_he, source_url, source_name, reliability, published_at, checked_at, change_since, impact_he, uncertainty_he, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(newId('rs'), taskId, clip(redact(it.titleHe), 200), clip(redact(it.summaryHe), 800), url.toString(), clip(it.sourceName, 120), off ? 'official' : 'unverified', it.publishedAt ?? null, checkedAt, change, clip(redact(it.impactHe), 400), clip(redact(it.uncertaintyHe || 'לא צוין'), 400), hash);
      stored++; if (off) official++;
    }
    return { stored, rejected, official };
  }

  list(limit = 100): ResearchItem[] {
    const rows = this.db.prepare('SELECT * FROM research_items ORDER BY checked_at DESC, rowid DESC LIMIT ?').all(limit) as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      id: r.id!, titleHe: r.title_he!, summaryHe: r.summary_he!, sourceUrl: r.source_url!, sourceName: r.source_name!,
      reliability: r.reliability as 'official' | 'unverified', publishedAt: r.published_at ?? null, checkedAt: r.checked_at!,
      changeSinceLastCheck: r.change_since as 'new' | 'changed' | 'unchanged', impactHe: r.impact_he!, uncertaintyHe: r.uncertainty_he!, taskId: r.task_id!,
    }));
  }
}
