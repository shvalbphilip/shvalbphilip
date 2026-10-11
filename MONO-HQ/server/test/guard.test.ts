import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { jerusalemDay } from '../src/guard.ts';
import { makeApp } from './helpers.ts';

describe('guardrails', () => {
  it('defaults are safe: DRY_RUN on, $2/day, $25/month, 2 concurrent, 12 min, 1 retry', () => {
    const d = loadConfig({} as NodeJS.ProcessEnv).defaults;
    expect(d).toMatchObject({ dryRun: true, killSwitch: false, maxDailyCostUsd: 2, maxMonthlyCostUsd: 25, maxConcurrentAiJobs: 2, maxJobMinutes: 12, maxRetries: 1 });
  });
  it('refuses to bind a non-loopback address without a strong access token', () => {
    expect(() => loadConfig({ MONO_HOST: '0.0.0.0' } as NodeJS.ProcessEnv)).toThrow(/MONO_ACCESS_TOKEN/);
    expect(() => loadConfig({ MONO_HOST: '0.0.0.0', MONO_ACCESS_TOKEN: 'short' } as NodeJS.ProcessEnv)).toThrow();
    expect(loadConfig({ MONO_HOST: '0.0.0.0', MONO_ACCESS_TOKEN: 'x'.repeat(20) } as NodeJS.ProcessEnv).host).toBe('0.0.0.0');
  });
  it('denies in priority order: kill switch, dry run, concurrency, daily and monthly caps', () => {
    const app = makeApp({ dryRun: false, maxDailyCostUsd: 1, maxMonthlyCostUsd: 1.5, maxConcurrentAiJobs: 2 });
    const g = app.guard;
    expect(g.canStartAi(0.5, 0)).toEqual({ ok: true });
    expect(g.canStartAi(0.5, 2)).toMatchObject({ ok: false, code: 'concurrency' });
    g.recordSpend('t', 0.8, 'claude-sonnet-5-5', false);
    expect(g.canStartAi(0.5, 0)).toMatchObject({ ok: false, code: 'daily-limit' });
    expect(g.canStartAi(0.2, 0)).toEqual({ ok: true });
    g.update({ maxDailyCostUsd: 100 }, 'test');
    g.recordSpend('t', 0.6, null, false);
    expect(g.canStartAi(0.2, 0)).toMatchObject({ ok: false, code: 'monthly-limit' });
    g.update({ dryRun: true }, 'test');
    expect(g.canStartAi(0, 0)).toMatchObject({ ok: false, code: 'dry-run' });
    g.update({ killSwitch: true }, 'test');
    expect(g.canStartAi(0, 0)).toMatchObject({ ok: false, code: 'kill-switch' });
    app.close();
  });
  it('demo spend never counts toward real budgets; headroom shrinks with spend', () => {
    const app = makeApp({ dryRun: false, maxDailyCostUsd: 1 });
    app.guard.recordSpend('d', 50, null, true);
    expect(app.guard.spendTotals().dayUsd).toBe(0);
    app.guard.recordSpend('t', 0.4, null, false);
    expect(app.guard.headroomUsd()).toBeCloseTo(0.6);
    app.close();
  });
  it('validates limit updates and writes an audit trail', () => {
    const app = makeApp();
    expect(() => app.guard.update({ maxDailyCostUsd: -1 }, 'x')).toThrow();
    expect(() => app.guard.update({ maxConcurrentAiJobs: 99 }, 'x')).toThrow();
    app.guard.update({ maxDailyCostUsd: 3 }, 'user');
    expect(app.system().auditLog[0]?.action).toBe('guardrails.update');
    app.close();
  });
  it('buckets spend by Asia/Jerusalem day, not UTC', () => {
    // 22:30 UTC on 2026-06-01 is already 01:30 on 2026-06-02 in Israel (UTC+3)
    expect(jerusalemDay(new Date('2026-06-01T22:30:00Z'))).toBe('2026-06-02');
    expect(jerusalemDay(new Date('2026-12-01T21:30:00Z'))).toBe('2026-12-01');
  });
});
