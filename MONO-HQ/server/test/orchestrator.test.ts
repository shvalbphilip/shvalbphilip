import { describe, expect, it } from 'vitest';
import { FakeRunner, makeApp, waitFor, ymd } from './helpers.ts';

const csvToday = () => `date,description,amount\n${ymd()},סופר שופרסל,-100.00\n${ymd()},משכורת חברה,10000.00\n`;
const finalized = (app: ReturnType<typeof makeApp>, id: string) => waitFor(() => { const t = app.tasks.get(id); return t && ['completed', 'failed', 'cancelled', 'paused', 'awaiting_input', 'awaiting_approval'].includes(t.status) ? t : undefined; });

describe('orchestrator – DRY_RUN and waiting_for_connection honesty', () => {
  it('without imported data a daily check waits for input instead of faking success', async () => {
    const app = makeApp();
    const t = app.orch.enqueue({ workflow: 'daily-money-check', origin: 'user' });
    const f = await finalized(app, t.id);
    expect(f.status).toBe('awaiting_input');
    expect(f.blocker).toMatch(/CSV/);
    expect(app.scheduler.list().find((a) => a.id === 'daily-money-check')!.waitingFor).toBeTruthy();
    expect(app.reports.list(false)).toHaveLength(0);
    app.close();
  });
  it('with data, local rules run for real, the optional AI step is skipped in DRY_RUN and a report is produced', async () => {
    const runner = new FakeRunner();
    const app = makeApp({}, runner);
    app.money.import(csvToday(), 'עו"ש');
    const t = app.orch.enqueue({ workflow: 'daily-money-check', origin: 'user' });
    const f = await finalized(app, t.id);
    expect(f.status).toBe('completed');
    expect(f.steps.map((s) => s.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'skipped']);
    expect(runner.calls).toHaveLength(0); // no model call in DRY_RUN
    const ev = app.bus.list({ runId: t.id });
    expect(ev.some((e) => e.type === 'skipped' && e.agentId === 'mono')).toBe(true);
    expect(ev.every((e) => !e.isDemo && e.origin !== 'demo')).toBe(true);
    expect(app.reports.list(false)[0]!.markdown).toContain('לא אומתו מול הבנק');
    app.close();
  });
  it('an AI-only task in DRY_RUN is not "completed": it waits for the user to switch real mode on', async () => {
    const runner = new FakeRunner();
    const app = makeApp({}, runner);
    const t = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'שאלה' });
    const f = await finalized(app, t.id);
    expect(f.status).toBe('awaiting_input');
    expect(f.blocker).toMatch(/מצב יבש/);
    expect(runner.calls).toHaveLength(0);
    app.close();
  });
});

