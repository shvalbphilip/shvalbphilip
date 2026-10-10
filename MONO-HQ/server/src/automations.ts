import { Cron } from 'croner';

export interface AutomationDef {
  id: string;
  nameHe: string;
  descriptionHe: string;
  scheduleHe: string;
  cron: string | null;
  trigger: 'cron' | 'event';
  timeConfirmed: boolean; // false => the proposed time is only a draft until the user enables/confirms it
  workflow: string;
  requiresAi: boolean;
  requiredSources: string[];
  maxDurationMinutes: number;
  maxAttempts: number;
  maxModelCostUsd: number;
  approvalPolicy: string;
  graceMinutes: number; // a run missed by more than this (e.g. laptop asleep) is skipped, never back-filled
}

export const TZ = 'Asia/Jerusalem';

export const AUTOMATIONS: AutomationDef[] = [
  { id: 'daily-money-check', nameHe: 'בדיקת כסף יומית', descriptionHe: 'מאזן נתונים שיובאו לאחרונה, בודק תקציב ומסמן נתונים חסרים. סיכום AI אופציונלי.', scheduleHe: 'כל יום ב-21:30 (שעון ישראל)', cron: '30 21 * * *', trigger: 'cron', timeConfirmed: true, workflow: 'daily-money-check', requiresAi: false, requiredSources: ['ייבוא עסקאות (CSV)'], maxDurationMinutes: 12, maxAttempts: 2, maxModelCostUsd: 0.3, approvalPolicy: 'אישור חד-פעמי בהפעלה; כל כתיבה לנתונים דורשת אישור נפרד', graceMinutes: 120 },
  { id: 'weekly-money-review', nameHe: 'סקירה שבועית', descriptionHe: 'הוצאות בפועל מול תקציב, דליפות כסף ושלוש פעולות מומלצות.', scheduleHe: 'ימי ראשון ב-19:00 (שעון ישראל)', cron: '0 19 * * 0', trigger: 'cron', timeConfirmed: true, workflow: 'weekly-money-review', requiresAi: false, requiredSources: ['ייבוא עסקאות (CSV)'], maxDurationMinutes: 12, maxAttempts: 2, maxModelCostUsd: 0.6, approvalPolicy: 'אישור חד-פעמי בהפעלה', graceMinutes: 360 },
  { id: 'salary-day-reset', nameHe: 'איפוס יום משכורת', descriptionHe: 'ב-1 לחודש: מאמת שהמשכורת באמת נקלטה בעסקאות לפני שמחשבים מחדש. לא מניח שהגיעה.', scheduleHe: 'ב-1 לחודש ב-09:00 — שעה טיוטה, ממתינה לאישורך', cron: '0 9 1 * *', trigger: 'cron', timeConfirmed: false, workflow: 'salary-day-reset', requiresAi: false, requiredSources: ['ייבוא עסקאות (CSV) עם משכורת שנקלטה'], maxDurationMinutes: 12, maxAttempts: 2, maxModelCostUsd: 0.3, approvalPolicy: 'אישור שעה בהפעלה', graceMinutes: 24 * 60 },
  { id: 'israel-finance-research', nameHe: 'מחקר פיננסי ישראלי', descriptionHe: 'SCOUT בודק מקורות רשמיים בלבד ומדווח על שינויים מהותיים עם קישור ותאריך.', scheduleHe: 'שבועי, חמישי ב-10:00 — שעה מוצעת, ממתינה לאישורך', cron: '0 10 * * 4', trigger: 'cron', timeConfirmed: false, workflow: 'israel-finance-research', requiresAi: true, requiredSources: ['אתרים ממשלתיים רשמיים (gov.il, boi.org.il)'], maxDurationMinutes: 12, maxAttempts: 2, maxModelCostUsd: 1.0, approvalPolicy: 'אישור שעה ועלות בהפעלה', graceMinutes: 24 * 60 },
  { id: 'risk-watch', nameHe: 'ניטור סיכונים', descriptionHe: 'בדיקות כללים מקומיות על עסקאות חדשות — בלי לקרוא ל-AI כדי לגלות שלא השתנה דבר.', scheduleHe: 'מופעל אחרי ייבוא עסקאות חדש', cron: null, trigger: 'event', timeConfirmed: true, workflow: 'risk-watch', requiresAi: false, requiredSources: ['עסקאות מיובאות'], maxDurationMinutes: 5, maxAttempts: 1, maxModelCostUsd: 0, approvalPolicy: 'אישור חד-פעמי בהפעלה', graceMinutes: 0 },
];

/** Next fire time strictly after `from`, computed in Asia/Jerusalem (croner handles DST). */
export function nextRun(cron: string, from: Date): Date | null {
  return new Cron(cron, { timezone: TZ }).nextRun(from);
}
