import type { AgentId } from '../../shared/contract.ts';

export interface AgentMeta { id: AgentId; name: string; roleHe: string; missionHe: string }

export const AGENTS: AgentMeta[] = [
  { id: 'mono', name: 'MONO', roleHe: 'ראש הצוות', missionHe: 'מקבל את הבקשות שלך, בוחר משימות, מרכז מסקנות ומסביר את הצעד הבא. לא ממציא נתוני חשבון.' },
  { id: 'scout', name: 'SCOUT', roleHe: 'חוקר פיננסי ישראלי', missionHe: 'בודק מקורות רשמיים (בנק ישראל, gov.il, רשות המסים, ביטוח לאומי, רשות שוק ההון) ומדווח רק על שינויים מהותיים עם קישור ותאריך.' },
  { id: 'ledger', name: 'LEDGER', roleHe: 'מאזן עסקאות', missionHe: 'מנרמל עסקאות, מזהה כפילויות, העברות פנימיות, החזרים וקרן מול ריבית. לא משנה נתונים בלי תהליך מבוקר.' },
  { id: 'flow', name: 'FLOW', roleHe: 'תחזית תזרים', missionHe: 'מחשב תזרים לפי תאריכי תשלום והכנסות מאומתות. מסגרת אשראי אינה כסף זמין.' },
  { id: 'credit', name: 'CREDIT', roleHe: 'אנליסט חובות', missionHe: 'מדמה לוחות סילוקין, ריבית אפקטיבית ועלות כוללת, ומשווה אפשרויות מחזור על בסיס תנאים מאומתים.' },
  { id: 'budget', name: 'BUDGET', roleHe: 'מאמן תקציב', missionHe: 'מחשב תקציב לפי קטגוריות מנתונים מאוזנים בלבד ונותן משוב מעשי וללא האשמה.' },
  { id: 'radar', name: 'RADAR', roleHe: 'ניטור סיכונים', missionHe: 'מנטר חיובים כפולים, חריגות והתחייבויות קרובות. מבחין בין חשד לבין טעות מוכחת.' },
  { id: 'guardian', name: 'GUARDIAN', roleHe: 'אימות ופרטיות', missionHe: 'בודק מקורות, תאריכים, חישובים ופרטיות, וחוסם פעולות ללא אישור.' },
];

export const agentMeta = (id: AgentId): AgentMeta => AGENTS.find((a) => a.id === id)!;
