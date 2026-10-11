import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { FakeRunner, makeApp, waitFor } from './helpers.ts';

const root = new URL('../../..', import.meta.url).pathname;
const settled = (app: ReturnType<typeof makeApp>, id: string) => waitFor(() => { const t = app.tasks.get(id); return t && t.status !== 'queued' && t.status !== 'running' ? t : undefined; });

describe('safe defaults (explicit assertions)', () => {
  it('.env.example lists every variable config.ts reads, and used as-is it yields the safe defaults', () => {
    const example = Object.fromEntries(readFileSync(`${root}MONO-HQ/.env.example`, 'utf8').split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const read = [...readFileSync(`${root}MONO-HQ/server/src/config.ts`, 'utf8').matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]!);
    expect(Object.keys(example).sort()).toEqual([...new Set(read)].sort());
    const cfg = loadConfig(example as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ host: '127.0.0.1', port: 8787, accessToken: null, claudeBin: 'claude' });
    expect(cfg.defaults).toMatchObject({ dryRun: true, maxDailyCostUsd: 2, maxMonthlyCostUsd: 25, maxConcurrentAiJobs: 2 });
  });
  it('DRY_RUN is on unless DRY_RUN=false is set explicitly; any other value keeps it on', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).defaults.dryRun).toBe(true);
    for (const v of ['', '0', 'no', 'FALSE', 'off']) expect(loadConfig({ DRY_RUN: v } as NodeJS.ProcessEnv).defaults.dryRun, `DRY_RUN=${v}`).toBe(true);
    expect(loadConfig({ DRY_RUN: 'false' } as NodeJS.ProcessEnv).defaults.dryRun).toBe(false);
    expect(makeApp().guard.get()).toMatchObject({ dryRun: true, killSwitch: false });
  });
  it('no AI call can happen while DRY_RUN is on: every AI-bearing workflow and model verification leave the runner untouched', async () => {
    const runner = new FakeRunner();
    const app = makeApp({}, runner);
    app.money.import(`date,description,amount\n2026-01-05,סופר,-10.00\n`, 'עו"ש');
    for (const workflow of ['ask', 'israel-finance-research', 'daily-money-check', 'weekly-money-review']) {
      const t = app.orch.enqueue({ workflow, origin: 'user', prompt: 'שאלה' });
      const f = await settled(app, t.id);
      expect(['awaiting_input', 'completed']).toContain(f.status);
    }
    expect((await app.verifyModel()).status).toBe('dry-run-skipped');
    expect(runner.calls).toHaveLength(0);
    expect(app.guard.canStartAi(0, 0)).toMatchObject({ ok: false, code: 'dry-run' });
    expect(app.guard.spendTotals()).toEqual({ dayUsd: 0, monthUsd: 0 });
    app.close();
  });
  it('turning DRY_RUN off is the only way to let the runner be called', async () => {
    const runner = new FakeRunner();
    const app = makeApp({}, runner);
    app.guard.update({ dryRun: false }, 'user');
    const t = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'שאלה' });
    await settled(app, t.id);
    expect(runner.calls).toHaveLength(1);
    expect(app.system().auditLog.some((a) => a.action === 'guardrails.update' && a.detail.includes('"dryRun":false'))).toBe(true);
    app.close();
  });
  it('binds loopback by default and refuses other hosts without a strong token', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.host).toBe('127.0.0.1'); expect(cfg.port).toBe(8787); expect(cfg.accessToken).toBeNull();
    expect(() => loadConfig({ MONO_HOST: '0.0.0.0' } as NodeJS.ProcessEnv)).toThrow(/MONO_ACCESS_TOKEN/);
    expect(() => loadConfig({ MONO_HOST: '192.168.1.10', MONO_ACCESS_TOKEN: 'tooshort' } as NodeJS.ProcessEnv)).toThrow();
  });
  it('git ignores the data directory, databases, CSV/XLSX exports and env files at both levels', () => {
    const top = readFileSync(`${root}.gitignore`, 'utf8');
    const app = readFileSync(`${root}MONO-HQ/.gitignore`, 'utf8');
    for (const p of ['data/', 'MONO-HQ/data/', '*.csv', '*.xlsx', '*.db', '.env', '.env.*', '*.sqlite']) expect(top, p).toContain(p);
    for (const p of ['*.csv', '*.db', '.env', '.env.*', 'data/private/']) expect(app, p).toContain(p);
    expect(top).toContain('!MONO-HQ/fixtures/*.csv'); // only the synthetic fixture is allowed back in
  });
  it('redaction is applied to events and reports, not only to what the UI shows', () => {
    const app = makeApp();
    const id9 = ['123', '456', '789'].join('');
    const e = app.bus.emitEvent({ runId: 'r', agentId: 'mono', type: 'progress', publicSummary: `ת.ז. ${id9} מייל x@y.co`, origin: 'user', isDemo: false });
    expect((app.db.prepare('SELECT public_summary AS s FROM events WHERE seq = ?').get(e.seq) as { s: string }).s).not.toMatch(new RegExp(`${id9}|x@y\\.co`));
    const r = app.reports.create({ kind: 'ad-hoc', titleHe: 't', taskId: null, isDemo: false, markdown: `ת.ז. ${id9}`, data: { s: `x@y.co` } });
    const row = app.db.prepare('SELECT markdown, data FROM reports WHERE id = ?').get(r.id) as { markdown: string; data: string };
    expect(row.markdown).not.toContain(id9); expect(row.data).not.toContain('x@y.co');
    app.close();
  });
});