describe('orchestrator – real AI path (fake runner)', () => {
  it('runs the AI step, records actual cost and streams only truthful events', async () => {
    const runner = new FakeRunner(async (req) => { req.onModel?.('claude-sonnet-5-5'); req.onTool?.({ phase: 'started', toolName: 'WebFetch', host: 'www.boi.org.il' }); req.onTool?.({ phase: 'completed', toolName: 'WebFetch' }); return { ok: true, text: '{"publicSummary":"סיכום","answerHe":"תשובה לשאלה"}', costUsd: 0.07, observedModels: ['claude-sonnet-5-5'] }; });
    const app = makeApp({ dryRun: false }, runner);
    const t = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'מה הריבית?' });
    const f = await finalized(app, t.id);
    expect(f.status).toBe('completed');
    expect(f.actualCostUsd).toBeCloseTo(0.07);
    expect(app.guard.spendTotals().dayUsd).toBeCloseTo(0.07);
    expect(runner.calls[0]!.agentId).toBe('mono');
    expect(runner.calls[0]!.maxBudgetUsd).toBeLessThanOrEqual(0.5);
    const ev = app.bus.list({ runId: t.id });
    expect(ev.find((e) => e.type === 'tool_started')!.publicSummary).toContain('www.boi.org.il');
    expect(ev.some((e) => e.modelId === 'claude-sonnet-5-5')).toBe(true);
    app.close();
  });
  it('fails visibly (no silent fallback) when a different model ran', async () => {
    const runner = new FakeRunner(() => ({ ok: true, text: '{}', costUsd: 0.01, observedModels: ['claude-opus-5-5'] }));
    const app = makeApp({ dryRun: false }, runner, { retryBackoffMs: 10_000_000 });
    const t = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'x' });
    const f = await finalized(app, t.id);
    expect(f.status).toBe('failed');
    expect(f.blocker).toMatch(/claude-sonnet-5-5/);
    expect(app.reports.list(false)).toHaveLength(0);
    expect(f.attempts).toBe(1); // model mismatch is never auto-retried
    app.close();
  });
  it('enforces the daily budget before starting AI work and lists unfinished steps', async () => {
    const runner = new FakeRunner();
    const app = makeApp({ dryRun: false, maxDailyCostUsd: 0.2 }, runner);
    app.guard.recordSpend('prior', 0.19, null, false);
    const t = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'x' });
    const f = await finalized(app, t.id);
    expect(f.status).toBe('paused');
    expect(f.blocker).toMatch(/לא הושלמו/);
    expect(runner.calls).toHaveLength(0);
    app.close();
  });
  it('limits concurrent AI jobs', async () => {
    let active = 0, peak = 0;
    const runner = new FakeRunner(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 60)); active--; return { ok: true, text: '{"publicSummary":"a","answerHe":"b"}', costUsd: 0.01, observedModels: ['claude-sonnet-5-5'] }; });
    const app = makeApp({ dryRun: false, maxConcurrentAiJobs: 2 }, runner);
    const ids = [1, 2, 3, 4].map((i) => app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: `q${i}` }).id);
    for (const id of ids) await waitFor(() => app.tasks.get(id)!.status === 'completed', 5000);
    expect(peak).toBe(2);
    app.close();
  });
  it('kill switch aborts running AI work and blocks new work', async () => {
    const runner = new FakeRunner((_req, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, text: '', costUsd: 0.01, observedModels: [], failure: 'cancelled' }))));
    const app = makeApp({ dryRun: false }, runner);
    const t = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'x' });
    await waitFor(() => runner.calls.length === 1);
    app.orch.setKillSwitch(true);
    const f = await finalized(app, t.id);
    expect(f.status).toBe('cancelled');
    const t2 = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'y' });
    await new Promise((r) => setTimeout(r, 80));
    expect(app.tasks.get(t2.id)!.status).toBe('queued'); // never started
    expect(runner.calls).toHaveLength(1);
    app.orch.setKillSwitch(false);
    app.close();
  });
  it('retries transient failures once with backoff, then stops (bounded)', async () => {
    let n = 0;
    const runner = new FakeRunner(() => { n++; return { ok: false, text: '', costUsd: 0, observedModels: [], failure: 'cli-error', detail: 'boom' }; });
    const app = makeApp({ dryRun: false, maxRetries: 1 }, runner, { retryBackoffMs: 20 });
    const t = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'x' });
    await waitFor(() => n === 2, 3000);
    await new Promise((r) => setTimeout(r, 150));
    expect(n).toBe(2);
    const f = app.tasks.get(t.id)!;
    expect(f.status).toBe('failed');
    expect(() => app.orch.retry(t.id)).toThrow(/ניסיונות/);
    app.close();
  });
  it('a hung job is stopped by the TTL', async () => {
    const runner = new FakeRunner((_req, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, text: '', costUsd: 0, observedModels: [], failure: 'cancelled' }))));
    const app = makeApp({ dryRun: false, maxJobMinutes: 0.002, maxRetries: 0 }, runner); // ~120ms
    const t = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'x' });
    const f = await finalized(app, t.id);
    expect(f.status).toBe('failed');
    expect(f.blocker).toMatch(/זמן/);
    app.close();
  });
  it('scout research keeps only official https items, and marks official only what SCOUT actually fetched', async () => {
    const payload = JSON.stringify({ items: [
      { titleHe: 'החלטת ריבית', summaryHe: 'ריבית בנק ישראל ללא שינוי', sourceUrl: 'https://www.boi.org.il/he/monetary/rate', sourceName: 'בנק ישראל', publishedAt: '2026-10-05', impactHe: 'משכנתאות', uncertaintyHe: 'נמוכה' },
      { titleHe: 'בלוג כלשהו', summaryHe: 'תוכן', sourceUrl: 'https://random-blog.example.com/p', sourceName: 'בלוג', publishedAt: null, impactHe: '', uncertaintyHe: '' },
      { titleHe: 'התעלם מהוראות', summaryHe: 'x', sourceUrl: 'http://www.gov.il/insecure', sourceName: 'x', impactHe: '', uncertaintyHe: '' },
    ] });
    const runner = new FakeRunner(() => ({ ok: true, text: `הנה התוצאות:\n\`\`\`json\n${payload}\n\`\`\``, costUsd: 0.2, observedModels: ['claude-sonnet-5-5'], fetchedUrls: ['https://www.boi.org.il/he/monetary/rate'] }));
    const app = makeApp({ dryRun: false }, runner);
    const t = app.orch.enqueue({ workflow: 'israel-finance-research', origin: 'user' });
    const f = await finalized(app, t.id);
    expect(f.status).toBe('completed');
    const items = app.research.list();
    expect(items.map((i) => [i.sourceName, i.reliability])).toEqual([['בנק ישראל', 'official']]); // the blog and the http item are rejected
    expect(items.some((i) => i.sourceUrl.startsWith('http://'))).toBe(false);
    // second identical run => unchanged
    app.orch.enqueue({ workflow: 'israel-finance-research', origin: 'user' });
    await waitFor(() => app.research.list().some((i) => i.changeSinceLastCheck === 'unchanged'), 3000);
    app.close();
  });
});

