/**
 * Regression tests for the pre-merge audit of 2026-10-11 (blockers B2–B10 and the three security fixes).
 * Each case reproduces the failing scenario the audit found against the frozen code; B1 is covered in cli.test.ts.
 */
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiRunRequest } from '../src/ai.ts';
import { createApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { MIGRATIONS, openDb } from '../src/db.ts';
import { createHttpServer } from '../src/http.ts';
import { DatabaseSync } from 'node:sqlite';
import { classify, normCurrency } from '../src/money.ts';
import { FakeRunner, makeApp, waitFor, ymd } from './helpers.ts';

const today = ymd(0);
const root = new URL('../../..', import.meta.url).pathname;
const TOKEN = 'a-long-enough-test-token-123';
const AI_TEXT = '{"publicSummary":"x","summaryHe":"x","nextSteps":[],"answerHe":"x","items":[]}';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = (app: App, id: string) =>
  waitFor(() => { const t = app.tasks.get(id); return t && t.status !== 'queued' && t.status !== 'running' ? t : undefined; }, 5000);

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

async function boot(token: string | null, extraEnv: Record<string, string> = {}) {
  const cfg = loadConfig({ ...(token ? { MONO_ACCESS_TOKEN: token } : {}), ...extraEnv } as NodeJS.ProcessEnv);
  const app: App = createApp({ cfg, dataDir: ':memory:', startScheduler: false, demoStepMs: 5 });
  const dist = mkdtempSync(join(tmpdir(), 'dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>MONO</title>');
  const server = createHttpServer(app, dist);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(() => { server.closeAllConnections(); server.close(); app.close(); });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  return { app, port, post, get };
}

describe('B2 · spend caps hold with concurrent and killed runs', () => {
  it('a second concurrent job cannot spend budget the first one is already holding', async () => {
    // every run spends its whole budget, the worst case the cap must survive
    const runner = new FakeRunner(async (req: AiRunRequest) => { await sleep(120); return { ok: true, text: AI_TEXT, costUsd: req.maxBudgetUsd, observedModels: ['claude-sonnet-5-5'] }; });
    const app = makeApp({ dryRun: false }, runner);
    app.guard.recordSpend('earlier', 0.6, 'claude-sonnet-5-5', false);
    const research = app.orch.enqueue({ workflow: 'israel-finance-research', origin: 'user' });
    const ask = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'q', title: 'q' });
    await Promise.all([settled(app, research.id), settled(app, ask.id)]);
    expect(app.guard.spendTotals().dayUsd).toBeLessThanOrEqual(2); // was 2.10 before the fix
    expect(runner.calls).toHaveLength(1);
    expect(app.tasks.get(ask.id)!.status).toBe('paused');
    expect(app.guard.reservedUsd()).toBe(0); // every hold is released
    app.close();
  });
  it('a run killed after start-up but before its result line is charged its whole budget, marked as an estimate', async () => {
    const runner = new FakeRunner(() => ({ ok: false, text: '', costUsd: 0, costReported: false, started: true, observedModels: ['claude-sonnet-5-5'], failure: 'timeout' as const, detail: 'timeout' }));
    const app = makeApp({ dryRun: false, maxRetries: 0 }, runner);
    const t = app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'q', title: 'q' });
    await settled(app, t.id);
    const rows = app.db.prepare('SELECT usd, model_id FROM spend').all() as Array<{ usd: number; model_id: string }>;
    expect(rows).toEqual([{ usd: 0.5, model_id: 'unreported-estimate' }]);
    expect(app.tasks.get(t.id)).toMatchObject({ actualCostUsd: 0.5, costEstimated: true });
    app.close();
  });
  it('a run that never reached start-up, or was killed there by the tool check, charges nothing', async () => {
    for (const [failure, started] of [['cli-missing', false], ['cli-error', false], ['tool-mismatch', true]] as const) {
      const runner = new FakeRunner(() => ({ ok: false, text: '', costUsd: 0, costReported: false, started, observedModels: [], failure, detail: failure }));
      const app = makeApp({ dryRun: false, maxRetries: 0 }, runner);
      await settled(app, app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt: 'q', title: 'q' }).id);
      expect(app.guard.spendTotals().dayUsd, failure).toBe(0);
      app.close();
    }
  });
});

