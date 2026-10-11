/** API contract shared by the MONO HQ server and web app. All money is integer agorot (1/100 NIS). */

export const AGENT_IDS = ['mono', 'scout', 'ledger', 'flow', 'credit', 'budget', 'radar', 'guardian'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const REQUIRED_MODEL = 'claude-sonnet-5-5';

export type TaskStatus =
  | 'queued' | 'running' | 'awaiting_input' | 'awaiting_approval'
  | 'completed' | 'failed' | 'cancelled' | 'paused';

export type EventType =
  | 'queued' | 'started' | 'tool_started' | 'tool_completed' | 'progress'
  | 'awaiting_input' | 'awaiting_approval' | 'completed' | 'failed'
  | 'cancelled' | 'paused' | 'heartbeat' | 'skipped' | 'blocked';

export type EventOrigin = 'claude-hook' | 'agent-sdk' | 'claude-cli' | 'scheduler' | 'local-rules' | 'user' | 'demo';

export interface PublicEvent {
  seq: number;
  eventId: string;
  runId: string; // == taskId
  agentId: AgentId;
  type: EventType;
  occurredAt: string; // ISO UTC
  publicSummary: string; // Hebrew, redacted, <= 240 chars
  origin: EventOrigin;
  isDemo: boolean;
  toolCategory?: string;
  modelId?: string;
  sourceUrl?: string;
  lastVerifiedAt?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
}

export interface TaskStep {
  idx: number;
  agentId: AgentId;
  kind: 'local' | 'ai';
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';
}

export interface Task {
  id: string;
  title: string;
  kind: string; // e.g. 'daily-money-check', 'ask', 'research'
  status: TaskStatus;
  leadAgent: AgentId;
  isDemo: boolean;
  dryRun: boolean;
  origin: 'user' | 'scheduler' | 'demo';
  automationId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  steps: TaskStep[];
  resultSummary?: string; // Hebrew
  blocker?: string; // Hebrew
  approvalId?: string;
  reportId?: string;
}

export type AgentLiveStatus = 'idle' | 'working' | 'awaiting_approval' | 'awaiting_input' | 'blocked' | 'stale' | 'failed';

export interface AgentState {
  id: AgentId;
  name: string; // MONO
  roleHe: string;
  missionHe: string;
  model: string; // configured model, always REQUIRED_MODEL
  status: AgentLiveStatus;
  bubble: string | null; // latest truthful publicSummary, null => UI shows "ממתין למשימה"
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  lastEvents: PublicEvent[]; // newest first, max 5
  history: Array<Pick<Task, 'id' | 'title' | 'status' | 'finishedAt' | 'actualCostUsd'>>; // last 10
  toolCategory: string | null;
  verifiedSources: string[];
  blocker: string | null;
}

export interface Guardrails {
  dryRun: boolean;
  killSwitch: boolean;
  maxConcurrentAiJobs: number;
  maxDailyCostUsd: number;
  maxMonthlyCostUsd: number;
  maxJobMinutes: number;
  maxRetries: number;
  softLimitRatio: number; // warn at this fraction of a hard limit
}

export interface SpendSummary {
  dayUsd: number;
  monthUsd: number;
  dayLimitUsd: number;
  monthLimitUsd: number;
  basis: 'actual-reported-by-claude-cli'; // never a token estimate
  note: string; // Hebrew; guardrails are app settings, not Anthropic billing limits
}

export interface ModelVerification {
  required: typeof REQUIRED_MODEL;
  status: 'unverified' | 'verified' | 'failed' | 'cli-missing' | 'dry-run-skipped';
  checkedAt: string | null;
  observedModels: string[];
  cliVersion: string | null;
  detail: string;
}

export interface StateSnapshot {
  now: string;
  timezone: 'Asia/Jerusalem';
  mode: 'real' | 'demo';
  demoRunning: boolean;
  guardrails: Guardrails;
  spend: SpendSummary;
  model: ModelVerification;
  agents: AgentState[];
  runningAiJobs: number;
  pendingApprovals: Approval[];
  lastEventSeq: number;
  storageNote: string;
  /** true when MONO_ACCESS_TOKEN is set: sensitive actions then need the token re-entered (step-up). */
  authRequired: boolean;
}

export interface Approval {
  id: string;
  taskId: string | null;
  automationId: string | null;
  action: string; // machine id, e.g. 'run-ai-task' | 'enable-automation'
  titleHe: string;
  detailHe: string;
  estimatedCostUsd: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  decidedAt?: string;
}

export interface Automation {
  id: string;
  nameHe: string;
  descriptionHe: string;
  schedule: string; // human text in Hebrew
  cron: string | null; // null => event-triggered or unapproved time
  trigger: 'cron' | 'event';
  enabled: boolean;
  timeStatus: 'confirmed' | 'draft-awaiting-confirmation';
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: TaskStatus | 'waiting_for_connection' | null;
  requiresAi: boolean;
  requiredSources: string[];
  maxDurationMinutes: number;
  maxAttempts: number;
  maxModelCostUsd: number;
  approvalPolicy: string;
  lastVerifiedAt: string | null;
  waitingFor: string | null; // Hebrew; e.g. ledger data not imported
}

export type MoneyFlag = 'confirmed' | 'reported' | 'estimated';

export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD (transaction date)
  postingDate: string | null;
  description: string;
  amountAgorot: number; // negative = outflow
  currency: string;
  account: string; // user label only, never an account number
  category: string;
  kind: 'expense' | 'income' | 'transfer' | 'refund' | 'loan-principal' | 'loan-interest' | 'card-settlement';
  flag: MoneyFlag;
  possibleDuplicateOf: string | null;
  source: string;
}

