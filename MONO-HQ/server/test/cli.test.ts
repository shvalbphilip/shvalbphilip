import { chmodSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCliRunner, isRequiredModel, verifyModelStatus, versionAtLeast } from '../src/ai.ts';

const fake = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
chmodSync(fake, 0o755);
const tmp = mkdtempSync(join(tmpdir(), 'monohq-'));
const run = (env: Record<string, string>, over: { timeoutMs?: number; signal?: AbortSignal; bin?: string } = {}) => {
  Object.assign(process.env, { FAKE_MODE: 'ok', FAKE_MODEL: 'claude-sonnet-5-5', FAKE_RESULT_MODEL: '', FAKE_ARGS_FILE: join(tmp, 'args.jsonl'), FAKE_COST: '0.04' }, env);
  if (!env.FAKE_RESULT_MODEL) delete process.env.FAKE_RESULT_MODEL;
  const tools: string[] = [];
  return new ClaudeCliRunner(over.bin ?? fake, tmp).run({ agentId: 'scout', prompt: 'hi', maxBudgetUsd: 0.3, timeoutMs: over.timeoutMs ?? 5000, onTool: (n) => tools.push(`${n.phase}:${n.toolName}:${n.host ?? ''}`) }, over.signal ?? new AbortController().signal).then((r) => ({ r, tools }));
};

describe('model identity', () => {
  it('accepts only claude-sonnet-5-5 (optionally with a context suffix)', () => {
    expect(isRequiredModel('claude-sonnet-5-5')).toBe(true);
    expect(isRequiredModel('claude-sonnet-5-5[1m]')).toBe(true);
    for (const m of ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-50', 'claude-sonnet-4-5', '']) expect(isRequiredModel(m)).toBe(false);
  });
  it('compares CLI versions', () => { expect(versionAtLeast('2.1.296', '2.1.257')).toBe(true); expect(versionAtLeast('2.1.256', '2.1.257')).toBe(false); expect(versionAtLeast('3.0.0', '2.9.9')).toBe(true); });
});

describe('Claude CLI adapter (against a fake claude binary)', () => {
  it('passes the required flags, never a fallback model, pins the subagent model and strips our access token', async () => {
    process.env.MONO_ACCESS_TOKEN = 'super-secret-token-value';
    const { r, tools } = await run({});
    delete process.env.MONO_ACCESS_TOKEN;
    expect(r.ok).toBe(true); expect(r.costUsd).toBeCloseTo(0.04); expect(r.observedModels).toEqual(['claude-sonnet-5-5']);
    expect(tools).toEqual(['started:WebFetch:www.boi.org.il', 'completed:WebFetch:']);
    const rec = JSON.parse(readFileSync(join(tmp, 'args.jsonl'), 'utf8').trim().split('\n').pop()!);
    expect(rec.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--model', 'claude-sonnet-5-5', '--agent', 'scout', '--max-budget-usd', '0.3', '--no-session-persistence']));
    expect(rec.args).not.toContain('--fallback-model');
    expect(rec.args.join(' ')).not.toMatch(/Bash|Edit|Write/);
    expect(rec.env).toEqual({ sub: 'claude-sonnet-5-5', force: '1', token: null });
  });
  it('kills the run and fails when the session model is not Sonnet 5.5 (no silent fallback)', async () => {
    const { r } = await run({ FAKE_MODEL: 'claude-opus-5-5' });
    expect(r).toMatchObject({ ok: false, failure: 'model-mismatch' });
  });
  it('fails when a different model shows up only in the usage breakdown (e.g. a downgraded subagent)', async () => {
    const { r } = await run({ FAKE_RESULT_MODEL: 'claude-haiku-5-5' });
    expect(r).toMatchObject({ ok: false, failure: 'model-mismatch' });
  });
  it('reports a missing CLI, a crash, a timeout and a user cancel distinctly', async () => {
    expect((await run({}, { bin: '/nonexistent/claude' })).r.failure).toBe('cli-missing');
    expect((await run({ FAKE_MODE: 'crash' })).r.failure).toBe('cli-error');
    expect((await run({ FAKE_MODE: 'hang' }, { timeoutMs: 300 })).r.failure).toBe('timeout');
    const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
    expect((await run({ FAKE_MODE: 'hang' }, { signal: ac.signal })).r.failure).toBe('cancelled');
  });
  it('verifyModelStatus: no billable call in dry-run; verified only when the real run reports the right model', async () => {
    const runner = new ClaudeCliRunner(fake, tmp);
    process.env.FAKE_ARGS_FILE = join(tmp, 'verify.jsonl');
    const dry = await verifyModelStatus(runner, { dryRun: true, killSwitch: false, maxBudgetUsd: 0.05 });
    expect(dry.status).toBe('dry-run-skipped'); expect(existsSync(join(tmp, 'verify.jsonl'))).toBe(false);
    process.env.FAKE_MODE = 'ok'; process.env.FAKE_MODEL = 'claude-sonnet-5-5'; delete process.env.FAKE_RESULT_MODEL;
    expect((await verifyModelStatus(runner, { dryRun: false, killSwitch: false, maxBudgetUsd: 0.05 })).status).toBe('verified');
    process.env.FAKE_MODEL = 'claude-opus-5-5';
    expect((await verifyModelStatus(runner, { dryRun: false, killSwitch: false, maxBudgetUsd: 0.05 })).status).toBe('failed');
    process.env.FAKE_VERSION = '2.1.100'; process.env.FAKE_MODEL = 'claude-sonnet-5-5';
    expect((await verifyModelStatus(runner, { dryRun: false, killSwitch: false, maxBudgetUsd: 0.05 })).status).toBe('failed');
    delete process.env.FAKE_VERSION;
    expect((await verifyModelStatus(new ClaudeCliRunner('/nonexistent/claude', tmp), { dryRun: true, killSwitch: false, maxBudgetUsd: 0.05 })).status).toBe('cli-missing');
  });
});
