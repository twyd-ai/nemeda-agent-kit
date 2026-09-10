// Machine-local query cache for project memory (docs/memory-plan.md,
// "Project memory: journals on the drive, SQLite as the index").
//
// The journals on the shared drive stay the only source of truth. This
// module keeps a disposable SQLite copy of their latest revisions in
// `.nemeda/state/memory.sqlite` — local to each machine, gitignored with the
// rest of `.nemeda/state/`, and never placed on the drive: a cloud sync
// client does not honour SQLite's cross-machine locking, so a shared index
// file would bring back the exact corruption risk the per-author journals
// exist to avoid. Deleting the file is always safe; the next query rebuilds
// it.
//
// What the index saves is re-reading and re-parsing every journal on every
// query: it is rebuilt only when the journal fingerprint (each file's name,
// size, and mtime) changes, and queries otherwise hit the prebuilt table.
//
// Search semantics deliberately match the reference engine in memory.mjs
// (searchEntries) instead of using FTS5: FTS matches whole tokens, so
// "drive" would stop finding "OneDrive", and the accelerated path would
// quietly return different results from the fallback. Each entry is stored
// with the same lowercased haystack the reference builds, and scoring uses
// instr() — a substring test equivalent to String#includes — so both engines
// return the same entries in the same order (score, then
// compareEntriesNewestFirst: date, createdAt, id).
//
// Engines, in order: node:sqlite (Node 22.13+ / 23.4+, real prepared
// statements), the `sqlite3` CLI (present on macOS and most Linux), and the
// in-memory reference engine. Any engine failure falls back to the reference
// engine for that call and says so; a query never fails because the cache
// did.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { compareEntriesNewestFirst, latestRevisions, readAllJournals, searchEntries } from "./memory.mjs";

const INDEX_SCHEMA_VERSION = "2";
const ENGINE_NAMES = ["node-sqlite", "sqlite3-cli", "memory"];

export function indexPath(root) {
  return path.join(root, ".nemeda", "state", "memory.sqlite");
}

export function memoryRootFor(root, config) {
  return path.join(root, config.memory.project.path);
}

// Name, size, and mtime of every journal: cheap to compute (one stat per
// author) and changes whenever any author appends, which is the only way
// the source of truth ever changes.
export function journalFingerprint(memoryRoot) {
  const journalDir = path.join(memoryRoot, "journal");
  if (!existsSync(journalDir)) return "[]";
  const files = readdirSync(journalDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => {
      const stat = statSync(path.join(journalDir, name));
      return [name, stat.size, Math.round(stat.mtimeMs)];
    });
  return JSON.stringify(files);
}

function loadNodeSqlite() {
  // process.getBuiltinModule is synchronous (Node 22.3+); on older runtimes
  // it does not exist, and on 22.5–22.12 node:sqlite still needs a flag, so
  // any failure simply means "not available here".
  if (typeof process.getBuiltinModule !== "function") return null;
  try {
    const sqlite = process.getBuiltinModule("node:sqlite");
    return sqlite?.DatabaseSync ? sqlite : null;
  } catch {
    return null;
  }
}

function sqliteBinary(environment) {
  return environment.NEMEDA_SQLITE_BIN || "sqlite3";
}

function sqliteCliAvailable(environment) {
  const result = spawnSync(sqliteBinary(environment), ["-version"], { encoding: "utf8", timeout: 5000 });
  return !result.error && result.status === 0;
}

// NEMEDA_MEMORY_INDEX_ENGINE forces an engine (tests, or pinning one on a
// machine where auto-detection picks badly); otherwise the first available.
export function selectIndexEngine(environment = process.env) {
  const forced = environment.NEMEDA_MEMORY_INDEX_ENGINE;
  if (forced) {
    if (!ENGINE_NAMES.includes(forced)) {
      return { name: "memory", reason: `NEMEDA_MEMORY_INDEX_ENGINE="${forced}" is not one of ${ENGINE_NAMES.join(", ")}; using the in-memory engine` };
    }
    return { name: forced, reason: "set by NEMEDA_MEMORY_INDEX_ENGINE" };
  }
  if (loadNodeSqlite()) return { name: "node-sqlite", reason: "node:sqlite is available in this Node runtime" };
  if (sqliteCliAvailable(environment)) return { name: "sqlite3-cli", reason: `${sqliteBinary(environment)} is on PATH` };
  return { name: "memory", reason: "neither node:sqlite nor a sqlite3 binary is available; scanning journals directly" };
}

function haystackFor(entry) {
  return `${entry.title} ${entry.summary} ${(entry.tags || []).join(" ")}`.toLowerCase();
}