export interface MoneyView {
  asOf: string | null; // null => no data imported
  hasData: boolean;
  balances: Array<{ account: string; amountAgorot: number; flag: MoneyFlag; asOf: string }>;
  budget: Array<{ category: string; limitAgorot: number; spentAgorot: number; flag: MoneyFlag }>;
  transactions: Transaction[];
  duplicates: number;
  emptyReasonHe: string | null;
}

export interface ImportResult {
  batchId: string;
  inserted: number;
  duplicatesSkipped: number;
  possibleDuplicates: number;
  rejected: Array<{ row: number; reason: string }>;
}

export interface ResearchItem {
  id: string;
  titleHe: string;
  summaryHe: string;
  sourceUrl: string;
  sourceName: string;
  reliability: 'official' | 'unverified';
  publishedAt: string | null;
  checkedAt: string;
  changeSinceLastCheck: 'new' | 'changed' | 'unchanged';
  impactHe: string;
  uncertaintyHe: string;
  taskId: string;
}

export interface Report {
  id: string;
  kind: 'daily' | 'weekly' | 'monthly' | 'salary-day' | 'research' | 'ad-hoc';
  titleHe: string;
  createdAt: string;
  taskId: string | null;
  isDemo: boolean;
  markdown: string;
  data: unknown; // machine readable artifact
}

export interface SystemView {
  guardrails: Guardrails;
  spend: SpendSummary;
  model: ModelVerification;
  permissions: Array<{ scope: string; granted: boolean; noteHe: string }>;
  provenance: Array<{ source: string; status: 'connected' | 'not-connected' | 'manual'; noteHe: string }>;
  auditLog: Array<{ id: string; at: string; actor: string; action: string; detail: string }>;
  /** Every audit row re-hashed in insertion order links to its predecessor (sha256 chain). */
  auditChainValid: boolean;
  authRequired: boolean;
  bindAddress: string;
}

/**
 * REST surface (JSON). Mutations require the session cookie when MONO_ACCESS_TOKEN is set.
 * Step-up: with a token configured, `POST /api/system/dry-run {on:false}`, `POST /api/system/kill-switch {on:false}` and any
 * raise of maxDailyCostUsd / maxMonthlyCostUsd / maxConcurrentAiJobs must also carry `token` (the access token) in the body.
 * Requests whose Host header is not 127.0.0.1 / localhost / [::1] / MONO_HOST are answered 421.
 */
export const API = {
  state: 'GET /api/state?mode=real|demo -> StateSnapshot',
  events: 'GET /api/events?after=<seq>&limit=<n>&mode=real|demo -> PublicEvent[] (oldest first)',
  stream: 'GET /api/stream?mode=real|demo (SSE; event "agent-event" data=PublicEvent, id=seq; supports Last-Event-ID; ": hb" comment heartbeats every 15s)',
  tasks: 'GET /api/tasks?mode=&status= -> Task[] (newest first)',
  createTask: 'POST /api/tasks {title, prompt, leadAgent?} -> Task',
  taskAction: 'POST /api/tasks/:id/(pause|resume|cancel|retry) -> Task; POST /api/approvals/:id/(approve|reject) -> Approval',
  automations: 'GET /api/automations -> Automation[]; POST /api/automations/:id/(enable|disable|run-now) {confirm:true}',
  system: 'GET /api/system -> SystemView; POST /api/system/kill-switch {on, token?}; POST /api/system/dry-run {on, confirm, token?}; POST /api/system/limits {Partial<Guardrails>, token?}; POST /api/system/verify-model',
  money: 'GET /api/money -> MoneyView; POST /api/money/import {csv, account} -> ImportResult',
  research: 'GET /api/research -> ResearchItem[]',
  reports: 'GET /api/reports -> Report[] (no markdown body in list? full body included); GET /api/reports/:id/download?format=md|json',
  demo: 'POST /api/demo/start | /api/demo/stop (demo events are flagged isDemo and never mixed into real mode)',
  login: 'POST /api/login {token} sets an HttpOnly Secure SameSite=Strict cookie holding a random server-side session id (30 days); GET /api/auth -> {required, authenticated}',
  logout: 'POST /api/logout revokes the current session and clears the cookie; POST /api/sessions/revoke-all -> {revoked} revokes every session (all devices)',
} as const;
