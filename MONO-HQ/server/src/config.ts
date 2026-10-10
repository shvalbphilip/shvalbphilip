import type { Guardrails } from '../../shared/contract.ts';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  accessToken: string | null;
  claudeBin: string;
  defaults: Guardrails;
}

function num(v: string | undefined, d: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

/** Defaults are conservative: DRY_RUN on, no AI calls until the user explicitly enables real jobs. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.MONO_HOST || '127.0.0.1';
  const accessToken = env.MONO_ACCESS_TOKEN || null;
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && (!accessToken || accessToken.length < 16)) {
    throw new Error('MONO_HOST is not loopback: set MONO_ACCESS_TOKEN (>=16 chars) before exposing MONO HQ on a network.');
  }
  return {
    host,
    port: num(env.MONO_PORT, 8787),
    dataDir: env.MONO_DATA_DIR || new URL('../../data', import.meta.url).pathname,
    accessToken,
    claudeBin: env.CLAUDE_BIN || 'claude',
    defaults: {
      dryRun: env.DRY_RUN !== 'false',
      killSwitch: false,
      maxConcurrentAiJobs: num(env.MAX_CONCURRENT_AI_JOBS, 2),
      maxDailyCostUsd: num(env.MAX_DAILY_COST_USD, 2),
      maxMonthlyCostUsd: num(env.MAX_MONTHLY_COST_USD, 25),
      maxJobMinutes: num(env.MAX_JOB_MINUTES, 12),
      maxRetries: num(env.MAX_RETRIES, 1),
      softLimitRatio: 0.8,
    },
  };
}