describe('B3 · a guarded write runs only after its approval is approved', () => {
  const twoCoffees = `date,description,amount\n${today},Coffee Shop,-12.00\n${today},Coffee Shop,-12.00\n`;
  const confirmed = (app: App) => (app.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE dup_status = 'confirmed'").get() as { n: number }).n;
  it('resume cannot skip the approval step', async () => {
    const app = makeApp();
    app.money.import(twoCoffees, 'עו"ש');
    const t = app.orch.enqueue({ workflow: 'resolve-duplicates', origin: 'user' });
    expect(app.tasks.get(t.id)!.status).toBe('awaiting_approval');
    expect(() => app.orch.resume(t.id)).toThrow(/מושהית/);
    await sleep(50);
    expect(confirmed(app)).toBe(0);
    app.orch.decideApproval(app.tasks.get(t.id)!.approvalId!, true);
    expect((await settled(app, t.id)).status).toBe('completed');
    expect(confirmed(app)).toBe(1);
    app.close();
  });
  it('even a task forced back to the queue does not write while its approval is pending', async () => {
    const app = makeApp();
    app.money.import(twoCoffees, 'עו"ש');
    const t = app.orch.enqueue({ workflow: 'resolve-duplicates', origin: 'user' });
    app.tasks.transition(t.id, 'queued'); app.orch.pump();
    expect((await settled(app, t.id)).status).toBe('failed');
    await sleep(50);
    expect(app.tasks.get(t.id)!.status).toBe('failed'); // not retried automatically
    expect(confirmed(app)).toBe(0);
    expect(app.orch.getApproval(app.tasks.get(t.id)!.approvalId!)!.status).toBe('expired'); // approving later cannot act
    app.close();
  });
});

describe('B4–B6 · money: currency, delimiters, classification', () => {
  it('B4 · only shekels enter ₪ budgets; ILS spellings are normalised', () => {
    const app = makeApp();
    app.money.import(`date,description,amount,currency\n${today},Amazon,-100.00,USD\n${today},שופרסל,-50.00,NIS\n${today},רמי לוי,-30.00,ש"ח\n`, 'כרטיס');
    expect(app.money.view().budget.map((b) => [b.category, b.spentAgorot])).toEqual([['מכולת', 8000]]); // was also ₪100 from USD
    expect(app.money.transactions().map((t) => t.currency).sort()).toEqual(['ILS', 'ILS', 'USD']);
    expect(['NIS', 'ש"ח', 'ש״ח', '₪', 'ils', '', 'usd'].map(normCurrency)).toEqual(['ILS', 'ILS', 'ILS', 'ILS', 'ILS', 'ILS', 'USD']);
    app.close();
  });
  it('B5 · one delimiter per file, taken from the header line', () => {
    const app = makeApp();
    app.money.import(`date;description;amount\n${today};מכולת;-12,50\n`, 'א');
    app.money.import(`date,description,amount\n${today},Order;123,-50.00\n`, 'ב');
    app.money.import(`date\tdescription\tamount\n${today}\tחשמל, דו-חודשי\t-300.00\n`, 'ג');
    app.money.import(`\n\ndate;description;amount\n${today};מים;-80,00\n`, 'ד'); // leading blank lines
    expect(app.money.transactions().map((t) => [t.description, t.amountAgorot]).sort()).toEqual([
      ['Order;123', -5000], ['חשמל, דו-חודשי', -30000], ['מים', -8000], ['מכולת', -1250], // were -12.00 and +123 income
    ]);
    app.close();
  });
  it('B6 · whole-word rules: insurance and debits are spending, issuer bills are settlements, rent is not salary', () => {
    const cases: Array<[string, number, string, string?]> = [
      ['ביטוח רכב', -30000, 'expense'], ['DIRECT DEBIT ELECTRIC', -20000, 'expense'], ['ביטול עסקה', -1000, 'expense'],
      ['ישראכרט', -250000, 'card-settlement'], ['מקס איט פיננסים', -180000, 'card-settlement'], ['לאומי קארד', -90000, 'card-settlement'],
      ['חיוב כרטיס ויזה', -120000, 'card-settlement'], ['חיוב כרטיס אשראי', -250000, 'card-settlement'], ['תשלום כרטיסי אשראי', -90000, 'card-settlement'],
      ['דמי כרטיס ישראכרט', -1500, 'expense'], ['עמלת כרטיס', -900, 'expense'], ['MAX STOCK', -4000, 'expense'], ['מקס סטוק', -4000, 'expense'],
      ['העברה בביט', -5000, 'transfer'], ['Bit transfer', -5000, 'transfer'], ['פייבוקס', -2000, 'transfer'],
      ['שכר דירה', 500000, 'income', 'הכנסה אחרת'], ['משכורת אוקטובר', 1200000, 'income', 'הכנסה'], ['שכר עבודה', 1200000, 'income', 'הכנסה'],
      ['החזר כספי', 2000, 'refund'], ['ריבית חובה', -500, 'loan-interest'],
    ];
    for (const [d, a, kind, category] of cases) {
      const r = classify(d, a);
      expect(r.kind, d).toBe(kind);
      if (category) expect(r.category, d).toBe(category);
    }
  });
});

describe('B4 · migration v4', () => {
  it('rows the older importer stored as NIS become ILS, so budgets keep counting them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monohq-v3-'));
    const legacy = new DatabaseSync(join(dir, 'mono.db'));
    legacy.exec('CREATE TABLE schema_version (v INTEGER NOT NULL)');
    legacy.exec(MIGRATIONS[0] as string);
    (MIGRATIONS[1] as (db: DatabaseSync) => void)(legacy);
    (MIGRATIONS[2] as (db: DatabaseSync) => void)(legacy);
    legacy.prepare('INSERT INTO schema_version (v) VALUES (3)').run();
    legacy.prepare(`INSERT INTO transactions (id, ref_hash, date, description, amount_agorot, currency, account, category, kind, flag, source, batch_id, created_at)
      VALUES ('t1','h1',?, 'שופרסל', -5000, 'NIS', 'עו"ש', 'מכולת', 'expense', 'reported', 'csv-import', 'b1', ?)`).run(today, new Date().toISOString());
    legacy.close();
    const db = openDb(dir);
    expect(db.prepare('SELECT currency FROM transactions').all()).toEqual([{ currency: 'ILS' }]);
    db.close();
  });
});

