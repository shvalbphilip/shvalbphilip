import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { toolsForAgent } from '../src/ai.ts';
import { createApp, type App } from '../src/app.ts';
import { AUDIT_GENESIS, auditHash, verifyAuditChain } from '../src/audit.ts';
import { loadConfig } from '../src/config.ts';
import { MIGRATIONS, openDb } from '../src/db.ts';
import { MAX_SSE_CLIENTS, allowedHosts, createHttpServer, hostnameOf } from '../src/http.ts';
import { redactDeep } from '../src/reports.ts';
import { SessionStore } from '../src/sessions.ts';
import { makeApp } from './helpers.ts';

const TOKEN = 'a-long-enough-test-token-123';
const root = new URL('../../..', import.meta.url).pathname;
let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

async function boot(token: string | null, host = '127.0.0.1') {
  const cfg = loadConfig({ MONO_HOST: host, ...(token ? { MONO_ACCESS_TOKEN: token } : {}) } as NodeJS.ProcessEnv);
  const app: App = createApp({ cfg, dataDir: ':memory:', startScheduler: false, demoStepMs: 5 });
  const dist = mkdtempSync(join(tmpdir(), 'dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>MONO</title>');
  const server = createHttpServer(app, dist);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  cleanup.push(() => { server.closeAllConnections(); server.close(); app.close(); });
  const j = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const login = async () => {
    const r = await j('/api/login', { method: 'POST', body: JSON.stringify({ token }) });
    expect(r.status).toBe(200);
    return r.headers.get('set-cookie')!;
  };
  return { app, base, port, j, login };
}
/** fetch() silently drops a custom Host header, so Host-spoofing tests go through node:http with setHost=false. */
function raw(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, setHost: false, headers: { 'content-type': 'application/json', ...(o.headers ?? {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (d: string) => { text += d; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(o.body);
  });
}
const cookiePair = (setCookie: string) => setCookie.split(';')[0]!;
const sessionIdOf = (setCookie: string) => cookiePair(setCookie).split('=')[1]!;

/* ------------------------------------------------------------------ 1. Host allowlist */
describe('1. Host-header allowlist (DNS-rebinding defence)', () => {
  it('parses hosts with optional ports and IPv6 brackets', () => {
    expect(hostnameOf('127.0.0.1:8787')).toBe('127.0.0.1');
    expect(hostnameOf('LocalHost')).toBe('localhost');
    expect(hostnameOf('[::1]:8787')).toBe('[::1]');
    expect(hostnameOf('evil.example')).toBe('evil.example');
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf('bad host')).toBeNull();
    expect([...allowedHosts('100.64.0.5')]).toEqual(['127.0.0.1', 'localhost', '[::1]', '100.64.0.5']);
    expect(allowedHosts('fd7a::5').has('[fd7a::5]')).toBe(true);
  });
  it('answers 421 before routing for any other Host, on API and static paths alike', async () => {
    const { port } = await boot(null);
    for (const host of ['evil.example', 'evil.example:80', '127.0.0.1.evil.example', '']) {
      const r = await raw(port, { path: '/api/state', headers: { host } });
      expect(r.status, `host=${host}`).toBe(421);
      expect(JSON.parse(r.text)).toEqual({ error: 'misdirected request: unknown Host' });
    }
    expect((await raw(port, { path: '/', headers: { host: 'evil.example' } })).status).toBe(421);
    expect((await raw(port, { method: 'POST', path: '/api/login', body: '{}', headers: { host: 'evil.example' } })).status).toBe(421);
    expect((await raw(port, { path: '/api/state', headers: { host: `127.0.0.1:${port}` } })).status).toBe(200); // sanity: the raw helper itself works
  });
  it('accepts 127.0.0.1, localhost, [::1] and the configured MONO_HOST, each with or without a port', async () => {
    const { port } = await boot(TOKEN, '100.64.0.5');
    for (const host of [`127.0.0.1:${port}`, 'localhost', `localhost:${port}`, '[::1]', '[::1]:8787', '100.64.0.5', '100.64.0.5:8787', 'LOCALHOST']) {
      expect((await raw(port, { path: '/api/auth', headers: { host } })).status, `host=${host}`).toBe(200);
    }
    expect((await raw(port, { path: '/api/auth', headers: { host: '100.64.0.6' } })).status).toBe(421);
  });
  it('checks Origin against the allowlist, not against the incoming Host header', async () => {
    const { j, port } = await boot(null);
    const body = '{"on":true}';
    // Origin matches Host exactly but neither is allowed → still rejected (by the host check)
    expect((await raw(port, { method: 'POST', path: '/api/system/kill-switch', body, headers: { host: 'evil.example', origin: 'http://evil.example' } })).status).toBe(421);
    // allowed Host, foreign Origin → blocked
    expect((await j('/api/system/kill-switch', { method: 'POST', body, headers: { origin: 'http://attacker.test' } })).status).toBe(403);
    expect((await j('/api/system/kill-switch', { method: 'POST', body, headers: { origin: 'null' } })).status).toBe(403);
    // allowed Origin on a different port (e.g. the Vite dev server proxy) → allowed
    expect((await j('/api/system/kill-switch', { method: 'POST', body, headers: { origin: 'http://localhost:5173' } })).status).toBe(200);
    expect((await j('/api/system/kill-switch', { method: 'POST', body, headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
    // login is a mutation too: a cross-site login form must not be able to set our cookie
    expect((await j('/api/login', { method: 'POST', body: '{}', headers: { origin: 'http://attacker.test' } })).status).toBe(403);
  });
});

/* ------------------------------------------------------------------ 2. Per-agent tools */
describe('2. Per-agent tool allowlists', () => {
  it('mono gets no tools, scout only the web tools, everyone else read-only file tools', () => {
    expect(toolsForAgent('mono')).toBe('');
    expect(toolsForAgent('scout')).toBe('WebSearch,WebFetch');
    for (const a of ['ledger', 'flow', 'credit', 'budget', 'radar', 'guardian'] as const) expect(toolsForAgent(a)).toBe('Read,Glob,Grep');
    for (const a of ['mono', 'scout', 'ledger', 'guardian'] as const) expect(toolsForAgent(a)).not.toMatch(/Bash|Edit|Write|mcp/i);
  });
  it('the SCOUT prompt restricts fetching to gov.il / boi.org.il and the server still validates URLs', async () => {
    const { WORKFLOWS } = await import('../src/workflows.ts');
    const prompt = WORKFLOWS['israel-finance-research']!.steps[0]!.prompt!({} as never);
    expect(prompt).toMatch(/WebFetch ONLY pages whose host is gov\.il, boi\.org\.il/);
    expect(prompt).toMatch(/never fetch any other site/);
    const app = makeApp();
    const r = app.research.ingest('t1', JSON.stringify({ items: [
      { titleHe: 'ריבית', summaryHe: 'הודעה', sourceUrl: 'https://www.boi.org.il/x', sourceName: 'בנק ישראל' },
      { titleHe: 'אתר זר', summaryHe: 'משהו', sourceUrl: 'https://news.example.com/x', sourceName: 'חדשות' },
      { titleHe: 'לא מאובטח', summaryHe: 'משהו', sourceUrl: 'http://www.gov.il/x', sourceName: 'gov' },
    ] }));
    expect(r).toEqual({ stored: 2, rejected: 1, official: 1 });
    expect(app.research.list().map((i) => i.reliability).sort()).toEqual(['official', 'unverified']);
    app.close();
  });
});

/* ------------------------------------------------------------------ 3. Sessions */
describe('3. Random server-side sessions', () => {
  it('login issues a random 256-bit id; the DB stores only its hash; lookups honour revocation and expiry', async () => {
    const { app, j, login } = await boot(TOKEN);
    const c1 = await login(); const c2 = await login();
    const id1 = sessionIdOf(c1), id2 = sessionIdOf(c2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/); expect(id2).toMatch(/^[0-9a-f]{64}$/); expect(id1).not.toBe(id2);
    expect(c1).not.toContain(TOKEN);
    const rows = app.db.prepare('SELECT id_hash FROM sessions').all() as Array<{ id_hash: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id_hash)).not.toContain(id1);
    expect((await j('/api/state', { headers: { cookie: cookiePair(c1) } })).status).toBe(200);
    expect((await (await j('/api/auth', { headers: { cookie: cookiePair(c1) } })).json())).toEqual({ required: true, authenticated: true });
    // tampered / foreign ids never authenticate
    expect((await j('/api/state', { headers: { cookie: `mono_session=${'f'.repeat(64)}` } })).status).toBe(401);
    expect((await j('/api/state', { headers: { cookie: `mono_session=${id1.slice(0, 63)}0` } })).status).toBe(401);
    expect((await j('/api/state', { headers: { cookie: 'mono_session=not-hex' } })).status).toBe(401);
    // logout revokes only the current session and clears the cookie
    const out = await j('/api/logout', { method: 'POST', body: '{}', headers: { cookie: cookiePair(c1) } });
    expect(out.status).toBe(200); expect(out.headers.get('set-cookie')).toMatch(/mono_session=;.*Max-Age=0/);
    expect((await j('/api/state', { headers: { cookie: cookiePair(c1) } })).status).toBe(401);
    expect((await j('/api/state', { headers: { cookie: cookiePair(c2) } })).status).toBe(200);
    // revoke-all kills every remaining session
    const c3 = await login();
    const all = await j('/api/sessions/revoke-all', { method: 'POST', body: '{}', headers: { cookie: cookiePair(c2) } });
    expect(await all.json()).toEqual({ ok: true, revoked: 2 });
    expect((await j('/api/state', { headers: { cookie: cookiePair(c2) } })).status).toBe(401);
    expect((await j('/api/state', { headers: { cookie: cookiePair(c3) } })).status).toBe(401);
    expect(app.system().auditLog.map((a) => a.action)).toEqual(expect.arrayContaining(['session.login', 'session.logout', 'session.revoke-all']));
  });
  it('sessions expire after 30 days and expired rows are pruned', () => {
    const app = makeApp();
    const store = new SessionStore(app.db);
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const s = store.create(t0);
    expect(Date.parse(s.expiresAt) - t0).toBe(30 * 86_400_000);
    expect(store.validate(s.id, t0 + 29 * 86_400_000)).toBe(true);
    expect(store.validate(s.id, t0 + 30 * 86_400_000 + 1)).toBe(false);
    store.create(t0 + 61 * 86_400_000); // a later login prunes rows that expired more than a TTL ago
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    app.close();
  });
  it('logout and revoke-all are unauthenticated-safe and no-ops in loopback mode', async () => {
    const { j } = await boot(TOKEN);
    expect((await j('/api/logout', { method: 'POST', body: '{}' })).status).toBe(401);
    const { j: open } = await boot(null);
    expect(await (await open('/api/sessions/revoke-all', { method: 'POST', body: '{}' })).json()).toEqual({ ok: true, revoked: 0 });
  });
});

/* ------------------------------------------------------------------ 4. Secure cookie */
describe('4. Secure cookie whenever a token is configured', () => {
  it('sets Secure (plus HttpOnly, SameSite=Strict, 30-day Max-Age) without relying on x-forwarded-proto', async () => {
    const { login, j } = await boot(TOKEN);
    const c = await login();
    expect(c).toMatch(/; Secure/); expect(c).toMatch(/HttpOnly/); expect(c).toMatch(/SameSite=Strict/); expect(c).toMatch(/Max-Age=2592000/);
    const out = await j('/api/logout', { method: 'POST', body: '{}', headers: { cookie: cookiePair(c) } });
    expect(out.headers.get('set-cookie')).toMatch(/; Secure/);
  });
  it('issues no session cookie at all in loopback mode', async () => {
    const { j } = await boot(null);
    const r = await j('/api/login', { method: 'POST', body: '{}' });
    expect(r.status).toBe(200); expect(r.headers.get('set-cookie')).toBeNull();
  });
});

/* ------------------------------------------------------------------ 5. Step-up */
describe('5. Step-up authentication for sensitive actions', () => {
  it('with a token: DRY_RUN off, kill-switch release and raising ceilings need the token in the body', async () => {
    const { app, j, login } = await boot(TOKEN);
    const h = { cookie: cookiePair(await login()) };
    const post = (p: string, b: unknown) => j(p, { method: 'POST', body: JSON.stringify(b), headers: h });
    expect((await post('/api/system/dry-run', { on: false, confirm: true })).status).toBe(403);
    expect((await post('/api/system/dry-run', { on: false, confirm: true, token: 'wrong' })).status).toBe(403);
    expect(app.guard.get().dryRun).toBe(true);
    expect((await post('/api/system/dry-run', { on: false, confirm: true, token: TOKEN })).status).toBe(200);
    expect(app.guard.get().dryRun).toBe(false);
    expect((await post('/api/system/dry-run', { on: true })).status).toBe(200); // turning dry-run back ON never needs step-up
    expect((await post('/api/system/kill-switch', { on: true })).status).toBe(200); // engaging never needs step-up
    expect((await post('/api/system/kill-switch', { on: false })).status).toBe(403);
    expect(app.guard.get().killSwitch).toBe(true);
    expect((await post('/api/system/kill-switch', { on: false, token: TOKEN })).status).toBe(200);
    expect(app.guard.get().killSwitch).toBe(false);
    for (const k of ['maxDailyCostUsd', 'maxMonthlyCostUsd', 'maxConcurrentAiJobs'] as const) {
      const cur = app.guard.get()[k];
      expect((await post('/api/system/limits', { [k]: cur + 1 })).status, `raise ${k}`).toBe(403);
      expect(app.guard.get()[k]).toBe(cur);
      expect((await post('/api/system/limits', { [k]: cur - 1 })).status, `lower ${k}`).toBe(200);
      expect((await post('/api/system/limits', { [k]: cur + 1, token: TOKEN })).status, `raise ${k} with token`).toBe(200);
      expect(app.guard.get()[k]).toBe(cur + 1);
    }
    expect((await post('/api/system/limits', { maxRetries: 3, maxJobMinutes: 30 })).status).toBe(200); // not cost-bearing: no step-up
  });
  it('wrong step-up tokens are rate limited like login attempts', async () => {
    const { j, login } = await boot(TOKEN);
    const h = { cookie: cookiePair(await login()) };
    for (let i = 0; i < 5; i++) expect((await j('/api/system/kill-switch', { method: 'POST', body: '{"on":false,"token":"nope"}', headers: h })).status).toBe(403);
    expect((await j('/api/system/kill-switch', { method: 'POST', body: `{"on":false,"token":"${TOKEN}"}`, headers: h })).status).toBe(429);
  });
  it('without a token (loopback-only): confirm:true still gates DRY_RUN off and nothing else asks for a token', async () => {
    const { app, j } = await boot(null);
    expect((await j('/api/system/dry-run', { method: 'POST', body: '{"on":false}' })).status).toBe(400);
    expect((await j('/api/system/dry-run', { method: 'POST', body: '{"on":false,"confirm":true}' })).status).toBe(200);
    expect((await j('/api/system/kill-switch', { method: 'POST', body: '{"on":true}' })).status).toBe(200);
    expect((await j('/api/system/kill-switch', { method: 'POST', body: '{"on":false}' })).status).toBe(200);
    expect((await j('/api/system/limits', { method: 'POST', body: '{"maxDailyCostUsd":5}' })).status).toBe(200);
    expect(app.guard.get()).toMatchObject({ dryRun: false, killSwitch: false, maxDailyCostUsd: 5 });
  });
});

/* ------------------------------------------------------------------ 6. File permissions */
describe('6. Data directory and database permissions', () => {
  it.skipIf(process.platform === 'win32')('data dir is 0700 and mono.db (+WAL) are 0600', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'monohq-perm-')), 'data');
    const db = openDb(dir);
    db.exec("INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 'now')");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'mono.db')).mode & 0o777).toBe(0o600);
    for (const s of ['-wal', '-shm']) if (existsSync(join(dir, `mono.db${s}`))) expect(statSync(join(dir, `mono.db${s}`)).mode & 0o777, s).toBe(0o600);
    db.close();
    // re-opening tightens permissions that were loosened out of band
    chmodSync(dir, 0o755); chmodSync(join(dir, 'mono.db'), 0o644);
    openDb(dir).close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'mono.db')).mode & 0o777).toBe(0o600);
  });
});

