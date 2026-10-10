import { describe, expect, it } from 'vitest';
import { AUTOMATIONS, nextRun } from '../src/automations.ts';
import { makeApp } from './helpers.ts';

const daily = AUTOMATIONS.find((a) => a.id === 'daily-money-check')!.cron!;
const weekly = AUTOMATIONS.find((a) => a.id === 'weekly-money-review')!.cron!;
const salary = AUTOMATIONS.find((a) => a.id === 'salary-day-reset')!.cron!;

describe('Asia/Jerusalem schedule maths (DST)', () => {
  it('daily 21:30 is 18:30Z in summer time and 19:30Z in winter time', () => {
    expect(nextRun(daily, new Date('2026-07-01T00:00:00Z'))!.toISOString()).toBe('2026-07-01T18:30:00.000Z');
    expect(nextRun(daily, new Date('2026-12-01T00:00:00Z'))!.toISOString()).toBe('2026-12-01T19:30:00.000Z');
  });
  it('autumn change (clocks back on 2026-10-25): local 21:30 stays 21:30', () => {
    expect(nextRun(daily, new Date('2026-10-24T18:31:00Z'))!.toISOString()).toBe('2026-10-25T19:30:00.000Z'); // 21:30 at UTC+2
    expect(nextRun(daily, new Date('2026-10-24T00:00:00Z'))!.toISOString()).toBe('2026-10-24T18:30:00.000Z'); // 21:30 at UTC+3
  });
  it('spring change (clocks forward on 2026-03-27): local 21:30 stays 21:30', () => {
    expect(nextRun(daily, new Date('2026-03-26T19:31:00Z'))!.toISOString()).toBe('2026-03-27T18:30:00.000Z');
  });
  it('weekly Sunday 19:00 spans the autumn change correctly', () => {
    expect(nextRun(weekly, new Date('2026-10-12T00:00:00Z'))!.toISOString()).toBe('2026-10-18T16:00:00.000Z'); // UTC+3
    expect(nextRun(weekly, new Date('2026-10-19T00:00:00Z'))!.toISOString()).toBe('2026-10-25T17:00:00.000Z'); // UTC+2
  });
  it('salary draft time 09:00 on the 1st follows local time', () => {
    expect(nextRun(salary, new Date('2026-10-02T00:00:00Z'))!.toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });
});

describe('scheduler behaviour', () => {
  it('ships every automation disabled; salary-day and research times are unconfirmed drafts', () => {
    const app = makeApp();
    app.scheduler.list().forEach((a) => expect(a.enabled).toBe(false));
    expect(app.scheduler.list().find((a) => a.id === 'salary-day-reset')!.timeStatus).toBe('draft-awaiting-confirmation');
    expect(app.scheduler.list().find((a) => a.id === 'israel-finance-research')!.timeStatus).toBe('draft-awaiting-confirmation');
    app.close();
  });
  it('requires explicit confirmation to enable and records an approval + audit entry', () => {
    const app = makeApp();
    expect(() => app.scheduler.setEnabled('daily-money-check', true, false)).toThrow(/אישור/);
    app.scheduler.setEnabled('daily-money-check', true, true);
    const a = app.scheduler.list().find((x) => x.id === 'daily-money-check')!;
    expect(a.enabled).toBe(true); expect(a.nextRunAt).toBeTruthy();
    expect(app.system().auditLog.some((l) => l.action === 'automation.enable')).toBe(true);
    app.close();
  });
  it('does nothing while disabled, and while the kill switch is on', () => {
    const app = makeApp();
    expect(app.scheduler.tick(new Date('2099-01-01T00:00:00Z'))).toEqual([]);
    app.scheduler.setEnabled('daily-money-check', true, true);
    app.guard.update({ killSwitch: true }, 'test');
    expect(app.scheduler.tick(new Date('2099-01-01T00:00:00Z'))).toEqual([]);
    app.close();
  });
  it('creates exactly one idempotent task per due slot and does not duplicate on repeated ticks', () => {
    const app = makeApp();
    app.scheduler.setEnabled('daily-money-check', true, true);
    const due = nextRun(daily, new Date())!;
    const justAfter = new Date(due.getTime() + 20_000);
    const first = app.scheduler.tick(justAfter);
    const second = app.scheduler.tick(new Date(justAfter.getTime() + 30_000));
    expect(first).toHaveLength(1); expect(second).toHaveLength(0);
    expect(app.tasks.list({ demo: false }).filter((t) => t.automationId === 'daily-money-check')).toHaveLength(1);
    app.close();
  });
  it('a run missed beyond the grace window (laptop asleep) is recorded as missed, not back-filled', () => {
    const app = makeApp();
    app.scheduler.setEnabled('daily-money-check', true, true);
    const due = nextRun(daily, new Date())!;
    const wokeUpLate = new Date(due.getTime() + 6 * 3600_000);
    expect(app.scheduler.tick(wokeUpLate)).toEqual([]);
    expect(app.system().auditLog.some((l) => l.action === 'automation.missed')).toBe(true);
    app.close();
  });
});