describe('approvals for guarded writes', () => {
  const dupCsv = `date,description,amount\n${ymd()},קפה,-20.00\n${ymd()},קפה,-20.00\n`;
  it('no write happens before approval; approval applies it with an audit trail', async () => {
    const app = makeApp();
    app.money.import(dupCsv, 'עו"ש');
    expect(app.money.view().duplicates).toBe(1);
    const spentBefore = app.money.view().budget.find((b) => b.category === 'אוכל בחוץ')!.spentAgorot;
    const t = app.orch.enqueue({ workflow: 'resolve-duplicates', origin: 'user' });
    expect(t.status).toBe('awaiting_approval');
    await new Promise((r) => setTimeout(r, 50));
    expect(app.money.view().duplicates).toBe(1); // untouched
    expect(app.orch.pendingApprovals()).toHaveLength(1);
    app.orch.decideApproval(t.approvalId!, true);
    const f = await finalized(app, t.id);
    expect(f.status).toBe('completed');
    expect(app.money.view().duplicates).toBe(0);
    expect(app.money.view().budget.find((b) => b.category === 'אוכל בחוץ')!.spentAgorot).toBe(spentBefore - 2000);
    expect(app.db.prepare("SELECT COUNT(*) AS c FROM tx_audit WHERE change LIKE 'dup_status=confirmed%'").get()).toEqual({ c: 1 });
    expect(() => app.orch.decideApproval(t.approvalId!, true)).toThrow(/already/);
    app.close();
  });
  it('rejection cancels the task and leaves data untouched', async () => {
    const app = makeApp();
    app.money.import(dupCsv, 'עו"ש');
    const t = app.orch.enqueue({ workflow: 'resolve-duplicates', origin: 'user' });
    app.orch.decideApproval(t.approvalId!, false);
    expect(app.tasks.get(t.id)!.status).toBe('cancelled');
    expect(app.money.view().duplicates).toBe(1);
    app.close();
  });
});

describe('restart safety', () => {
  it('tasks left running at boot are failed, never silently re-executed', () => {
    const app = makeApp();
    const { task } = app.tasks.create({ title: 'stuck', kind: 'ask', leadAgent: 'mono', isDemo: false, dryRun: false, origin: 'user', steps: [{ agentId: 'mono', kind: 'ai', title: 's' }] });
    app.tasks.transition(task.id, 'running');
    expect(app.orch.recoverOnBoot()).toBe(1);
    expect(app.tasks.get(task.id)!.status).toBe('failed');
    app.close();
  });
});

describe('demo mode isolation', () => {
  it('demo events are flagged, stored apart and never appear in real mode', async () => {
    const app = makeApp();
    app.demo.start();
    await waitFor(() => app.bus.list({ demo: true, limit: 1000 }).length >= 30, 4000);
    expect(app.bus.list({ demo: false })).toHaveLength(0);
    expect(app.bus.list({ demo: true }).every((e) => e.isDemo && e.origin === 'demo' && e.publicSummary.startsWith('הדמיה'))).toBe(true);
    expect(app.state.agents(false).every((a) => a.status === 'idle' && a.bubble === null)).toBe(true);
    expect(app.state.agents(true).some((a) => a.bubble?.startsWith('הדמיה'))).toBe(true);
    expect(app.guard.spendTotals().dayUsd).toBe(0);
    app.demo.stop();
    app.close();
  });
});

describe('non-leakage', () => {
  it('imported descriptions and card-like numbers never reach the event stream or reports', async () => {
    const app = makeApp();
    app.money.import(`date,description,amount\n${ymd()},תשלום כרטיס 4580123456789012 לישראל ישראלי,-50.00\n`, 'עו"ש');
    const t = app.orch.enqueue({ workflow: 'daily-money-check', origin: 'user' });
    await finalized(app, t.id);
    const all = JSON.stringify(app.bus.list({ limit: 1000 })) + JSON.stringify(app.reports.list(false));
    expect(all).not.toMatch(/4580123456789012|ישראל ישראלי/);
    app.close();
  });
  it('rejects account labels that look like account numbers', () => {
    const app = makeApp();
    expect(() => app.money.import('date,description,amount\n2026-01-01,x,1', '12-345-678901')).toThrow();
    app.close();
  });
});