/* ------------------------------------------------------------------ 7. SSE cap + headers */
describe('7. SSE connection cap and hardening headers', () => {
  it(`allows ${MAX_SSE_CLIENTS} live streams, answers 503 beyond, and frees the slot on close`, async () => {
    const { base } = await boot(null);
    const acs: AbortController[] = [];
    cleanup.push(() => acs.forEach((a) => a.abort()));
    const open = async () => { const ac = new AbortController(); acs.push(ac); const r = await fetch(`${base}/api/stream`, { signal: ac.signal }); return r; };
    for (let i = 0; i < MAX_SSE_CLIENTS; i++) expect((await open()).status).toBe(200);
    const over = await open();
    expect(over.status).toBe(503);
    expect(await over.json()).toEqual({ error: 'too many live connections' });
    acs[0]!.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect((await open()).status).toBe(200);
  });
  it('sends COOP / CORP / Permissions-Policy always and HSTS only when a token is configured', async () => {
    const open = await (await boot(null)).j('/api/state');
    expect(open.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(open.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(open.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(open.headers.get('strict-transport-security')).toBeNull();
    const locked = await (await boot(TOKEN)).j('/api/auth');
    expect(locked.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(locked.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });
});

/* ------------------------------------------------------------------ 8. Audit chain */
describe('8. Hash-chained audit log', () => {
  it('links every entry to its predecessor from a fixed genesis and reports validity in SystemView', () => {
    const app = makeApp();
    expect(verifyAuditChain(app.db)).toEqual({ valid: true, entries: 0 });
    app.guard.update({ maxDailyCostUsd: 3 }, 'user');
    app.guard.audit('user', 'test.action', 'x'.repeat(600)); // detail is clipped, and the clipped value is what gets hashed
    app.guard.update({ dryRun: false }, 'user');
    const rows = app.db.prepare('SELECT at, actor, action, detail, prev_hash, hash FROM audit_log ORDER BY rowid').all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.prev_hash).toBe(AUDIT_GENESIS);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[1]!.detail).toHaveLength(500);
    for (const r of rows) expect(r.hash).toBe(auditHash(r.prev_hash!, r.at!, r.actor!, r.action!, r.detail!));
    expect(verifyAuditChain(app.db)).toEqual({ valid: true, entries: 3 });
    expect(app.system().auditChainValid).toBe(true);
    app.close();
  });
  it('is append-only at the database level, and detects tampering if the triggers are bypassed', () => {
    const app = makeApp();
    app.guard.update({ maxDailyCostUsd: 3 }, 'user');
    app.guard.update({ maxDailyCostUsd: 4 }, 'user');
    expect(() => app.db.exec("UPDATE audit_log SET detail = 'x'")).toThrow(/append-only/);
    expect(() => app.db.exec('DELETE FROM audit_log')).toThrow(/append-only/);
    app.db.exec('DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete');
    app.db.exec("UPDATE audit_log SET detail = '{\"maxDailyCostUsd\":400}' WHERE rowid = 1");
    const v = verifyAuditChain(app.db);
    expect(v.valid).toBe(false); expect(v.brokenAtId).toBe((app.db.prepare('SELECT id FROM audit_log WHERE rowid = 1').get() as { id: string }).id);
    expect(app.system().auditChainValid).toBe(false);
    app.db.exec("UPDATE audit_log SET detail = '{\"maxDailyCostUsd\":3}' WHERE rowid = 1");
    app.db.exec('DELETE FROM audit_log WHERE rowid = 2');
    expect(verifyAuditChain(app.db).valid).toBe(true); // truncation from the tail is undetectable by a chain alone — documented limitation
    app.close();
  });
  it('migration backfills a v1 database so pre-existing rows join the chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monohq-mig-'));
    const legacy = new DatabaseSync(join(dir, 'mono.db'));
    legacy.exec('CREATE TABLE schema_version (v INTEGER NOT NULL)');
    legacy.exec(MIGRATIONS[0] as string);
    legacy.prepare('INSERT INTO schema_version (v) VALUES (1)').run();
    legacy.prepare("INSERT INTO audit_log (id, at, actor, action, detail) VALUES ('a1','2026-01-01T00:00:00.000Z','user','x','1'), ('a2','2026-01-02T00:00:00.000Z','user','y','2')").run();
    legacy.close();
    const db = openDb(dir);
    expect(verifyAuditChain(db)).toEqual({ valid: true, entries: 2 });
    expect((db.prepare('SELECT prev_hash FROM audit_log WHERE id = ?').get('a1') as { prev_hash: string }).prev_hash).toBe(AUDIT_GENESIS);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    db.close();
  });
});

