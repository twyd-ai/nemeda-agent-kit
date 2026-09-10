// The machine-local query index (scripts/lib/memory-index.mjs) must return
// exactly what the in-memory reference engine returns, in the same order,
// for every engine this runtime can offer. node:sqlite is only exercised on
// Node 22.13+ (the suite's minimum is Node 20, where it is skipped); the
// sqlite3 CLI is exercised wherever the binary exists, and a stub binary
// covers the failure/fallback path everywhere.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEntry, createEntry, reviseEntry } from "../scripts/lib/memory.mjs";
import { indexPath, indexStatus, journalFingerprint, queryEntries, rebuildIndex, selectIndexEngine } from "../scripts/lib/memory-index.mjs";

const hasNodeSqlite = typeof process.getBuiltinModule === "function" && (() => {
  try {
    return Boolean(process.getBuiltinModule("node:sqlite")?.DatabaseSync);
  } catch {
    return false;
  }
})();
const hasSqliteCli = (() => {
  const result = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
})();

const config = { project: { id: "acme", name: "Acme" }, memory: { project: { path: "memory" } } };

function workspace() {
  return mkdtempSync(path.join(tmpdir(), "nemeda-memory-index-"));
}

function entry(overrides) {
  return createEntry({ project: "acme", type: "finding", author: "a@example.com", summary: "Summary.", title: "Title", ...overrides });
}

// A corpus built to exercise every ordering and matching edge: equal scores
// on the same date (tie-break by createdAt, then id), a substring that is
// not a whole token ("drive" inside "OneDrive"), SQL-hostile text, non-ASCII,
// tags, several authors, and a superseded revision that must not appear.
function seed(root) {
  const memoryRoot = path.join(root, "memory");
  const sameDay = "2026-09-10";
  const pairA = entry({ title: "OneDrive rollout", summary: "Shipped onedrive support.", date: sameDay, createdAt: "2026-09-10T08:00:00.000Z", tags: ["drive"] });
  const pairB = entry({ title: "OneDrive bug", summary: "A onedrive sync bug.", date: sameDay, createdAt: "2026-09-10T09:00:00.000Z", author: "b@example.com" });
  const hostile = entry({ title: "It's 100% \"quoted\"", summary: "'; DROP TABLE entries; -- and a\nnewline", date: "2026-08-01", type: "decision" });
  const unicode = entry({ title: "Reunión de diseño", summary: "Decidimos usar Ñandú y emojis 🚀.", date: "2026-07-01", type: "meeting", tags: ["diseño"] });
  const older = entry({ title: "Old finding", summary: "Unrelated.", date: "2026-01-01" });
  const draft = entry({ title: "Draft title", summary: "First draft about drive.", date: "2026-06-01" });
  for (const item of [pairA, pairB, hostile, unicode, older, draft]) appendEntry(memoryRoot, item);
  appendEntry(memoryRoot, reviseEntry(draft, { status: "reviewed", summary: "Reviewed and rewritten." }));
  return { memoryRoot, pairA, pairB, draft };
}

const REQUESTS = [
  { query: "onedrive" },
  { query: "drive" },
  { query: "" },
  { query: "ONEDRIVE bug" },
  { query: "it's 100%" },
  { query: "'; drop table entries; --" },
  { query: "ñandú 🚀" },
  { query: "no match at all" },
  { query: "", filters: { type: "finding" } },
  { query: "", filters: { author: "b@example.com" } },
  { query: "", filters: { status: "reviewed" } },
  { query: "", filters: { since: "2026-07-01" } },
  { query: "", filters: { tag: "diseño" } },
  { query: "drive", filters: { type: "finding", since: "2026-09-01" } },
  // Words and filters together: with placeholders, bind order must follow
  // SQL text order (this combination caught exactly that bug on node:sqlite).
  { query: "onedrive sync", filters: { author: "b@example.com", status: "pending", tag: "nope" } },
  { query: "onedrive sync", filters: { author: "b@example.com", status: "pending" } }
];

