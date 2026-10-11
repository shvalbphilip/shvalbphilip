import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_GENESIS, appendAudit, backfillAuditChain, repairUnhashedAuditRows } from './audit.ts';

export type Db = DatabaseSync;

/** A migration is either a SQL script or a function (for data fixes SQL alone cannot express). */
export const MIGRATIONS: Array<string | ((db: Db) => void)> = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    lead_agent TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0, dry_run INTEGER NOT NULL,
    origin TEXT NOT NULL, automation_id TEXT, prompt TEXT, dedup_key TEXT UNIQUE,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0,
    result_summary TEXT, blocker TEXT, approval_id TEXT, report_id TEXT,
    depends_on TEXT NOT NULL DEFAULT '[]', paused INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_tasks_status ON tasks(status);
  CREATE TABLE task_steps (
    task_id TEXT NOT NULL, idx INTEGER NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (task_id, idx)
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL, public_summary TEXT NOT NULL,
    origin TEXT NOT NULL, is_demo INTEGER NOT NULL, tool_category TEXT, model_id TEXT, source_url TEXT,
    last_verified_at TEXT, estimated_cost_usd REAL, actual_cost_usd REAL
  );
  CREATE INDEX idx_events_agent ON events(agent_id, seq);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
  CREATE TABLE automations (
    id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, cron_override TEXT, time_confirmed INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT, last_success_at TEXT, last_status TEXT, last_verified_at TEXT, enabled_at TEXT
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT, automation_id TEXT, action TEXT NOT NULL, title_he TEXT NOT NULL,
    detail_he TEXT NOT NULL, estimated_cost_usd REAL NOT NULL DEFAULT 0, status TEXT NOT NULL,
    created_at TEXT NOT NULL, decided_at TEXT
  );
  CREATE TABLE spend (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, at TEXT NOT NULL, usd REAL NOT NULL, model_id TEXT, is_demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE audit_log (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, ref_hash TEXT NOT NULL UNIQUE, date TEXT NOT NULL, posting_date TEXT, description TEXT NOT NULL,
    amount_agorot INTEGER NOT NULL, currency TEXT NOT NULL, account TEXT NOT NULL, category TEXT NOT NULL,
    kind TEXT NOT NULL, flag TEXT NOT NULL, possible_duplicate_of TEXT, dup_status TEXT, source TEXT NOT NULL, batch_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tx_audit (id TEXT PRIMARY KEY, tx_id TEXT NOT NULL, at TEXT NOT NULL, change TEXT NOT NULL);
  CREATE TABLE balances (account TEXT PRIMARY KEY, amount_agorot INTEGER NOT NULL, flag TEXT NOT NULL, as_of TEXT NOT NULL);
  CREATE TABLE budgets (category TEXT PRIMARY KEY, limit_agorot INTEGER NOT NULL);
  CREATE TABLE research_items (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, title_he TEXT NOT NULL, summary_he TEXT NOT NULL, source_url TEXT NOT NULL,
    source_name TEXT NOT NULL, reliability TEXT NOT NULL, published_at TEXT, checked_at TEXT NOT NULL,
    change_since TEXT NOT NULL, impact_he TEXT NOT NULL, uncertainty_he TEXT NOT NULL, content_hash TEXT NOT NULL
  );
  CREATE TABLE reports (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title_he TEXT NOT NULL, created_at TEXT NOT NULL, task_id TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0, markdown TEXT NOT NULL, data TEXT NOT NULL
  );
  `,
  // v2: server-side login sessions + hash-chained, append-only audit log.
  (db) => {
    db.exec(`
      CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);
      ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
      ALTER TABLE audit_log ADD COLUMN hash TEXT;
    `);
    backfillAuditChain(db);
    db.exec(`
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    `);
  },
  // v3: audit head checkpoint, so truncating the newest audit rows is detected (a hash chain alone cannot see it).
  // The single row follows every insert via a trigger and may only ever advance by exactly one entry.
  (db) => {
    // v2 scheduler code wrote `automation.missed` rows without a hash. Re-chain them, but only when every hashed row is
    // still consistent, so a repair can never launder a row that was edited after it was written.
    const repaired = repairUnhashedAuditRows(db);
    db.exec('CREATE TABLE audit_head (id INTEGER PRIMARY KEY CHECK (id = 1), entries INTEGER NOT NULL, hash TEXT NOT NULL)');
    const head = db.prepare('SELECT COUNT(*) AS n, (SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1) AS h FROM audit_log').get() as { n: number; h: string | null };
    db.prepare('INSERT INTO audit_head (id, entries, hash) VALUES (1, ?, ?)').run(head.n, head.h ?? AUDIT_GENESIS);
    db.exec(`
      CREATE TRIGGER audit_head_follow AFTER INSERT ON audit_log BEGIN
        UPDATE audit_head SET entries = entries + 1, hash = NEW.hash WHERE id = 1;
      END;
      CREATE TRIGGER audit_head_forward_only BEFORE UPDATE ON audit_head
        WHEN NEW.id <> 1 OR NEW.entries <> OLD.entries + 1 OR NEW.hash IS NOT (SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1) BEGIN
        SELECT RAISE(ABORT, 'audit head only moves forward');
      END;
      CREATE TRIGGER audit_head_no_delete BEFORE DELETE ON audit_head BEGIN SELECT RAISE(ABORT, 'audit head only moves forward'); END;
      CREATE TRIGGER audit_head_no_insert BEFORE INSERT ON audit_head BEGIN SELECT RAISE(ABORT, 'audit head only moves forward'); END;
    `);
    if (repaired) appendAudit(db, 'system', 'audit.repair', `re-chained ${repaired} audit rows written without a hash by an older version`);
  },
];

const PRIVATE_FS = process.platform !== 'win32';

/** Owner-only permissions for the data directory (0700) and database files (0600). No-op on Windows. */
function restrictPermissions(dataDir: string, file: string): void {
  if (!PRIVATE_FS) return;
  chmodSync(dataDir, 0o700);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
}

export function openDb(dataDir: string): Db {
  const inMemory = dataDir === ':memory:';
  if (!inMemory) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = inMemory ? ':memory:' : join(dataDir, 'mono.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (!inMemory) restrictPermissions(dataDir, file); // the -wal file exists once WAL mode is on
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(v) AS v FROM schema_version').get() as { v: number | null };
  let v = row.v ?? 0;
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      const m = MIGRATIONS[v]!;
      if (typeof m === 'string') db.exec(m); else m(db);
      db.prepare('INSERT INTO schema_version (v) VALUES (?)').run(v + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    v++;
  }
  return db;
}

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : fallback;
}
export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), new Date().toISOString());
}