/* ------------------------------------------------------------------ 9. Supply chain & secrets */
describe('9. Supply-chain and secret scanning', () => {
  const pkg = JSON.parse(readFileSync(`${root}MONO-HQ/package.json`, 'utf8')) as { scripts: Record<string, string> };
  it('wires audit, secret-scan, typecheck, test and build into `npm run check`', () => {
    expect(pkg.scripts.audit).toBe('npm audit --audit-level=high');
    expect(pkg.scripts['secret-scan']).toBe('node scripts/secret-scan.mjs');
    for (const s of ['typecheck', 'test', 'build', 'audit', 'secret-scan']) expect(pkg.scripts.check).toContain(`npm run ${s}`.replace('npm run test', 'npm test'));
  });
  it('CI runs `npm ci && npm run check` on pull requests', () => {
    const ci = readFileSync(`${root}.github/workflows/ci.yml`, 'utf8');
    expect(ci).toMatch(/pull_request/); expect(ci).toMatch(/npm ci/); expect(ci).toMatch(/npm run check/); expect(ci).toMatch(/node-version: 22/);
  });
  it('the tracked tree is clean, and a planted key / IBAN / card number fails the scan', () => {
    const scan = `${root}MONO-HQ/scripts/secret-scan.mjs`;
    expect(execFileSync('node', [scan, root], { encoding: 'utf8' })).toMatch(/tracked files clean/);
    const repo = mkdtempSync(join(tmpdir(), 'monohq-scan-'));
    execFileSync('git', ['init', '-q', repo]);
    const planted = [
      ['key.txt', `token=${['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz'].join('-')}`],
      ['iban.md', ['IL62', '0108', '0000', '0009', '9999', '999'].join(' ')],
      ['card.csv', 'desc,card\nx,4111 1111 1111 1111'], // passes Luhn
      ['svg.tsx', '<path d="M82 92 C78 106 86 110 97 110" />'], // digit runs that are not a card: must NOT be flagged
      ['ok.ts', 'const ts = 1700000000123; const big = 4580123456789012;'], // 13+ digits failing Luhn: not flagged
    ] as const;
    for (const [f, text] of planted) writeFileSync(join(repo, f), text);
    execFileSync('git', ['-C', repo, 'add', '-A']);
    let out = '';
    try { execFileSync('node', [scan, repo], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = String((e as { stderr: string }).stderr); }
    expect(out).toMatch(/key\.txt:1: Anthropic API key/);
    expect(out).toMatch(/iban\.md:1: Israeli IBAN/);
    expect(out).toMatch(/card\.csv:2: payment card number/);
    expect(out).not.toMatch(/svg\.tsx|ok\.ts/);
    expect(out).toMatch(/3 finding/);
  });
});

/* ------------------------------------------------------------------ reports are redacted too */
describe('reports store redacted artifacts', () => {
  it('redacts markdown, title and nested string data before persisting', () => {
    const app = makeApp();
    const iban = ['IL62', '0108', '0000', '0009', '9999', '999'].join(' ');
    const r = app.reports.create({ kind: 'ad-hoc', titleHe: `דוח ${iban}`, taskId: null, isDemo: false, markdown: `חשבון ${iban} מייל a@b.co`, data: { note: `ת.ז. 123456789`, amount: 123456789, nested: [{ s: `כרטיס 4580 1234 5678 9012` }] } });
    expect(r.titleHe).not.toContain('IL62'); expect(r.markdown).not.toMatch(/IL62|a@b\.co/);
    const d = r.data as { note: string; amount: number; nested: Array<{ s: string }> };
    expect(d.note).not.toContain('123456789'); expect(d.amount).toBe(123456789); expect(d.nested[0]!.s).not.toContain('4580');
    expect(redactDeep(null)).toBeNull(); expect(redactDeep(7)).toBe(7);
    app.close();
  });
});