function ids(answer) {
  return answer.entries.map((item) => item.id);
}

function assertParity(root, engine) {
  for (const request of REQUESTS) {
    const reference = queryEntries(root, config, request, { environment: { NEMEDA_MEMORY_INDEX_ENGINE: "memory" } });
    const answer = queryEntries(root, config, request, { environment: { ...process.env, NEMEDA_MEMORY_INDEX_ENGINE: engine } });
    assert.equal(answer.fallback, undefined, `${engine} fell back for ${JSON.stringify(request)}: ${answer.fallback}`);
    assert.equal(answer.engine, engine);
    assert.deepEqual(ids(answer), ids(reference), `${engine} disagrees with the reference for ${JSON.stringify(request)}`);
  }
}

test("the reference engine itself: substring match, deterministic ties, newest revision only", () => {
  const root = workspace();
  const { pairA, pairB, draft } = seed(root);
  const drive = queryEntries(root, config, { query: "drive" }, { environment: { NEMEDA_MEMORY_INDEX_ENGINE: "memory" } });
  // "drive" is not a whole word in "OneDrive": substring matching still finds it.
  assert.ok(ids(drive).includes(pairA.id) && ids(drive).includes(pairB.id));
  // Same score, same date: the later createdAt comes first.
  const onedrive = ids(queryEntries(root, config, { query: "onedrive" }, { environment: { NEMEDA_MEMORY_INDEX_ENGINE: "memory" } }));
  assert.deepEqual(onedrive.slice(0, 2), [pairB.id, pairA.id]);
  // The superseded revision's text no longer matches; the new one does.
  assert.ok(!ids(drive).includes(draft.id), "a revised entry is searched by its latest text only");
  const all = queryEntries(root, config, {}, { environment: { NEMEDA_MEMORY_INDEX_ENGINE: "memory" } });
  assert.equal(all.entries.filter((item) => item.id === draft.id).length, 1);
  assert.equal(all.entries.find((item) => item.id === draft.id).status, "reviewed");
});

test("sqlite3 CLI engine matches the reference exactly", { skip: !hasSqliteCli && "no sqlite3 binary on this machine" }, () => {
  const root = workspace();
  seed(root);
  assertParity(root, "sqlite3-cli");
  assert.ok(existsSync(indexPath(root)), "the index file lives under .nemeda/state/");
  assert.equal(path.relative(root, indexPath(root)), path.join(".nemeda", "state", "memory.sqlite"));
});

test("node:sqlite engine matches the reference exactly", { skip: !hasNodeSqlite && "node:sqlite needs Node 22.13+" }, () => {
  const root = workspace();
  seed(root);
  assertParity(root, "node-sqlite");
});

test("the index rebuilds only when the journals change", { skip: !hasSqliteCli && "no sqlite3 binary on this machine" }, () => {
  const root = workspace();
  const { memoryRoot } = seed(root);
  const environment = { ...process.env, NEMEDA_MEMORY_INDEX_ENGINE: "sqlite3-cli" };

  const first = rebuildIndex(root, config, { environment });
  assert.equal(first.rebuilt, true);
  assert.equal(first.count, 6, "six entries, the revised one counted once");

  const second = rebuildIndex(root, config, { environment });
  assert.equal(second.rebuilt, false, "nothing changed, nothing rebuilt");
  assert.equal(indexStatus(root, config, { environment }).fresh, true);

  const fingerprintBefore = journalFingerprint(memoryRoot);
  appendEntry(memoryRoot, entry({ title: "Brand new", summary: "Added after the first build." }));
  assert.notEqual(journalFingerprint(memoryRoot), fingerprintBefore);
  assert.equal(indexStatus(root, config, { environment }).fresh, false, "an append makes the index stale");

  // "brand" alone: "new" would also match "newline" in another entry
  // (substring semantics, identical on every engine).
  const answer = queryEntries(root, config, { query: "brand" }, { environment });
  assert.equal(answer.entries.length, 1, "the next query rebuilt and found the new entry");
  assert.equal(indexStatus(root, config, { environment }).fresh, true);

  const forced = rebuildIndex(root, config, { environment, force: true });
  assert.equal(forced.rebuilt, true);
  assert.equal(forced.count, 7);
});

