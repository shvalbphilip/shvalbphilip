import { createApp } from './app.ts';
import { createHttpServer } from './http.ts';

const app = createApp();
const recovered = app.orch.recoverOnBoot();
const server = createHttpServer(app);
void app.runner.cliVersion().then((v) => console.log(`[mono-hq] claude CLI: ${v ?? 'not found (REAL mode unavailable; DEMO/local rules still work)'}`));

server.listen(app.cfg.port, app.cfg.host, () => {
  const g = app.guard.get();
  console.log(`[mono-hq] http://${app.cfg.host}:${app.cfg.port}  auth=${app.cfg.accessToken ? 'token' : 'none (loopback only)'}`);
  if (app.cfg.publicHost) console.log(`[mono-hq] remote: https://${app.cfg.publicHost} (HTTPS terminated by tailscale serve / a TLS proxy in front of this port)`);
  console.log(`[mono-hq] DRY_RUN=${g.dryRun} killSwitch=${g.killSwitch} limits: $${g.maxDailyCostUsd}/day $${g.maxMonthlyCostUsd}/month, ${g.maxConcurrentAiJobs} concurrent AI jobs`);
  if (recovered) console.log(`[mono-hq] marked ${recovered} interrupted task(s) as failed (never re-run automatically)`);
});

const shutdown = () => { console.log('[mono-hq] shutting down'); server.close(); server.closeAllConnections?.(); app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
