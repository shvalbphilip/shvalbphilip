import { randomUUID } from 'node:crypto';

export const nowIso = (): string => new Date().toISOString();
export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export function jerusalemParts(d: Date): { y: number; m: number; day: number; h: number; min: number; weekday: number } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday as string);
  return { y: +p.year!, m: +p.month!, day: +p.day!, h: +p.hour! % 24, min: +p.minute!, weekday: wd };
}
