import { describe, expect, it } from 'vitest';
import { canTransition } from '../src/tasks.ts';
import { redact } from '../src/redact.ts';
import { deriveAgentStatus, STALE_AFTER_MS } from '../src/state.ts';
import { makeApp } from './helpers.ts';
import type { PublicEvent } from '../../shared/contract.ts';

describe('event store', () => {
  it('is append-only: UPDATE and DELETE are rejected by the database', () => {
    const app = makeApp();
    const e = app.bus.emitEvent({ runId: 'r1', agentId: 'mono', type: 'started', publicSummary: 'x', origin: 'user', isDemo: false });
    expect(() => app.db.prepare('UPDATE events SET public_summary = ? WHERE seq = ?').run('hacked', e.seq)).toThrow(/immutable/);
    expect(() => app.db.prepare('DELETE FROM events WHERE seq = ?').run(e.seq)).toThrow(/immutable/);
    app.close();
  });
  it('rejects mismatched demo flags so demo can never pose as real', () => {
    const app = makeApp();
    expect(() => app.bus.emitEvent({ runId: 'r', agentId: 'mono', type: 'started', publicSummary: 'x', origin: 'demo', isDemo: false })).toThrow();
    expect(() => app.bus.emitEvent({ runId: 'r', agentId: 'mono', type: 'started', publicSummary: 'x', origin: 'user', isDemo: true })).toThrow();
    expect(() => app.bus.emitEvent({ runId: 'r', agentId: 'nobody' as never, type: 'started', publicSummary: 'x', origin: 'user', isDemo: false })).toThrow();
    app.close();
  });
  it('redacts identifiers before persisting and strips query strings from source URLs', () => {
    const app = makeApp();
    // Assembled at runtime so the repo's own secret scanner never sees a key- or IBAN-shaped literal in a tracked file.
    const fakeKey = ['sk', 'ant', 'abcdefghijklmnop1234'].join('-');
    const fakeIban = ['IL62', '0108', '0000', '0009', '9999', '999'].join(' ');
    const e = app.bus.emitEvent({ runId: 'r', agentId: 'scout', type: 'progress', publicSummary: `כרטיס 4580 1234 5678 9012 וגם ${fakeIban} ו-a@b.co סיסמה ${fakeKey}`, origin: 'claude-cli', isDemo: false, sourceUrl: 'https://user:pw@www.boi.org.il/a?token=1#h' });
    expect(e.publicSummary).not.toMatch(/4580|IL62|a@b\.co|sk-ant/);
    expect(e.sourceUrl).toBe('https://www.boi.org.il/a');
    expect(app.bus.emitEvent({ runId: 'r', agentId: 'scout', type: 'progress', publicSummary: 'x', origin: 'claude-cli', isDemo: false, sourceUrl: 'http://insecure.example' }).sourceUrl).toBeUndefined();
    app.close();
  });
  it('catches up from a sequence number, oldest first, filtered by demo flag', () => {
    const app = makeApp();
    app.bus.emitEvent({ runId: 'r', agentId: 'mono', type: 'started', publicSummary: 'a', origin: 'user', isDemo: false });
    app.bus.emitEvent({ runId: 'd', agentId: 'mono', type: 'started', publicSummary: 'demo', origin: 'demo', isDemo: true });
    const b = app.bus.emitEvent({ runId: 'r', agentId: 'mono', type: 'completed', publicSummary: 'b', origin: 'user', isDemo: false });
    expect(app.bus.list({ after: 0, demo: false }).map((e) => e.publicSummary)).toEqual(['a', 'b']);
    expect(app.bus.list({ after: b.seq - 1, demo: false })).toHaveLength(1);
    app.close();
  });
});

describe('redact', () => {
  it('masks Israeli ID, phone and long account numbers but keeps normal amounts/dates', () => {
    expect(redact('ת.ז. 123456789 טלפון 050-1234567 חשבון 12345678')).not.toMatch(/123456789|1234567|12345678/);
    expect(redact('שולם ₪1,234.56 ב-2026-10-09')).toBe('שולם ₪1,234.56 ב-2026-10-09');
  });
});

describe('task state machine', () => {
  it('allows only documented transitions', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('cancelled', 'queued')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('queued', 'completed')).toBe(false);
  });
  it('throws on an illegal transition at the store level', () => {
    const app = makeApp();
    const { task } = app.tasks.create({ title: 't', kind: 'k', leadAgent: 'mono', isDemo: false, dryRun: true, origin: 'user', steps: [] });
    expect(() => app.tasks.transition(task.id, 'completed')).toThrow(/illegal/);
    app.close();
  });
  it('dedup key makes task creation idempotent', () => {
    const app = makeApp();
    const spec = { title: 't', kind: 'k', leadAgent: 'mono' as const, isDemo: false, dryRun: true, origin: 'scheduler' as const, dedupKey: 'x:1', steps: [] };
    const a = app.tasks.create(spec), b = app.tasks.create(spec);
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.task.id).toBe(a.task.id);
    app.close();
  });
});

describe('agent status derivation (no phantom work, stale detection)', () => {
  const ev = (type: PublicEvent['type'], ageMs: number): PublicEvent => ({ seq: 1, eventId: 'e', runId: 'r', agentId: 'mono', type, occurredAt: new Date(Date.now() - ageMs).toISOString(), publicSummary: 's', origin: 'user', isDemo: false });
  it('working only while the task is actually running', () => {
    expect(deriveAgentStatus(ev('started', 1000), 'running', Date.now())).toBe('working');
    expect(deriveAgentStatus(ev('started', 1000), 'failed', Date.now())).toBe('idle');
    expect(deriveAgentStatus(ev('tool_started', 1000), undefined, Date.now())).toBe('idle');
  });
  it('flags stale (no events for too long) distinctly from running and failed', () => {
    expect(deriveAgentStatus(ev('heartbeat', STALE_AFTER_MS + 5000), 'running', Date.now())).toBe('stale');
    expect(deriveAgentStatus(ev('failed', 10), 'failed', Date.now())).toBe('failed');
    expect(deriveAgentStatus(undefined, undefined, Date.now())).toBe('idle');
  });
  it('shows approval / input waits only while the task is still waiting', () => {
    expect(deriveAgentStatus(ev('awaiting_approval', 10), 'awaiting_approval', Date.now())).toBe('awaiting_approval');
    expect(deriveAgentStatus(ev('awaiting_approval', 10), 'cancelled', Date.now())).toBe('idle');
  });
});
