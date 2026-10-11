import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { nowIso } from './util.ts';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ID_RE = /^[0-9a-f]{64}$/;

/**
 * Server-side login sessions. The cookie carries a random 256-bit id; only its SHA-256 is stored,
 * so a copy of the database cannot be replayed as a cookie.
 */
export class SessionStore {
  constructor(private db: Db, private ttlMs = SESSION_TTL_MS) {}

  private static hash(id: string): string { return createHash('sha256').update(id).digest('hex'); }

  create(now = Date.now()): { id: string; expiresAt: string } {
    this.prune(now);
    const id = randomBytes(32).toString('hex');
    const expiresAt = new Date(now + this.ttlMs).toISOString();
    this.db.prepare('INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?,?,?)').run(SessionStore.hash(id), new Date(now).toISOString(), expiresAt);
    return { id, expiresAt };
  }

  /** True only for a known, unrevoked, unexpired session id. Malformed ids never touch the database. */
  validate(id: string | undefined, now = Date.now()): boolean {
    if (!id || !ID_RE.test(id)) return false;
    const r = this.db.prepare('SELECT expires_at, revoked_at FROM sessions WHERE id_hash = ?').get(SessionStore.hash(id)) as { expires_at: string; revoked_at: string | null } | undefined;
    return !!r && r.revoked_at === null && Date.parse(r.expires_at) > now;
  }

  revoke(id: string | undefined): boolean {
    if (!id || !ID_RE.test(id)) return false;
    return this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').run(nowIso(), SessionStore.hash(id)).changes > 0;
  }

  revokeAll(): number {
    return Number(this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(nowIso()).changes);
  }

  activeCount(now = Date.now()): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?').get(new Date(now).toISOString()) as { n: number }).n;
  }

  private prune(now: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(new Date(now - this.ttlMs).toISOString());
  }
}