test("a deleted or corrupt index file is simply rebuilt", { skip: !hasSqliteCli && "no sqlite3 binary on this machine" }, () => {
  const root = workspace();
  seed(root);
  const environment = { ...process.env, NEMEDA_MEMORY_INDEX_ENGINE: "sqlite3-cli" };
  queryEntries(root, config, {}, { environment });
  rmSync(indexPath(root));
  assert.equal(queryEntries(root, config, { query: "onedrive" }, { environment }).entries.length, 2);
  writeFileSync(indexPath(root), "this is not a sqlite database");
  const answer = queryEntries(root, config, { query: "onedrive" }, { environment });
  assert.equal(answer.fallback, undefined);
  assert.equal(answer.entries.length, 2);
});

test("an engine failure falls back to the journals and says so, never throwing", () => {
  const root = workspace();
  seed(root);
  const binDir = mkdtempSync(path.join(tmpdir(), "nemeda-memory-index-bin-"));
  const broken = path.join(binDir, "sqlite3");
  writeFileSync(broken, "#!/bin/sh\necho 'disk I/O error' 1>&2\nexit 1\n");
  chmodSync(broken, 0o755);
  const environment = { NEMEDA_MEMORY_INDEX_ENGINE: "sqlite3-cli", NEMEDA_SQLITE_BIN: broken };

  const answer = queryEntries(root, config, { query: "onedrive" }, { environment });
  assert.equal(answer.engine, "memory");
  assert.match(answer.fallback, /sqlite3-cli failed/);
  assert.equal(answer.entries.length, 2, "still the right answer, from the reference engine");
  assert.throws(() => rebuildIndex(root, config, { environment }), /failed building the index/, "an explicit rebuild does surface the failure");
});

test("engine selection: forced, unknown, and nothing available", () => {
  assert.equal(selectIndexEngine({ NEMEDA_MEMORY_INDEX_ENGINE: "memory" }).name, "memory");
  const unknown = selectIndexEngine({ NEMEDA_MEMORY_INDEX_ENGINE: "postgres" });
  assert.equal(unknown.name, "memory");
  assert.match(unknown.reason, /not one of/);
  if (!hasNodeSqlite) {
    const none = selectIndexEngine({ NEMEDA_SQLITE_BIN: "/no/such/sqlite3-binary" });
    assert.equal(none.name, "memory");
    assert.match(none.reason, /neither node:sqlite nor a sqlite3 binary/);
  }
});

test("the memory engine reports no index file and never creates one", () => {
  const root = workspace();
  seed(root);
  const environment = { NEMEDA_MEMORY_INDEX_ENGINE: "memory" };
  queryEntries(root, config, { query: "onedrive" }, { environment });
  assert.equal(existsSync(indexPath(root)), false);
  const status = indexStatus(root, config, { environment });
  assert.equal(status.engine, "memory");
  assert.equal(status.path, null);
  assert.equal(rebuildIndex(root, config, { environment }).rebuilt, false);
});

test("an empty or missing memory folder is an empty answer on every engine", () => {
  const root = workspace();
  mkdirSync(path.join(root, "memory"), { recursive: true });
  for (const engine of ["memory", ...(hasSqliteCli ? ["sqlite3-cli"] : []), ...(hasNodeSqlite ? ["node-sqlite"] : [])]) {
    const answer = queryEntries(root, config, { query: "anything" }, { environment: { ...process.env, NEMEDA_MEMORY_INDEX_ENGINE: engine } });
    assert.deepEqual(answer.entries, [], engine);
    assert.equal(answer.fallback, undefined, engine);
  }
});
