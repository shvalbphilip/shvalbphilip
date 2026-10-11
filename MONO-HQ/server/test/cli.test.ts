import { chmodSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_IDS, type AgentId } from '../../shared/contract.ts';
import { ClaudeCliRunner, childEnv, isRequiredModel, toolSurfaceViolation, toolsForAgent, verifyModelStatus, versionAtLeast } from '../src/ai.ts';

const fake = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
chmodSync(fake, 0o755);
const tmp = mkdtempSync(join(tmpdir(), 'monohq-'));
const run = (env: Record<string, string>, over: { timeoutMs?: number; signal?: AbortSignal; bin?: string; agentId?: AgentId } = {}) => {
  Object.assign(process.env, { FAKE_MODE: 'ok', FAKE_MODEL: 'claude-sonnet-5-5', FAKE_ARGS_FILE: join(tmp, 'args.jsonl'), FAKE_COST: '0.04' }, env);
  for (const k of ['FAKE_RESULT_MODEL', 'FAKE_EXTRA_TOOLS', 'FAKE_MCP', 'FAKE_NO_TOOL_LIST']) if (!env[k]) delete process.env[k];
  const tools: string[] = [];
  return new ClaudeCliRunner(over.bin ?? fake, tmp).run({ agentId: over.agentId ?? 'scout', prompt: 'hi', maxBudgetUsd: 0.3, timeoutMs: over.timeoutMs ?? 5000, onTool: (n) => tools.push(`${n.phase}:${n.toolName}:${n.host ?? ''}`) }, over.signal ?? new AbortController().signal).then((r) => ({ r, tools }));
};
const lastArgs = (): string[] => JSON.parse(readFileSync(join(tmp, 'args.jsonl'), 'utf8').trim().split('\n').pop()!).args;
const flag = (args: string[], name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

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
    const host = { MONO_ACCESS_TOKEN: 'super-secret-token-value', CLAUDE_AGENT_SDK_VERSION: '0.3.295', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-placeholder' };
    const saved = Object.fromEntries(Object.keys(process.env).filter((k) => /^CLAUDE/.test(k)).map((k) => [k, process.env[k]]));
    for (const k of Object.keys(saved)) delete process.env[k];
    Object.assign(process.env, host);
    const { r, tools } = await run({});
    for (const k of Object.keys(host)) delete process.env[k];
    Object.assign(process.env, saved);
    expect(r.ok).toBe(true); expect(r.costUsd).toBeCloseTo(0.04); expect(r.observedModels).toEqual(['claude-sonnet-5-5']);
    expect(tools).toEqual(['started:WebFetch:www.boi.org.il', 'completed:WebFetch:']);
    const rec = JSON.parse(readFileSync(join(tmp, 'args.jsonl'), 'utf8').trim().split('\n').pop()!);
    expect(rec.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--model', 'claude-sonnet-5-5', '--agent', 'scout', '--max-budget-usd', '0.3', '--no-session-persistence']));
    expect(rec.args).not.toContain('--fallback-model');
    // isolation from the operator's own Claude Code setup (user hooks, plugins, allow rules, MCP servers, skills)
    expect(flag(rec.args, '--setting-sources')).toBe('project');
    expect(rec.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--disable-slash-commands']));
    expect(rec.args).not.toContain('--mcp-config');
    expect(rec.args.join(' ')).not.toMatch(/Bash|Edit|Write/);
    // host Claude session markers are dropped (CLAUDE_AGENT_SDK_VERSION caused a background Haiku call on 2.1.296); auth is kept
    expect(rec.env).toEqual({ sub: 'claude-sonnet-5-5', force: '1', token: null, claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'] });
  });
  it('passes a per-agent tool list: scout web-only, mono none at all, others read-only file tools', async () => {
    await run({}, { agentId: 'scout' });
    let a = lastArgs();
    expect(flag(a, '--tools')).toBe('WebSearch,WebFetch'); expect(flag(a, '--allowedTools')).toBe('WebSearch,WebFetch');
    await run({}, { agentId: 'mono' });
    a = lastArgs();
    expect(flag(a, '--tools')).toBe(''); expect(a).not.toContain('--allowedTools'); // `--tools ""` disables every built-in tool
    expect(flag(a, '--agent')).toBe('mono');
    for (const agent of ['guardian', 'ledger', 'radar'] as const) {
      await run({}, { agentId: agent });
      a = lastArgs();
      expect(flag(a, '--tools'), agent).toBe('Read,Glob,Grep');
      // a bare `Read` allow rule would approve reads anywhere on disk; unlisted, reads stay inside the working directory
      expect(a, agent).not.toContain('--allowedTools');
      expect(a.join(' ')).not.toMatch(/WebSearch|WebFetch|Bash|Edit|Write/);
    }
  });
  it('fails closed when the CLI reports any tool or MCP server beyond the agent allowlist', async () => {
    // observed on CLI 2.1.296: an agent file with a `tools:` line re-added Glob/Grep to `--tools ""` for mono
    expect((await run({ FAKE_EXTRA_TOOLS: 'Glob,Grep' }, { agentId: 'mono' })).r).toMatchObject({ ok: false, failure: 'tool-mismatch', text: '' });
    expect((await run({ FAKE_EXTRA_TOOLS: 'Write' }, { agentId: 'guardian' })).r).toMatchObject({ ok: false, failure: 'tool-mismatch' });
    expect((await run({ FAKE_MCP: 'composio' }, { agentId: 'scout' })).r).toMatchObject({ ok: false, failure: 'tool-mismatch' });
    expect((await run({ FAKE_NO_TOOL_LIST: '1' }, { agentId: 'scout' })).r).toMatchObject({ ok: false, failure: 'tool-mismatch' });
    expect((await run({}, { agentId: 'mono' })).r.ok).toBe(true);
  });
  it('childEnv keeps credentials only: no host session markers, model overrides or base-URL redirects', () => {
    const env = childEnv({
      PATH: '/bin', HOME: '/h', MONO_ACCESS_TOKEN: 't', CLAUDECODE: '1', CLAUDE_AGENT_SDK_VERSION: '0.3', CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a',
      ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_MODEL: 'claude-opus-5-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x', ANTHROPIC_SMALL_FAST_MODEL: 'y',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-5-5',
    });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH']);
    expect(env).toMatchObject({ CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5-5', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  });
  it('toolSurfaceViolation accepts exactly the allowlist, in any order', () => {
    expect(toolSurfaceViolation('mono', { tools: [], mcp_servers: [] })).toBeNull();
    expect(toolSurfaceViolation('scout', { tools: ['WebFetch', 'WebSearch'], mcp_servers: [] })).toBeNull();
    expect(toolSurfaceViolation('ledger', { tools: ['Grep', 'Read', 'Glob'] })).toBeNull();
    expect(toolSurfaceViolation('ledger', { tools: ['Read', 'Glob', 'Grep', 'Bash'] })).toMatch(/Bash/);
    expect(toolSurfaceViolation('scout', { tools: ['WebSearch', 'WebFetch', 'Glob', 'Grep'] })).toMatch(/Glob, Grep/);
    expect(toolSurfaceViolation('mono', {})).toMatch(/tool list/);
    expect(toolSurfaceViolation('mono', { tools: [], mcp_servers: 'composio' })).toMatch(/MCP/);
  });
  it('.claude/agents/*.md declare exactly the tools the CLI enforces, and no agent memory', () => {
    for (const agent of AGENT_IDS) {
      const md = readFileSync(new URL(`../../../.claude/agents/${agent}.md`, import.meta.url), 'utf8');
      const fm = md.split('---')[1]!;
      const line = /^tools:(.*)$/m.exec(fm)?.[1]?.trim();
      expect(line, agent).toBeDefined(); // a missing tools line means "inherit every tool"
      const declared = line === '[]' ? [] : line!.split(',').map((t) => t.trim()).filter(Boolean);
      expect(declared.sort(), agent).toEqual(toolsForAgent(agent).split(',').filter(Boolean).sort());
      expect(fm, agent).not.toMatch(/^memory:/m);
      expect(fm, agent).toMatch(/^model: claude-sonnet-5-5$/m);
    }
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
