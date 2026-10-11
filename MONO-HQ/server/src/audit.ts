import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { newId, nowIso } from './util.ts';

/** First link of the chain. A fixed, well-known value so an empty log verifies trivially. */
export const AUDIT_GENESIS = '0'.repeat(64);
export const AUDIT_DETAIL_MAX = 500;

/**
 * hash = sha256(prev_hash ‖ at ‖ actor ‖ action ‖ detail).
 * Fields are joined with '\n' so no two field splits can produce the same digest
 * (e.g. actor "ab"+action "c" vs actor "a"+action "bc").
 */
export function auditHash(prevHash: string, at: string, actor: string, action: string, detail: string): string {
  return createHash('sha256').update([prevHash, at, actor, action, detail].join('\n')).digest('hex');
}

interface AuditRow { rowid: number; id: string; at: string; actor: string; action: string; detail: string; prev_hash: string | null; hash: string | null }

function lastHash(db: Db): string {
  const r = db.prepare('SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1').get() as { hash: string | null } | undefined;
  return r?.hash ?? AUDIT_GENESIS;
}

/** Appends an entry linked to the previous one. Single-threaded Node + synchronous SQLite make the read-then-insert atomic. */
export function appendAudit(db: Db, actor: string, action: string, detail: string): void {
  const d = detail.slice(0, AUDIT_DETAIL_MAX);
  const at = nowIso();
  const prev = lastHash(db);
  db.prepare('INSERT INTO audit_log (id, at, actor, action, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?)')
    .run(newId('aud'), at, actor, action, d, prev, auditHash(prev, at, actor, action, d));
}

export interface AuditChainReport { valid: boolean; entries: number; brokenAtId?: string; headMismatch?: boolean }

/**
 * Re-derives every hash in insertion order and checks each link points at its predecessor, then compares the chain's
 * length and tip with the persisted head checkpoint (audit_head), which catches truncation of the newest rows.
 */
export function verifyAuditChain(db: Db): AuditChainReport {
  const rows = db.prepare('SELECT rowid, id, at, actor, action, detail, prev_hash, hash FROM audit_log ORDER BY rowid ASC').all() as unknown as AuditRow[];
  let prev = AUDIT_GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== auditHash(prev, r.at, r.actor, r.action, r.detail)) return { valid: false, entries: rows.length, brokenAtId: r.id };
    prev = r.hash;
  }
  const head = db.prepare('SELECT entries, hash FROM audit_head WHERE id = 1').get() as { entries: number; hash: string } | undefined;
  if (!head || head.entries !== rows.length || head.hash !== prev) return { valid: false, entries: rows.length, headMismatch: true };
  return { valid: true, entries: rows.length };
}

/**
 * Migration helper for rows inserted without a hash (the v2 scheduler bypassed appendAudit). Rows written after such a
 * row were linked to GENESIS, because lastHash() treats a NULL hash as the start of a chain. The whole log is
 * re-chained only if every hashed row still matches its own content and links to its predecessor's hash (or to
 * GENESIS right after an unhashed row). Otherwise nothing is touched and the chain keeps reporting the break.
 * Returns the number of rows rewritten.
 */
export function repairUnhashedAuditRows(db: Db): number {
  const rows = db.prepare('SELECT rowid, id, at, actor, action, detail, prev_hash, hash FROM audit_log ORDER BY rowid ASC').all() as unknown as AuditRow[];
  if (!rows.some((r) => r.hash === null)) return 0;
  let expectedPrev: string = AUDIT_GENESIS;
  for (const r of rows) {
    if (r.hash === null) { expectedPrev = AUDIT_GENESIS; continue; }
    if (r.prev_hash !== expectedPrev || r.hash !== auditHash(r.prev_hash, r.at, r.actor, r.action, r.detail)) return 0;
    expectedPrev = r.hash;
  }
  db.exec('DROP TRIGGER IF EXISTS audit_no_update');
  const n = backfillAuditChain(db);
  db.exec("CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;");
  return n;
}

/** Migration helper: gives rows written before hashing existed a valid chain, in insertion order. */
export function backfillAuditChain(db: Db): number {
  const rows = db.prepare('SELECT rowid, id, at, actor, action, detail, prev_hash, hash FROM audit_log ORDER BY rowid ASC').all() as unknown as AuditRow[];
  const upd = db.prepare('UPDATE audit_log SET prev_hash = ?, hash = ? WHERE rowid = ?');
  let prev = AUDIT_GENESIS, n = 0;
  for (const r of rows) {
    const h = auditHash(prev, r.at, r.actor, r.action, r.detail);
    if (r.prev_hash !== prev || r.hash !== h) { upd.run(prev, h, r.rowid); n++; }
    prev = h;
  }
  return n;
}
