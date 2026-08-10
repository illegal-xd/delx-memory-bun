import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_DB_PATH } from "../constants.js";

// ---------------------------------------------------------------------------
// SQLite backend selection
//
// Node uses better-sqlite3 (synchronous native module). Bun hard-blocks
// better-sqlite3 ("'better-sqlite3' is not yet supported in Bun",
// oven-sh/bun#4290), so under Bun we use bun:sqlite, whose statement API is
// compatible for our usage (exec/close/query + get/all/run). The switch
// happens once at module load via top-level-await dynamic import, so only the
// active runtime's backend module is ever loaded. Both backends conform to
// the small SqliteDatabase interface below.
// ---------------------------------------------------------------------------

// Ambient type for bun:sqlite lives in src/types/bun-sqlite.d.ts so tsc (no
// Bun types installed) can type-check the Bun branch; the real implementation
// is resolved at runtime.

/** Minimal statement surface shared by better-sqlite3 and bun:sqlite. */
export interface SqliteStatement<T extends unknown[] = unknown[], R = unknown> {
  get(...params: T): R | null | undefined;
  all(...params: T): R[];
  run(...params: T): { changes: number; lastInsertRowid: number | bigint };
}

/** Minimal database surface shared by better-sqlite3 and bun:sqlite. */
export interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
  prepare<T extends unknown[] = unknown[], R = unknown>(sql: string): SqliteStatement<T, R>;
  /** better-sqlite3 only — the Bun backend applies PRAGMAs via exec(). */
  pragma?(sql: string): unknown;
}

const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

let DatabaseCtor: new (path: string) => SqliteDatabase;

if (isBunRuntime) {
  const { Database: BunDatabase } = await import("bun:sqlite");
  DatabaseCtor = class BunCompatDatabase implements SqliteDatabase {
    private inner: import("bun:sqlite").Database;
    // bun:sqlite's run().changes is the CONNECTION-cumulative change count
    // (sqlite3_total_changes semantics), whereas better-sqlite3 returns the
    // count for just the executed statement. Callers (memory_set/forget/
    // forget_by_tag, sweepExpired) rely on per-statement counts, so we probe
    // SQLite's changes() right after each run. Single-threaded synchronous
    // access makes this safe to share across statements.
    private changesProbe: { get(): { c: number } | null };
    constructor(path: string) {
      this.inner = new BunDatabase(path);
      this.changesProbe = this.inner.query("SELECT changes() AS c");
    }
    exec(sql: string): void {
      this.inner.exec(sql);
    }
    close(): void {
      this.inner.close();
    }
    prepare<T extends unknown[] = unknown[], R = unknown>(sql: string): SqliteStatement<T, R> {
      const stmt = this.inner.query<T, R>(sql);
      return {
        get: (...params: T) => stmt.get(...params) as R | null | undefined,
        all: (...params: T) => stmt.all(...params) as R[],
        run: (...params: T) => {
          const r = stmt.run(...params);
          return { changes: this.changesProbe.get()?.c ?? 0, lastInsertRowid: r.lastInsertRowid };
        },
      };
    }
  };
} else {
  const mod = await import("better-sqlite3");
  DatabaseCtor = mod.default as unknown as new (path: string) => SqliteDatabase;
}

export interface MemoryRow {
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
  ttl_expires_at: number | null;
  tags: string | null;
  metadata: string | null;
}

let cachedDb: SqliteDatabase | null = null;
let cachedPath: string | null = null;
// Per-connection cache of whether the FTS5 virtual table is usable. Reset
// whenever the cached connection changes.
let cachedFtsReady: boolean | null = null;
// Prepared-statement cache keyed by SQL text. Statements are bound to the
// cached connection, so the cache is cleared whenever the connection changes.
const stmtCache = new Map<string, SqliteStatement>();

export function resolveDbPath(): string {
  return process.env.DELX_MEMORY_PATH ?? DEFAULT_DB_PATH;
}

function ensureParentDirSecure(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // Try to tighten existing dir perms (best effort — may fail on Windows).
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* ignore */
    }
  }
}

function ensureFileSecure(path: string): void {
  if (existsSync(path)) {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore — non-POSIX filesystems */
    }
  }
}

/**
 * Open (or reuse) the SQLite connection. Bootstraps schema + indexes on
 * first open. Idempotent. Returns the SAME connection on repeated calls
 * unless the path changed (only happens in tests that flip env vars).
 */
