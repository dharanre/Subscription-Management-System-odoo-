import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrations } from './migrations/index.js';

export type DB = DatabaseSync;
export type Param = SQLInputValue;

// node:sqlite returns untyped rows. These helpers are the one place that asserts a row shape, so
// callers state the columns they selected (`get<{ id: number }>(...)`) instead of scattering casts.
export function get<T>(db: DB, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: DB, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: DB, sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const info = db.prepare(sql).run(...params);
  return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
}

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

const depth = new WeakMap<DB, number>();

/**
 * Runs `fn` atomically: commits if it returns, rolls back if it throws. Nested calls become
 * savepoints. `fn` must be synchronous - awaiting inside a transaction would hold the write lock.
 */
export function transaction<T>(db: DB, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const savepoint = `sp_${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    depth.set(db, level);
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    depth.set(db, level);
    db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw err;
  }
}

/** True when a statement failed on a UNIQUE or PRIMARY KEY constraint. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/i.test(e.message ?? '');
}

/** Runs any migrations not yet recorded. Returns the ids that were applied. */
export function migrate(db: DB): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const done = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id);
    });
    applied.push(m.id);
  }
  return applied;
}
