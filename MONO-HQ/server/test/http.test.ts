import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpServer } from '../src/http.ts';
import { waitFor, ymd } from './helpers.ts';

const TOKEN = 'a-long-enough-test-token-123';
let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

async function boot(token: string | null) {
  const cfg = loadConfig({} as NodeJS.ProcessEnv);
  cfg.accessToken = token;
  const app: App = createApp({ cfg, dataDir: ':memory:', startScheduler: false, demoStepMs: 5 });
  const dist = mkdtempSync(join(tmpdir(), 'dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>MONO</title>');
  const server = createHttpServer(app, dist);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => { server.closeAllConnections(); server.close(); app.close(); });
  const j = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return { app, base, j };
}

describe('HTTP API', () => {
  it('serves the state snapshot with safe defaults and security headers', async () => {
    const { j } = await boot(null);
    const res = await j('/api/state');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const s = await res.json();
    expect(s.guardrails).toMatchObject({ dryRun: true, killSwitch: false });
    expect(s.agents).toHaveLength(8);
    expect(s.agents.every((a: { model: string; status: string; bubble: unknown }) => a.model === 'claude-sonnet-5-5' && a.status === 'idle' && a.bubble === null)).toBe(true);
    expect(s.model.status).toBe('unverified');
  });
  it('requires login when a token is configured; cookie is HttpOnly + SameSite=Strict; wrong tokens are rate limited', async () => {
    const { j } = await boot(TOKEN);
    expect((await j('/api/state')).status).toBe(401);
    expect((await (await j('/api/auth')).json())).toEqual({ required: true, authenticated: false });
    for (let i = 0; i < 5; i++) expect((await j('/api/login', { method: 'POST', body: JSON.stringify({ token: 'nope' }) })).status).toBe(401);
    expect((await j('/api/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) })).status).toBe(429);
  });
  it('accepts the right token once and then serves the API via cookie', async () => {
    const { j } = await boot(TOKEN);
    const login = await j('/api/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Strict/); expect(cookie).not.toContain(TOKEN);
    expect((await j('/api/state', { headers: { cookie: cookie.split(';')[0]! } })).status).toBe(200);
  });
  it('blocks cross-origin mutations and non-JSON bodies', async () => {
    const { j } = await boot(null);
    expect((await j('/api/system/kill-switch', { method: 'POST', body: '{"on":true}', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch((await boot(null)).base + '/api/system/kill-switch', { method: 'POST', body: 'on=1', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
  });
  it('turning off DRY_RUN needs an explicit confirm; the kill switch toggles', async () => {
    const { j, app } = await boot(null);
    expect((await j('/api/system/dry-run', { method: 'POST', body: '{"on":false}' })).status).toBe(400);
    expect(app.guard.get().dryRun).toBe(true);
    expect((await j('/api/system/dry-run', { method: 'POST', body: '{"on":false,"confirm":true}' })).status).toBe(200);
    expect(app.guard.get().dryRun).toBe(false);
    await j('/api/system/kill-switch', { method: 'POST', body: '{"on":true}' });
    expect(app.guard.get().killSwitch).toBe(true);
  });
  it('enabling an automation needs confirm; unknown ids 404', async () => {
    const { j } = await boot(null);
    expect((await j('/api/automations/daily-money-check/enable', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await j('/api/automations/daily-money-check/enable', { method: 'POST', body: '{"confirm":true}' })).status).toBe(200);
    expect((await j('/api/automations/nope/enable', { method: 'POST', body: '{"confirm":true}' })).status).toBe(404);
  });
  it('imports CSV, exposes money + reports, and downloads machine-readable artifacts', async () => {
    const { j, app } = await boot(null);
    const csv = `date,description,amount\n${ymd()},סופר,-10.00\n`;
    const r = await (await j('/api/money/import', { method: 'POST', body: JSON.stringify({ csv, account: 'עו"ש' }) })).json();
    expect(r.inserted).toBe(1);
    const t = await (await j('/api/automations/daily-money-check/run-now', { method: 'POST', body: '{}' })).json();
    await waitFor(() => app.tasks.get(t.taskId)?.status === 'completed');
    const reports = await (await j('/api/reports')).json();
    expect(reports).toHaveLength(1);
    const md = await j(`/api/reports/${reports[0].id}/download?format=md`);
    expect(md.headers.get('content-disposition')).toContain('attachment');
    const js = await (await j(`/api/reports/${reports[0].id}/download?format=json`)).json();
    expect(js.data.steps.length).toBeGreaterThan(3);
    expect((await (await j('/api/money')).json()).hasData).toBe(true);
  });
  it('SSE streams only the requested mode and catches up from Last-Event-ID', async () => {
    const { base, app } = await boot(null);
    app.bus.emitEvent({ runId: 'r', agentId: 'mono', type: 'started', publicSummary: 'real-1', origin: 'user', isDemo: false });
    app.bus.emitEvent({ runId: 'd', agentId: 'mono', type: 'started', publicSummary: 'demo-1', origin: 'demo', isDemo: true });
    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream?mode=real`, { signal: ac.signal, headers: { 'last-event-id': '0' } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader(); let buf = '';
    const read = async () => { const { value } = await reader.read(); buf += new TextDecoder().decode(value); };
    await read();
    app.bus.emitEvent({ runId: 'r', agentId: 'scout', type: 'progress', publicSummary: 'real-live', origin: 'user', isDemo: false });
    app.bus.emitEvent({ runId: 'd', agentId: 'scout', type: 'progress', publicSummary: 'demo-live', origin: 'demo', isDemo: true });
    for (let i = 0; i < 5 && !buf.includes('real-live'); i++) await read();
    ac.abort();
    expect(buf).toContain('real-1'); expect(buf).toContain('real-live'); expect(buf).not.toContain('demo-1'); expect(buf).not.toContain('demo-live');
    expect(buf).toMatch(/id: \d+\nevent: agent-event/);
  });
  it('static server blocks path traversal and falls back to index.html', async () => {
    const { base } = await boot(null);
    expect(await (await fetch(base + '/some/route')).text()).toContain('MONO');
    const trav = await fetch(base + '/..%2f..%2fpackage.json');
    expect(await trav.text()).not.toContain('"name": "mono-hq"');
  });
});