export function getDb(): SqliteDatabase {
  const path = resolveDbPath();
  if (cachedDb && cachedPath === path) return cachedDb;
  if (cachedDb && cachedPath !== path) {
    cachedDb.close();
    cachedDb = null;
    cachedPath = null;
    cachedFtsReady = null;
    stmtCache.clear();
  }

  ensureParentDirSecure(path);
  const db = new DatabaseCtor(path);
  ensureFileSecure(path);

  if (isBunRuntime) {
    // bun:sqlite has no pragma(); PRAGMA statements via exec() are equivalent.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Shrink the default page cache (2 MB) — this is a small KV store, not a
    // warehouse. ~512 KB keeps hot pages resident without pinning extra RSS.
    db.exec("PRAGMA cache_size = -512");
  } else {
    db.pragma!("journal_mode = WAL");
    db.pragma!("synchronous = NORMAL");
    db.pragma!("foreign_keys = ON");
    // Shrink the default page cache (2 MB) — this is a small KV store, not a
    // warehouse. ~512 KB keeps hot pages resident without pinning extra RSS.
    db.pragma!("cache_size = -512");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ttl_expires_at INTEGER,
      tags TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_ttl ON memory(ttl_expires_at) WHERE ttl_expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_tags ON memory(tags);
    CREATE INDEX IF NOT EXISTS idx_memory_updated_at ON memory(updated_at);
  `);

  cachedDb = db;
  cachedPath = path;
  cachedFtsReady = setupFts(db);
  return db;
}

/**
 * Probe whether this SQLite build supports FTS5. Cheap (creates + drops a
 * temp virtual table). Some distro builds ship without the FTS5 module.
 */
function ftsSupported(db: SqliteDatabase): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp._delx_fts_probe USING fts5(x);");
    db.exec("DROP TABLE IF EXISTS temp._delx_fts_probe;");
    return true;
  } catch {
    return false;
  }
}

/**
 * Bootstrap the FTS5 virtual table + sync triggers that mirror the searchable
 * columns (key, value, tags) of `memory`. Uses an external-content table keyed
 * on memory.rowid so the index stores no duplicate copy of the data. Triggers
 * keep it in sync on insert/update/delete. Backfills any pre-existing rows
 * (e.g. a 0.1.x DB upgrading in place). Returns true if FTS5 is usable.
 */
function setupFts(db: SqliteDatabase): boolean {
  if (!ftsSupported(db)) return false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        key, value, tags,
        content='memory',
        content_rowid='rowid',
        tokenize='porter unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, key, value, tags)
        VALUES (new.rowid, new.key, new.value, COALESCE(new.tags, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
        VALUES ('delete', old.rowid, old.key, old.value, COALESCE(old.tags, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
        VALUES ('delete', old.rowid, old.key, old.value, COALESCE(old.tags, ''));
        INSERT INTO memory_fts(rowid, key, value, tags)
        VALUES (new.rowid, new.key, new.value, COALESCE(new.tags, ''));
      END;
    `);

    // Backfill rows that predate the FTS index (in-place upgrade from 0.1.x).
    const ftsCount = db
      .prepare<unknown[], { c: number }>("SELECT COUNT(*) AS c FROM memory_fts")
      .get();
    const memCount = db
      .prepare<unknown[], { c: number }>("SELECT COUNT(*) AS c FROM memory")
      .get();
    if ((ftsCount?.c ?? 0) === 0 && (memCount?.c ?? 0) > 0) {
      db.exec(
        "INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');",
      );
    }
    return true;
  } catch {
    // If anything in FTS setup fails we degrade gracefully to LIKE search.
    return false;
  }
}

/**
 * Whether the current connection has a usable FTS5 index. Used by the search
 * tool to decide between FTS5 ranking and the LIKE fallback.
 */
export function isFtsReady(): boolean {
  getDb(); // ensure connection + cachedFtsReady are initialized
  return cachedFtsReady === true;
}

/**
 * Build an FTS5 MATCH expression from a free-form user query. Each whitespace
 * token is matched both as a stemmed phrase (`"tok"`) and as a prefix
 * (`"tok"*`), OR-combined so partial words and word-stems both hit. Quoting
 * every token neutralizes FTS5 operators (AND/OR/NOT/NEAR) and punctuation
 * that would otherwise be a syntax error. Returns null if the query has no
 * usable tokens.
 */
export function buildFtsMatch(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    // Double-quote is the FTS5 phrase delimiter — strip it so a quote inside a
    // token can't break out of the phrase.
    .map((t) => t.replace(/"/g, " ").trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `("${t}" OR "${t}"*)`).join(" OR ");
}

/**
 * Close cached connection. Mostly for tests / clean shutdown.
 */
export function closeDb(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
    cachedPath = null;
    cachedFtsReady = null;
    stmtCache.clear();
  }
}

/**
 * Prepare (or reuse) a statement for the current connection. Statements are
 * cached by SQL text so hot read paths don't recompile SQLite bytecode on
 * every call. Cleared automatically when the connection changes.
 */
export function prepareCached<T extends unknown[] = unknown[], R = unknown>(
  sql: string,
): SqliteStatement<T, R> {
  const cached = stmtCache.get(sql) as SqliteStatement<T, R> | undefined;
  if (cached) return cached;
  const stmt = getDb().prepare<T, R>(sql);
  stmtCache.set(sql, stmt);
  return stmt;
}

/**
 * Lazy-delete expired rows. Called on every read path. Cheap because of the
 * partial index on ttl_expires_at. Returns number of rows deleted.
 */
export function sweepExpired(now: number = Date.now()): number {
  const stmt = prepareCached<[number], { changes: number }>(
    "DELETE FROM memory WHERE ttl_expires_at IS NOT NULL AND ttl_expires_at <= ?",
  );
  const info = stmt.run(now);
  return info.changes;
}

/**
 * Returns DB file size in bytes, or 0 if file does not exist.
 */
export function getDbSizeBytes(): number {
  const path = resolveDbPath();
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Serialize a tag array into the format we LIKE-search against:
 * leading and trailing comma so `tags LIKE '%,foo,%'` is unambiguous.
 */
export function encodeTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  const clean = tags
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !t.includes(","));
  if (clean.length === 0) return null;
  return "," + clean.join(",") + ",";
}

export function decodeTags(tagBlob: string | null): string[] | null {
  if (!tagBlob) return null;
  const parts = tagBlob.split(",").filter((p) => p.length > 0);
  return parts.length > 0 ? parts : null;
}

export function tagLikePattern(tag: string): string {
  const escaped = tag.replace(/[\\%_]/g, "\\$&");
  return `%,${escaped},%`;
}