describe('B7 · GUARDIAN checks the budget against the ledger, not against itself', () => {
  it('reports a mismatch when the budget view disagrees with the ledger', async () => {
    const app = makeApp();
    app.money.import(`date,description,amount\n${today},שופרסל,-50.00\n`, 'עו"ש');
    const t1 = app.orch.enqueue({ workflow: 'daily-money-check', origin: 'user' });
    await settled(app, t1.id);
    expect(app.reports.list(false)[0]!.markdown).toMatch(/בדיקת סכומי קטגוריות: תקינה/);
    const real = app.money.view.bind(app.money);
    app.money.view = (now?: Date) => { const v = real(now); return { ...v, budget: v.budget.map((b) => ({ ...b, spentAgorot: b.spentAgorot + 100 })) }; };
    const t2 = app.orch.enqueue({ workflow: 'daily-money-check', origin: 'user', dedupKey: 'second' });
    await settled(app, t2.id);
    expect(app.reports.list(false)[0]!.markdown).toMatch(/בדיקת סכומי קטגוריות: נכשלה/); // could never fail before the fix
    app.close();
  });
});

describe('B8–B9 · demo stays a demo', () => {
  it('B8 · user controls refuse demo tasks and write no real event', async () => {
    const app = makeApp();
    app.demo.start();
    const demoTask = await waitFor(() => app.tasks.list({ demo: true, limit: 10 })[0]);
    const before = app.bus.list({ after: 0, limit: 500, demo: false }).length;
    for (const act of ['cancel', 'pause', 'resume', 'retry'] as const) expect(() => app.orch[act](demoTask.id), act).toThrow(/הדגמה/);
    expect(app.bus.list({ after: 0, limit: 500, demo: false })).toHaveLength(before);
    app.demo.stop(); app.close();
  });
  it('B9 · in demo mode real writes are refused, the emergency stop still engages, and no real approval is listed', async () => {
    const { app, post, get } = await boot(null);
    app.money.import(`date,description,amount\n${today},Coffee Shop,-12.00\n${today},Coffee Shop,-12.00\n`, 'עו"ש');
    app.orch.enqueue({ workflow: 'resolve-duplicates', origin: 'user' }); // a real pending approval
    expect((await post('/api/system/dry-run?mode=demo', { on: false, confirm: true })).status).toBe(409);
    expect((await post('/api/system/limits?mode=demo', { maxDailyCostUsd: 1 })).status).toBe(409);
    expect((await post(`/api/approvals/${app.orch.pendingApprovals()[0]!.id}/approve?mode=demo`, {})).status).toBe(409);
    expect((await post('/api/automations/daily-money-check/enable?mode=demo', { confirm: true })).status).toBe(409);
    expect((await post('/api/system/kill-switch?mode=demo', { on: true })).status).toBe(200);
    expect((await post('/api/system/kill-switch?mode=demo', { on: false })).status).toBe(409);
    expect((await post('/api/demo/start?mode=demo', {})).status).toBe(200);
    expect(await (await get('/api/approvals?mode=demo')).json()).toEqual([]);
    expect((await (await get('/api/state?mode=demo')).json()).pendingApprovals).toEqual([]);
    expect(await (await get('/api/approvals')).json()).toHaveLength(1); // real mode still sees it
    app.demo.stop();
  });
});

