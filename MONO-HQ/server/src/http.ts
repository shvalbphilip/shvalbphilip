import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from './app.ts';
import { AUTOMATIONS } from './automations.ts';
import { redact } from './redact.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
const MAX_BODY = 1_500_000;

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function createHttpServer(app: App, distDir = fileURLToPath(new URL('../../dist', import.meta.url))): Server {
  const token = app.cfg.accessToken;
  const sessionValue = token ? createHmac('sha256', token).update('mono-hq-session-v1').digest('hex') : '';
  const attempts = new Map<string, { n: number; reset: number }>();
  const sseClients = new Set<ServerResponse>();

  const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  const cookieOf = (req: IncomingMessage, name: string) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
  const authed = (req: IncomingMessage) => !token || safeEq(cookieOf(req, 'mono_session') ?? '', sessionValue);

  function headers(res: ServerResponse, extra: Record<string, string> = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }
  const json = (res: ServerResponse, status: number, body: unknown) => { headers(res, { 'Content-Type': 'application/json; charset=utf-8' }); res.statusCode = status; res.end(JSON.stringify(body)); };

  async function body<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw new HttpError(413, 'body too large'); chunks.push(c as Buffer); }
    if (n === 0) return {} as T;
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T; } catch { throw new HttpError(400, 'invalid JSON'); }
  }

  function sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (curl/tests); cookie auth + SameSite still protect browsers
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  const modeDemo = (u: URL) => u.searchParams.get('mode') === 'demo';

  async function route(req: IncomingMessage, res: ServerResponse, u: URL): Promise<void> {
    const m = req.method ?? 'GET'; const p = u.pathname;

    if (p === '/api/auth' && m === 'GET') return json(res, 200, { required: !!token, authenticated: authed(req) });
    if (p === '/api/login' && m === 'POST') {
      if (!token) return json(res, 200, { ok: true });
      const ip = req.socket.remoteAddress ?? '?'; const now = Date.now();
      const a = attempts.get(ip); if (a && a.reset > now && a.n >= 5) throw new HttpError(429, 'too many attempts');
      const b = await body<{ token?: string }>(req);
      if (typeof b.token !== 'string' || !safeEq(b.token, token)) {
        attempts.set(ip, { n: (a && a.reset > now ? a.n : 0) + 1, reset: a && a.reset > now ? a.reset : now + 60_000 });
        throw new HttpError(401, 'invalid token');
      }
      attempts.delete(ip);
      const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      headers(res, { 'Set-Cookie': `mono_session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` });
      return json(res, 200, { ok: true });
    }
    if (!authed(req)) throw new HttpError(401, 'unauthorized');
    if (m !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'cross-origin request blocked');

    if (p === '/api/state' && m === 'GET') return json(res, 200, app.state.snapshot(modeDemo(u)));
    if (p === '/api/events' && m === 'GET') return json(res, 200, app.bus.list({ after: Number(u.searchParams.get('after') ?? 0) || 0, limit: Number(u.searchParams.get('limit') ?? 200) || 200, demo: modeDemo(u) }));
    if (p === '/api/stream' && m === 'GET') return stream(req, res, u);
    if (p === '/api/tasks' && m === 'GET') {
      const status = u.searchParams.get('status') as never | null;
      return json(res, 200, app.tasks.list({ demo: modeDemo(u), ...(status ? { status } : {}), limit: 100 }));
    }
    if (p === '/api/tasks' && m === 'POST') {
      const b = await body<{ title?: string; prompt?: string }>(req);
      const prompt = typeof b.prompt === 'string' ? redact(b.prompt.trim()).slice(0, 2000) : '';
      if (!prompt) throw new HttpError(400, 'prompt required');
      return json(res, 201, app.orch.enqueue({ workflow: 'ask', origin: 'user', prompt, title: typeof b.title === 'string' && b.title.trim() ? redact(b.title).slice(0, 120) : `שאלה: ${prompt.slice(0, 50)}` }));
    }
    let mt: RegExpExecArray | null;
    if ((mt = /^\/api\/tasks\/([\w]+)\/(pause|resume|cancel|retry)$/.exec(p)) && m === 'POST') {
      const [, id, act] = mt as unknown as [string, string, 'pause' | 'resume' | 'cancel' | 'retry'];
      try { return json(res, 200, app.orch[act](id)); } catch (e) { throw new HttpError(409, (e as Error).message); }
    }
    if (p === '/api/approvals' && m === 'GET') return json(res, 200, app.orch.pendingApprovals());
    if ((mt = /^\/api\/approvals\/(\w+)\/(approve|reject)$/.exec(p)) && m === 'POST') {
      try { return json(res, 200, app.orch.decideApproval(mt[1]!, mt[2] === 'approve')); } catch (e) { throw new HttpError(409, (e as Error).message); }
    }
    if (p === '/api/automations' && m === 'GET') return json(res, 200, app.scheduler.list());
    if ((mt = /^\/api\/automations\/([\w-]+)\/(enable|disable|run-now)$/.exec(p)) && m === 'POST') {
      const b = await body<{ confirm?: boolean }>(req);
      const id = mt[1]!;
      if (!AUTOMATIONS.some((a) => a.id === id)) throw new HttpError(404, 'automation not found');
      try {
        if (mt[2] === 'run-now') return json(res, 202, { taskId: app.scheduler.runNow(id) });
        app.scheduler.setEnabled(id, mt[2] === 'enable', b.confirm === true);
        return json(res, 200, app.scheduler.list().find((a) => a.id === id));
      } catch (e) { throw new HttpError(400, (e as Error).message); }
    }
    if (p === '/api/system' && m === 'GET') return json(res, 200, app.system());
    if (p === '/api/system/kill-switch' && m === 'POST') { const b = await body<{ on?: boolean }>(req); app.orch.setKillSwitch(b.on === true); return json(res, 200, app.system()); }
    if (p === '/api/system/dry-run' && m === 'POST') {
      const b = await body<{ on?: boolean; confirm?: boolean }>(req);
      if (b.on === false && b.confirm !== true) throw new HttpError(400, 'כיבוי מצב יבש מאפשר קריאות AI אמיתיות ועלויות — נדרש confirm');
      app.guard.update({ dryRun: b.on !== false }, 'user'); app.orch.pump(); return json(res, 200, app.system());
    }
    if (p === '/api/system/limits' && m === 'POST') {
      const b = await body<Record<string, unknown>>(req);
      const patch: Record<string, number> = {};
      for (const k of ['maxConcurrentAiJobs', 'maxDailyCostUsd', 'maxMonthlyCostUsd', 'maxJobMinutes', 'maxRetries', 'softLimitRatio']) if (b[k] !== undefined) patch[k] = Number(b[k]);
      try { app.guard.update(patch, 'user'); } catch (e) { throw new HttpError(400, (e as Error).message); }
      return json(res, 200, app.system());
    }
    if (p === '/api/system/verify-model' && m === 'POST') return json(res, 200, await app.verifyModel());
    if (p === '/api/money' && m === 'GET') return json(res, 200, app.money.view());
    if (p === '/api/money/import' && m === 'POST') {
      const b = await body<{ csv?: string; account?: string }>(req);
      if (typeof b.csv !== 'string' || !b.csv.trim()) throw new HttpError(400, 'csv required');
      let r; try { r = app.money.import(b.csv, typeof b.account === 'string' ? b.account : 'חשבון'); } catch (e) { throw new HttpError(400, (e as Error).message); }
      app.guard.audit('user', 'money.import', `inserted=${r.inserted} dup=${r.duplicatesSkipped} rejected=${r.rejected.length}`);
      if (r.inserted > 0) app.scheduler.onImport(r.batchId);
      return json(res, 200, r);
    }
    if (p === '/api/money/balance' && m === 'POST') {
      const b = await body<{ account?: string; amountAgorot?: number; flag?: 'confirmed' | 'reported' | 'estimated'; asOf?: string }>(req);
      if (!b.account || !Number.isSafeInteger(b.amountAgorot) || !b.asOf || !['confirmed', 'reported', 'estimated'].includes(b.flag ?? '')) throw new HttpError(400, 'account, amountAgorot (integer), flag, asOf required');
      app.money.setBalance(b.account, b.amountAgorot!, b.flag!, b.asOf); return json(res, 200, app.money.view());
    }
    if (p === '/api/money/budget' && m === 'POST') {
      const b = await body<{ category?: string; limitAgorot?: number }>(req);
      if (!b.category || !Number.isSafeInteger(b.limitAgorot)) throw new HttpError(400, 'category and integer limitAgorot required');
      app.money.setBudget(b.category, b.limitAgorot!); return json(res, 200, app.money.view());
    }
    if (p === '/api/money/duplicates/resolve' && m === 'POST') return json(res, 201, app.orch.enqueue({ workflow: 'resolve-duplicates', origin: 'user' }));
    if (p === '/api/research' && m === 'GET') return json(res, 200, app.research.list());
    if (p === '/api/reports' && m === 'GET') return json(res, 200, app.reports.list(modeDemo(u)));
    if ((mt = /^\/api\/reports\/(\w+)\/download$/.exec(p)) && m === 'GET') {
      const r = app.reports.get(mt[1]!); if (!r) throw new HttpError(404, 'report not found');
      const fmt = u.searchParams.get('format') === 'json' ? 'json' : 'md';
      headers(res, { 'Content-Type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="mono-report-${r.id}.${fmt}"` });
      res.statusCode = 200; res.end(fmt === 'json' ? JSON.stringify({ id: r.id, kind: r.kind, title: r.titleHe, createdAt: r.createdAt, data: r.data }, null, 2) : r.markdown); return;
    }
    if (p === '/api/demo/start' && m === 'POST') { app.demo.start(); return json(res, 200, { running: app.demo.running }); }
    if (p === '/api/demo/stop' && m === 'POST') { app.demo.stop(); return json(res, 200, { running: app.demo.running }); }
    throw new HttpError(404, 'not found');
  }

  function stream(req: IncomingMessage, res: ServerResponse, u: URL) {
    const demo = modeDemo(u);
    headers(res, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.statusCode = 200; res.flushHeaders();
    const lastId = Number(req.headers['last-event-id'] ?? u.searchParams.get('after') ?? 0) || 0;
    const send = (e: { seq: number; isDemo: boolean }) => { if (e.isDemo === demo) res.write(`id: ${e.seq}\nevent: agent-event\ndata: ${JSON.stringify(e)}\n\n`); };
    res.write('retry: 3000\n\n');
    for (const e of app.bus.list({ after: lastId, limit: 500, demo })) send(e);
    const on = (e: { seq: number; isDemo: boolean }) => send(e);
    app.bus.on('event', on);
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    sseClients.add(res);
    req.on('close', () => { clearInterval(hb); app.bus.off('event', on); sseClients.delete(res); });
  }

  function serveStatic(res: ServerResponse, p: string) {
    const root = resolve(distDir);
    let file = normalize(join(root, p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!file.startsWith(root + sep) && file !== root) throw new HttpError(403, 'forbidden');
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html');
    if (!existsSync(file)) { headers(res, { 'Content-Type': 'text/plain; charset=utf-8' }); res.statusCode = 200; res.end('MONO HQ API is running. Build the web app with `npm run build`, or use `npm run dev:web`.'); return; }
    headers(res, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public, max-age=3600' });
    res.statusCode = 200; res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const run = u.pathname.startsWith('/api/') ? route(req, res, u) : Promise.resolve().then(() => { if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed'); serveStatic(res, u.pathname); });
    run.catch((e) => {
      if (res.headersSent) { res.end(); return; }
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[http] internal error:', redact(String((e as Error)?.message ?? e)));
      json(res, status, { error: e instanceof HttpError ? e.message : 'internal error' });
    });
  });
  server.on('close', () => { for (const r of sseClients) r.end(); });
  return server;
}
