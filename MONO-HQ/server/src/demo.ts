import type { Db } from './db.ts';
import type { EventBus } from './events.ts';
import { AGENTS } from './agents.ts';
import type { TaskStore } from './tasks.ts';
import type { Task } from '../../shared/contract.ts';

const SCRIPT: Record<string, Array<{ tool: string; text: string }>> = {
  mono: [{ tool: 'תיאום', text: 'מחלק את בדיקת הבוקר לשבעת המומחים' }],
  scout: [{ tool: 'חיפוש ברשת', text: 'בודק הודעות ריבית בבנק ישראל (דוגמה)' }],
  ledger: [{ tool: 'כללים מקומיים', text: 'מאזן חיובי כרטיס מול תנועות בנק (דוגמה)' }],
  flow: [{ tool: 'חישוב', text: 'בונה תחזית תזרים ל-14 ימים (דוגמה)' }],
  credit: [{ tool: 'חישוב', text: 'משווה לוחות סילוקין של הלוואה (דוגמה)' }],
  budget: [{ tool: 'חישוב', text: 'מחשב כמה נשאר להוציא היום (דוגמה)' }],
  radar: [{ tool: 'כללים מקומיים', text: 'סורק חיובים חריגים (דוגמה)' }],
  guardian: [{ tool: 'אימות', text: 'מאמת מקורות ותאריכים לפני דוח (דוגמה)' }],
};

/**
 * DEMO mode: scripted, unmistakably labelled, flagged isDemo and stored apart from real events.
 * It never calls a model and is bounded (a few cycles, then it stops itself).
 */
export class Demo {
  private timers: NodeJS.Timeout[] = [];
  running = false;
  constructor(private db: Db, private bus: EventBus, private tasks: TaskStore, private stepMs = 1800, private cycles = 3) {}

  start(): boolean {
    if (this.running) return false;
    this.running = true;
    let delay = 0;
    for (let c = 0; c < this.cycles; c++) {
      const { task } = this.tasks.create({
        title: 'הדמיה · בדיקת בוקר (לא ריצה אמיתית)', kind: 'demo', leadAgent: 'mono', isDemo: true, dryRun: true, origin: 'demo',
        steps: AGENTS.map((a) => ({ agentId: a.id, kind: 'local' as const, title: SCRIPT[a.id]![0]!.text })),
      });
      this.at(delay, () => { this.tasks.transition(task.id, 'running'); this.ev(task, 'mono', 'started', 'הדמיה: התחלת מחזור הדגמה'); });
      AGENTS.forEach((a, i) => {
        const s = SCRIPT[a.id]![0]!;
        const t0 = delay + 400 + i * this.stepMs;
        this.at(t0, () => { this.tasks.setStep(task.id, i, 'running'); this.ev(task, a.id, 'started', `הדמיה: ${s.text}`, s.tool); });
        this.at(t0 + this.stepMs * 0.6, () => { this.tasks.setStep(task.id, i, 'completed'); this.ev(task, a.id, 'completed', `הדמיה: הושלם — ${s.text}`, s.tool); });
      });
      const end = delay + 400 + AGENTS.length * this.stepMs + 400;
      this.at(end, () => { this.tasks.transition(task.id, 'completed', { resultSummary: 'הדמיה בלבד — לא בוצעה עבודה אמיתית' }); this.ev(task, 'mono', 'completed', 'הדמיה: מחזור ההדגמה הסתיים'); });
      delay = end + 600;
    }
    this.at(delay, () => { this.running = false; });
    return true;
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = []; this.running = false;
    for (const t of this.tasks.list({ demo: true, limit: 50 })) {
      if (t.status === 'running' || t.status === 'queued') { const c = this.tasks.transition(t.id, 'cancelled', { blocker: 'הדמיה הופסקה' }); this.ev(c, 'mono', 'cancelled', 'הדמיה: הופסקה'); }
    }
  }

  private at(ms: number, fn: () => void) { const t = setTimeout(() => { try { fn(); } catch { /* demo is best-effort */ } }, ms); t.unref(); this.timers.push(t); }
  private ev(task: Task, agentId: Parameters<EventBus['emitEvent']>[0]['agentId'], type: Parameters<EventBus['emitEvent']>[0]['type'], summary: string, toolCategory?: string) {
    this.bus.emitEvent({ runId: task.id, agentId, type, publicSummary: summary, origin: 'demo', isDemo: true, toolCategory });
  }
}