describe('Security follow-ups fixed in the same round', () => {
  it('the demo-mode gate runs after authentication: an anonymous demo write gets 401, not a body read and a 409', async () => {
    const { post } = await boot(TOKEN);
    expect((await post('/api/system/dry-run?mode=demo', { on: false, confirm: true })).status).toBe(401);
    expect((await post('/api/system/kill-switch?mode=demo', { on: true })).status).toBe(401);
  });
  it('writes need exactly application/json (no preflight-free text/plain trick)', async () => {
    const { post } = await boot(null);
    expect((await post('/api/system/kill-switch', { on: true }, { 'content-type': 'text/plain; x=application/json' })).status).toBe(415);
    expect((await post('/api/system/kill-switch', { on: true }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post('/api/system/kill-switch', { on: true }, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
  });
  it('only listed dev origins may write from another port', async () => {
    const { post } = await boot(null, { MONO_DEV_ORIGINS: 'http://127.0.0.1:5173, https://evil.example:5173' });
    expect((await post('/api/system/kill-switch', { on: true }, { origin: 'http://127.0.0.1:5173' })).status).toBe(200);
    expect((await post('/api/system/kill-switch', { on: true }, { origin: 'http://localhost:5173' })).status).toBe(403);
    expect((await post('/api/system/kill-switch', { on: true }, { origin: 'https://evil.example:5173' })).status).toBe(403); // non-loopback entries are ignored
  });
  it('parallel wrong tokens each use up an attempt', async () => {
    const { post } = await boot(TOKEN);
    const statuses = await Promise.all(Array.from({ length: 8 }, () => post('/api/login', { token: 'wrong-token-wrong-token' }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3); // all 8 used to get through as 401s
  });
  it('the project deny list keeps agents out of env files, data, databases (incl. WAL/SHM journals) and exports', () => {
    const deny = (JSON.parse(readFileSync(`${root}.claude/settings.json`, 'utf8')) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toEqual([
      'Read(./.env)', 'Read(./.env.*)', 'Read(./**/.env)', 'Read(./**/.env.*)', 'Read(./MONO-HQ/data/**)', 'Read(./data/**)',
      'Read(./imports/**)', 'Read(./**/*.db)', 'Read(./**/*.sqlite*)', 'Read(./**/*.csv)', 'Read(./**/*.db-wal)', 'Read(./**/*.db-shm)',
    ]);
  });
});
