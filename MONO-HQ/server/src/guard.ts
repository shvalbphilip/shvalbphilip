import type { Guardrails, SpendSummary } from '../../shared/contract.ts';
import { appendAudit } from './audit.ts';
import { getSetting, setSetting, type Db } from './db.ts';
import { jerusalemParts, newId, nowIso } from './util.ts';

export type Denial =
  | { ok: true }
  | { ok: false; code: 'kill-switch' | 'dry-run' | 'daily-limit' | 'monthly-limit' | 'concurrency'; messageHe: string };

const pad = (n: number) => String(n).padStart(2, '0');
export function jerusalemDay(d = new Date()): string { const p = jerusalemParts(d); return `${p.y}-${pad(p.m)}-${pad(p.day)}`; }
export function jerusalemMonth(d = new Date()): string { return jerusalemDay(d).slice(0, 7); }

export class Guard {
  private cached: Guardrails;
  /** Budget held by AI runs in flight (key -> USD), so concurrent runs cannot jointly exceed the caps. */
  private reserved = new Map<string, number>();
  constructor(private db: Db, private defaults: Guardrails) {
    this.cached = { ...defaults, ...getSetting<Partial<Guardrails>>(db, 'guardrails', {}) };
  }

  get(): Guardrails { return { ...this.cached }; }

  update(patch: Partial<Guardrails>, actor: string): Guardrails {
    const next: Guardrails = { ...this.cached };
    const numeric = ['maxConcurrentAiJobs', 'maxDailyCostUsd', 'maxMonthlyCostUsd', 'maxJobMinutes', 'maxRetries', 'softLimitRatio'] as const;
    for (const k of numeric) {
      if (patch[k] !== undefined) {
        const n = Number(patch[k]);
        if (!Number.isFinite(n) || n < 0) throw new Error(`invalid ${k}`);
        next[k] = n;
      }
    }
    if (next.maxConcurrentAiJobs > 8) throw new Error('maxConcurrentAiJobs capped at 8');
    if (next.softLimitRatio > 1) throw new Error('softLimitRatio must be <= 1');
    if (patch.dryRun !== undefined) next.dryRun = !!patch.dryRun;
    if (patch.killSwitch !== undefined) next.killSwitch = !!patch.killSwitch;
    this.cached = next;
    setSetting(this.db, 'guardrails', next);
    this.audit(actor, 'guardrails.update', JSON.stringify(patch));
    return this.get();
  }

  /** Hash-chained, append-only (see audit.ts). */
  audit(actor: string, action: string, detail: string): void { appendAudit(this.db, actor, action, detail); }

  spendTotals(now = new Date()): { dayUsd: number; monthUsd: number } {
    const day = jerusalemDay(now);
    const month = jerusalemMonth(now);
    const rows = this.db.prepare('SELECT at, usd FROM spend WHERE is_demo = 0').all() as Array<{ at: string; usd: number }>;
    let dayUsd = 0, monthUsd = 0;
    for (const r of rows) {
      const d = jerusalemDay(new Date(r.at));
      if (d.slice(0, 7) === month) monthUsd += r.usd;
      if (d === day) dayUsd += r.usd;
    }
    return { dayUsd: round(dayUsd), monthUsd: round(monthUsd) };
  }

  summary(now = new Date()): SpendSummary {
    const g = this.cached;
    const t = this.spendTotals(now);
    return {
      ...t, dayLimitUsd: g.maxDailyCostUsd, monthLimitUsd: g.maxMonthlyCostUsd, basis: 'actual-reported-by-claude-cli',
      note: 'המגבלות הן הגדרות הגנה של האפליקציה בלבד — לא מגבלות חיוב של Anthropic או של המנוי שלך. העלות היא הערך שדווח בפועל על ידי Claude, לא הערכת טוקנים.',
    };
  }

  /** Remaining USD an AI job may spend right now (min of day/month headroom, minus budget held by runs in flight). */
  headroomUsd(now = new Date()): number {
    const g = this.cached; const t = this.spendTotals(now); const held = this.reservedUsd();
    return Math.max(0, Math.min(g.maxDailyCostUsd - t.dayUsd - held, g.maxMonthlyCostUsd - t.monthUsd - held));
  }

  /** Hold `usd` for an AI run until release(); call synchronously right after canStartAi passes. */
  reserve(key: string, usd: number): void { this.reserved.set(key, Math.max(0, usd)); }
  release(key: string): void { this.reserved.delete(key); }
  reservedUsd(): number { let s = 0; for (const v of this.reserved.values()) s += v; return round(s); }

  /** The single gate every AI step must pass. runningAi is the current number of live AI jobs. */
  canStartAi(estimatedUsd: number, runningAi: number, now = new Date()): Denial {
    const g = this.cached;
    if (g.killSwitch) return { ok: false, code: 'kill-switch', messageHe: 'מתג החירום פעיל — כל עבודת AI חסומה.' };
    if (g.dryRun) return { ok: false, code: 'dry-run', messageHe: 'מצב יבש פעיל — לא מבוצעות קריאות AI אמיתיות.' };
    if (runningAi >= g.maxConcurrentAiJobs) return { ok: false, code: 'concurrency', messageHe: `הגעת למגבלת ${g.maxConcurrentAiJobs} משימות AI במקביל.` };
    const t = this.spendTotals(now); const held = this.reservedUsd();
    if (t.dayUsd + held + estimatedUsd > g.maxDailyCostUsd) return { ok: false, code: 'daily-limit', messageHe: `המשימה תחרוג מהתקציב היומי (${g.maxDailyCostUsd}$).` };
    if (t.monthUsd + held + estimatedUsd > g.maxMonthlyCostUsd) return { ok: false, code: 'monthly-limit', messageHe: `המשימה תחרוג מהתקציב החודשי (${g.maxMonthlyCostUsd}$).` };
    return { ok: true };
  }

  isSoftLimitReached(now = new Date()): boolean {
    const g = this.cached; const t = this.spendTotals(now);
    return t.dayUsd >= g.maxDailyCostUsd * g.softLimitRatio || t.monthUsd >= g.maxMonthlyCostUsd * g.softLimitRatio;
  }

  recordSpend(taskId: string, usd: number, modelId: string | null, isDemo: boolean): void {
    if (!(usd >= 0)) return;
    this.db.prepare('INSERT INTO spend (id, task_id, at, usd, model_id, is_demo) VALUES (?,?,?,?,?,?)').run(newId('sp'), taskId, nowIso(), usd, modelId, isDemo ? 1 : 0);
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
