import type { AgentLiveStatus, EventType, ModelVerification, TaskStatus } from '../../shared/contract.ts';

const TZ = 'Asia/Jerusalem';
const tf = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dtf = new Intl.DateTimeFormat('he-IL', {
  timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const df = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const nf = new Intl.NumberFormat('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function valid(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const fmtTime = (iso?: string | null) => { const d = valid(iso); return d ? tf.format(d) : '—'; };
export const fmtDateTime = (iso?: string | null) => { const d = valid(iso); return d ? dtf.format(d) : '—'; };
export const fmtDateIso = (iso?: string | null) => { const d = valid(iso); return d ? df.format(d) : '—'; };
/** YYYY-MM-DD (a calendar date, not an instant) */
export function fmtCalendarDate(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(`${s.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? s : df.format(d);
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

export function fmtIls(agorot: number, signed = false): string {
  const neg = agorot < 0;
  const body = `₪${nf.format(Math.abs(agorot) / 100)}`;
  if (neg) return `−${body}`;
  return signed && agorot > 0 ? `+${body}` : body;
}

export function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export const TASK_STATUS_HE: Record<TaskStatus, string> = {
  queued: 'בתור', running: 'רץ', awaiting_input: 'ממתין למידע', awaiting_approval: 'ממתין לאישור',
  completed: 'הושלם', failed: 'נכשל', cancelled: 'בוטל', paused: 'מושהה',
};
export const AGENT_STATUS_HE: Record<AgentLiveStatus, string> = {
  idle: 'ממתין', working: 'עובד', awaiting_approval: 'ממתין לאישור', awaiting_input: 'ממתין למידע',
  blocked: 'חסום', stale: 'ללא עדכון', failed: 'נכשל',
};
export const EVENT_TYPE_HE: Record<EventType, string> = {
  queued: 'בתור', started: 'התחיל', tool_started: 'כלי התחיל', tool_completed: 'כלי הסתיים', progress: 'התקדמות',
  awaiting_input: 'ממתין למידע', awaiting_approval: 'ממתין לאישור', completed: 'הושלם', failed: 'נכשל',
  cancelled: 'בוטל', paused: 'הושהה', heartbeat: 'דופק', skipped: 'דולג', blocked: 'חסום',
};
export const MODEL_STATUS_HE: Record<ModelVerification['status'], string> = {
  unverified: 'לא אומת', verified: 'אומת', failed: 'האימות נכשל', 'cli-missing': 'Claude CLI לא נמצא',
  'dry-run-skipped': 'דולג (מצב יבש)',
};
export const FLAG_HE = { confirmed: 'מאומת', reported: 'מדווח', estimated: 'משוער' } as const;
export const KIND_HE: Record<string, string> = {
  expense: 'הוצאה', income: 'הכנסה', transfer: 'העברה', refund: 'החזר',
  'loan-principal': 'קרן הלוואה', 'loan-interest': 'ריבית הלוואה', 'card-settlement': 'חיוב כרטיס',
};
export const REPORT_KIND_HE: Record<string, string> = {
  daily: 'יומי', weekly: 'שבועי', monthly: 'חודשי', 'salary-day': 'יום משכורת', research: 'מחקר', 'ad-hoc': 'חד־פעמי',
};
export const ORIGIN_HE: Record<string, string> = { user: 'משתמש', scheduler: 'מתזמן', demo: 'הדמיה' };