function currentEntries(memoryRoot) {
  const { entries } = readAllJournals(memoryRoot);
  return latestRevisions(entries).sort(compareEntriesNewestFirst);
}

const CREATE_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  author TEXT NOT NULL,
  status TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  haystack TEXT NOT NULL,
  entry_json TEXT NOT NULL
);
CREATE INDEX entries_date ON entries (date);
`;

// Only for the CLI engine, which has no parameter binding: every value that
// reaches SQL text goes through here. Doubling single quotes is the complete
// escaping rule for SQLite string literals; NUL is stripped because the CLI
// reads SQL as a C string.
function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("\u0000", "").replaceAll("'", "''")}'`;
}

function rowValues(entry) {
  return [entry.id, entry.type, entry.author, entry.status, entry.date, entry.createdAt, JSON.stringify(entry.tags || []), haystackFor(entry), JSON.stringify(entry)];
}

// Builds into a private temp file and renames it into place, so a reader in
// another process (the MCP server while the CLI rebuilds) only ever opens a
// complete index — never a half-written one.
function buildWithNodeSqlite(target, entries, fingerprint) {
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(target);
  try {
    db.exec(CREATE_SQL);
    const insertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    insertMeta.run("schema_version", INDEX_SCHEMA_VERSION);
    insertMeta.run("fingerprint", fingerprint);
    const insert = db.prepare("INSERT INTO entries (id, type, author, status, date, created_at, tags_json, haystack, entry_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    for (const entry of entries) insert.run(...rowValues(entry));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

function buildWithSqliteCli(target, entries, fingerprint, environment) {
  const statements = [
    CREATE_SQL,
    `INSERT INTO meta (key, value) VALUES ('schema_version', ${sqlString(INDEX_SCHEMA_VERSION)});`,
    `INSERT INTO meta (key, value) VALUES ('fingerprint', ${sqlString(fingerprint)});`,
    "BEGIN;",
    ...entries.map((entry) => `INSERT INTO entries (id, type, author, status, date, created_at, tags_json, haystack, entry_json) VALUES (${rowValues(entry).map(sqlString).join(", ")});`),
    "COMMIT;"
  ];
  const result = spawnSync(sqliteBinary(environment), ["-bail", target], { input: statements.join("\n"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${sqliteBinary(environment)} could not be started: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${sqliteBinary(environment)} failed building the index: ${String(result.stderr || "").trim().slice(0, 300)}`);
}

function readMetaWithNodeSqlite(target) {
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    const rows = db.prepare("SELECT key, value FROM meta").all();
    const count = db.prepare("SELECT COUNT(*) AS count FROM entries").get().count;
    return { meta: Object.fromEntries(rows.map((row) => [row.key, row.value])), count: Number(count) };
  } finally {
    db.close();
  }
}

function runCliQuery(target, sql, environment) {
  const result = spawnSync(sqliteBinary(environment), ["-json", "-readonly", "-bail", target], { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${sqliteBinary(environment)} could not be started: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${sqliteBinary(environment)} query failed: ${String(result.stderr || "").trim().slice(0, 300)}`);
  const text = String(result.stdout || "").trim();
  return text ? JSON.parse(text) : [];
}

function readMetaWithSqliteCli(target, environment) {
  const rows = runCliQuery(target, "SELECT key, value FROM meta;", environment);
  const [{ count }] = runCliQuery(target, "SELECT COUNT(*) AS count FROM entries;", environment);
  return { meta: Object.fromEntries(rows.map((row) => [row.key, row.value])), count: Number(count) };
}

function readMeta(engine, target, environment) {
  if (!existsSync(target)) return null;
  try {
    return engine === "node-sqlite" ? readMetaWithNodeSqlite(target) : readMetaWithSqliteCli(target, environment);
  } catch {
    // An unreadable or foreign file counts as stale: the rebuild replaces it.
    return null;
  }
}

// Status without side effects: which engine, where the file is, whether it
// matches the journals right now, and how many entries it holds.
export function indexStatus(root, config, { environment = process.env } = {}) {
  const engine = selectIndexEngine(environment);
  const target = indexPath(root);
  if (engine.name === "memory") {
    return { engine: engine.name, reason: engine.reason, path: null, exists: false, fresh: true, count: null };
  }
  const fingerprint = journalFingerprint(memoryRootFor(root, config));
  const meta = readMeta(engine.name, target, environment);
  return {
    engine: engine.name,
    reason: engine.reason,
    path: target,
    exists: existsSync(target),
    fresh: Boolean(meta) && meta.meta.schema_version === INDEX_SCHEMA_VERSION && meta.meta.fingerprint === fingerprint,
    count: meta ? meta.count : null
  };
}

// Rebuilds from the journals when stale (or always, with force). Returns
// what happened; throws only for a genuine engine failure, which queryEntries
// turns into a fallback rather than an error.
export function rebuildIndex(root, config, { environment = process.env, force = false } = {}) {
  const engine = selectIndexEngine(environment);
  if (engine.name === "memory") return { engine: engine.name, reason: engine.reason, rebuilt: false, count: null, path: null };
  const target = indexPath(root);
  const memoryRoot = memoryRootFor(root, config);
  const fingerprint = journalFingerprint(memoryRoot);
  if (!force) {
    const meta = readMeta(engine.name, target, environment);
    if (meta && meta.meta.schema_version === INDEX_SCHEMA_VERSION && meta.meta.fingerprint === fingerprint) {
      return { engine: engine.name, reason: engine.reason, rebuilt: false, count: meta.count, path: target };
    }
  }
  const entries = currentEntries(memoryRoot);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  rmSync(temporary, { force: true });
  try {
    if (engine.name === "node-sqlite") buildWithNodeSqlite(temporary, entries, fingerprint);
    else buildWithSqliteCli(temporary, entries, fingerprint, environment);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { engine: engine.name, reason: engine.reason, rebuilt: true, count: entries.length, path: target };
}

function queryWords(query) {
  const trimmed = (query || "").trim();
  return trimmed ? trimmed.toLowerCase().split(/\s+/).filter(Boolean) : [];
}

// The SELECT shared by both SQLite engines. `bind` returns either a `?`
// placeholder (node:sqlite, values collected in call order) or an escaped
// literal (CLI engine). With placeholders, call order must equal the order
// the `?`s appear in the final SQL text — the scoring expression comes
// before the WHERE clause, so the query words are bound first.
function buildSelect({ query, filters = {} }, bind) {
  const words = queryWords(query);
  const hits = words.map((word) => `(instr(haystack, ${bind(word)}) > 0)`).join(" + ");
  const conditions = [];
  if (filters.type) conditions.push(`type = ${bind(filters.type)}`);
  if (filters.author) conditions.push(`author = ${bind(filters.author)}`);
  if (filters.status) conditions.push(`status = ${bind(filters.status)}`);
  if (filters.since) conditions.push(`date >= ${bind(filters.since)}`);
  if (filters.tag) conditions.push(`EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ${bind(filters.tag)})`);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const newestFirst = "date DESC, created_at DESC, id DESC";
  if (!words.length) return `SELECT entry_json FROM entries ${where} ORDER BY ${newestFirst}`;
  return `SELECT entry_json FROM (SELECT entry_json, date, created_at, id, (${hits}) * 1.0 / ${words.length} AS score FROM entries ${where}) WHERE score > 0 ORDER BY score DESC, ${newestFirst}`;
}

function queryWithNodeSqlite(target, request) {
  const { DatabaseSync } = loadNodeSqlite();
  const params = [];
  const sql = buildSelect(request, (value) => {
    params.push(value);
    return "?";
  });
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    return db.prepare(sql).all(...params).map((row) => JSON.parse(row.entry_json));
  } finally {
    db.close();
  }
}

function queryWithSqliteCli(target, request, environment) {
  return runCliQuery(target, `${buildSelect(request, sqlString)};`, environment).map((row) => JSON.parse(row.entry_json));
}

function queryInMemory(root, config, { query, filters = {} }) {
  return searchEntries(currentEntries(memoryRootFor(root, config)), query || "", filters);
}

// The one entry point list/search/MCP use. Rebuilds the index first when the
// journals changed, then queries it; on any engine failure answers from the
// reference engine instead and reports `fallback` with the reason.
export function queryEntries(root, config, request = {}, { environment = process.env } = {}) {
  const engine = selectIndexEngine(environment);
  if (engine.name === "memory") {
    return { engine: engine.name, entries: queryInMemory(root, config, request) };
  }
  try {
    rebuildIndex(root, config, { environment });
    const target = indexPath(root);
    const entries = engine.name === "node-sqlite" ? queryWithNodeSqlite(target, request) : queryWithSqliteCli(target, request, environment);
    return { engine: engine.name, entries };
  } catch (error) {
    return {
      engine: "memory",
      fallback: `${engine.name} failed (${error instanceof Error ? error.message : String(error)}); answered from the journals directly`,
      entries: queryInMemory(root, config, request)
    };
  }
}
