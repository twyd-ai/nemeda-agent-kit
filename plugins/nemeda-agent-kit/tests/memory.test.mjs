import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendEntry,
  createEntry,
  digestsPath,
  filterEntries,
  generateEntryId,
  journalPath,
  latestRevisions,
  readAllJournals,
  readJournal,
  recordEntry,
  reviseEntry,
  searchEntries,
  validateEntry
} from "../scripts/lib/memory.mjs";

function makeConfiguredWorkspace({ memory = { project: { path: "memory" } }, repository = { id: "acme", role: "backend", profiles: [] } } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-memory-workspace-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(
    path.join(root, ".nemeda", "agent-kit.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: "acme", name: "Acme" },
      repository,
      context: { instructions: ["AGENTS.md"] },
      tools: { required: [], optional: [] },
      policies: { protectSecrets: true },
      ...(memory ? { memory } : {})
    })
  );
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  return root;
}

function tempMemoryRoot() {
  return mkdtempSync(path.join(tmpdir(), "nemeda-memory-"));
}

function baseEntry(overrides = {}) {
  return createEntry({
    project: "acme",
    type: "decision",
    title: "Ship the thing",
    author: "miquel@nemeda.io",
    summary: "We decided to ship the thing on Tuesday.",
    ...overrides
  });
}

test("generateEntryId produces sortable, fixed-length Crockford base32 ULIDs", () => {
  const first = generateEntryId(1_700_000_000_000);
  const second = generateEntryId(1_700_000_000_001);
  assert.equal(first.length, 26);
  assert.match(first, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(first < second, "later timestamp sorts after an earlier one");
  // No two I/L/O/U characters, ever.
  assert.doesNotMatch(first, /[ILOU]/);
});

test("createEntry fills in every required field with sensible defaults", () => {
  const entry = createEntry({
    project: "acme",
    type: "finding",
    title: "Something odd",
    author: "a@b.com",
    summary: "Found something odd in the logs."
  });
  assert.deepEqual(validateEntry(entry), []);
  assert.equal(entry.revision, 1);
  assert.equal(entry.status, "pending");
  assert.deepEqual(entry.tags, []);
  assert.equal(entry.clientSummary, null);
  assert.deepEqual(entry.source, { kind: "manual" });
  assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
});

test("reviseEntry keeps the id, bumps the revision, and refreshes createdAt", async () => {
  const entry = baseEntry();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const revised = reviseEntry(entry, { status: "reviewed", summary: "Reviewed: shipped Tuesday as planned." });
  assert.equal(revised.id, entry.id);
  assert.equal(revised.revision, 2);
  assert.equal(revised.status, "reviewed");
  assert.notEqual(revised.createdAt, entry.createdAt);
  assert.deepEqual(validateEntry(revised), []);
  // reviseEntry never mutates its input.
  assert.equal(entry.revision, 1);
  assert.equal(entry.status, "pending");
});

test("validateEntry reports every violation, not just the first", () => {
  const errors = validateEntry({ type: "not-a-type", tags: "nope", source: { kind: "nope" } });
  assert.ok(errors.length >= 5);
  assert.ok(errors.some((message) => message.includes("id")));
  assert.ok(errors.some((message) => message.includes("type must be one of")));
  assert.ok(errors.some((message) => message.includes("tags")));
  assert.ok(errors.some((message) => message.includes("source.kind")));
  assert.deepEqual(validateEntry(null), ["entry must be an object"]);
  assert.deepEqual(validateEntry([1, 2]), ["entry must be an object"]);
});

test("appendEntry rejects an invalid entry and never touches the journal", () => {
  const root = tempMemoryRoot();
  assert.throws(() => appendEntry(root, { type: "decision" }), /Invalid memory entry/);
  assert.equal(existsSync(path.join(root, "journal")), false);
});

test("journal round-trip: append, then read back exactly what was written", () => {
  const root = tempMemoryRoot();
  const entry = baseEntry();
  appendEntry(root, entry);
  assert.equal(existsSync(journalPath(root, entry.author)), true);
  const { entries, malformed } = readJournal(journalPath(root, entry.author));
  assert.deepEqual(malformed, []);
  assert.deepEqual(entries, [entry]);
});

test("revision precedence: the newest revision wins regardless of read order", () => {
  const root = tempMemoryRoot();
  const original = baseEntry();
  appendEntry(root, original);
  const revised = reviseEntry(original, { status: "reviewed" });
  appendEntry(root, revised);
  const { entries } = readAllJournals(root);
  assert.equal(entries.length, 2, "both revisions are physically present in the journal");
  const latest = latestRevisions(entries);
  assert.equal(latest.length, 1, "deduped to one logical entry");
  assert.equal(latest[0].revision, 2);
  assert.equal(latest[0].status, "reviewed");
});

test("readJournal skips malformed or invalid lines instead of throwing", () => {
  const root = tempMemoryRoot();
  const file = journalPath(root, "a@b.com");
  mkdirSync(path.dirname(file), { recursive: true });
  const good = baseEntry({ author: "a@b.com" });
  writeFileSync(
    file,
    [
      "not even json",
      JSON.stringify({ type: "decision" }), // valid JSON, invalid entry
      JSON.stringify(good),
      "" // trailing blank line
    ].join("\n")
  );
  const { entries, malformed } = readJournal(file);
  assert.deepEqual(entries, [good]);
  assert.equal(malformed.length, 2);
  assert.equal(malformed[0].line, 1);
  assert.match(malformed[0].reason, /invalid JSON/);
  assert.equal(malformed[1].line, 2);
});

test("readAllJournals reads every author and reports which files it found", () => {
  const root = tempMemoryRoot();
  const alice = baseEntry({ author: "alice@nemeda.io", title: "Alice's decision" });
  const bob = baseEntry({ author: "bob@nemeda.io", title: "Bob's finding", type: "finding" });
  appendEntry(root, alice);
  appendEntry(root, bob);
  writeFileSync(path.join(root, "journal", "not-a-journal.txt"), "ignored");
  const result = readAllJournals(root);
  assert.deepEqual(result.authors.sort(), ["alice@nemeda.io", "bob@nemeda.io"]);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.malformed, []);
});

test("readAllJournals and readJournal are no-ops on a memory root that does not exist yet", () => {
  const root = path.join(tempMemoryRoot(), "not-created-yet");
  assert.deepEqual(readAllJournals(root), { entries: [], malformed: [], authors: [] });
  assert.deepEqual(readJournal(journalPath(root, "a@b.com")), { entries: [], malformed: [] });
});

test("filterEntries applies every filter independently", () => {
  const entries = [
    baseEntry({ type: "decision", author: "a@b.com", status: "pending", date: "2026-01-01", tags: ["architecture"] }),
    baseEntry({ type: "finding", author: "c@d.com", status: "reviewed", date: "2026-06-01", tags: ["api"] })
  ];
  assert.equal(filterEntries(entries, { type: "decision" }).length, 1);
  assert.equal(filterEntries(entries, { author: "c@d.com" }).length, 1);
  assert.equal(filterEntries(entries, { status: "reviewed" }).length, 1);
  assert.equal(filterEntries(entries, { since: "2026-03-01" }).length, 1);
  assert.equal(filterEntries(entries, { tag: "api" }).length, 1);
  assert.equal(filterEntries(entries, {}).length, 2);
  assert.equal(filterEntries(entries, { type: "decision", tag: "api" }).length, 0);
});

test("searchEntries ranks by word overlap and returns everything for an empty query", () => {
  const entries = [
    baseEntry({ title: "Switch to OneDrive", summary: "Adopted onedrive as a second drive provider.", date: "2026-01-01" }),
    baseEntry({ title: "Unrelated meeting notes", summary: "Talked about lunch.", date: "2026-02-01" }),
    baseEntry({ title: "OneDrive rollout", summary: "Rolled out onedrive support to every project.", date: "2026-03-01" })
  ];
  const results = searchEntries(entries, "onedrive");
  assert.equal(results.length, 2);
  assert.ok(results.every((entry) => /onedrive/i.test(`${entry.title} ${entry.summary}`)));
  // Same score for both matches (one word, one hit each): most recent first.
  assert.equal(results[0].date, "2026-03-01");
  assert.deepEqual(searchEntries(entries, ""), entries);
  assert.deepEqual(searchEntries(entries, "   "), entries);
  assert.equal(searchEntries(entries, "nothing matches this"). length, 0);
});

test("searchEntries composes with the other filters", () => {
  const entries = [
    baseEntry({ title: "OneDrive plan", summary: "onedrive", type: "decision" }),
    baseEntry({ title: "OneDrive bug", summary: "onedrive", type: "finding" })
  ];
  assert.equal(searchEntries(entries, "onedrive", { type: "finding" }).length, 1);
});

test("journalPath and digestsPath resolve inside the memory root", () => {
  const root = "/tmp/example-memory";
  assert.equal(journalPath(root, "a@b.com"), path.join(root, "journal", "a@b.com.jsonl"));
  assert.equal(digestsPath(root), path.join(root, "digests"));
});

test("recordEntry appends a valid entry using the workspace's own project, repository, and git author", () => {
  const root = makeConfiguredWorkspace();
  const result = recordEntry(root, {
    type: "meeting",
    title: "Standup 2026-09-10",
    summary: "Discussed the memory rollout.",
    source: "meeting",
    links: { transcript: "docs/transcripts/2026-09-10-standup" }
  });
  assert.equal(result.path, journalPath(path.join(root, "memory"), "test@example.com"));
  const { entries } = readJournal(result.path);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.id, result.id);
  assert.equal(entry.project, "acme");
  assert.equal(entry.repository, "acme");
  assert.equal(entry.type, "meeting");
  assert.equal(entry.author, "test@example.com");
  assert.equal(entry.status, "pending");
  assert.deepEqual(entry.source, { kind: "meeting", transcript: "docs/transcripts/2026-09-10-standup" });
});

test("recordEntry maps type: \"session\" to an ai-interaction entry with source.kind session", () => {
  const root = makeConfiguredWorkspace();
  const result = recordEntry(root, { type: "session", title: "Session log", summary: "Did stuff." });
  const { entries } = readJournal(result.path);
  assert.equal(entries[0].type, "ai-interaction");
  assert.deepEqual(entries[0].source, { kind: "session" });
});

test("recordEntry returns null, never throws, when memory is not configured", () => {
  const root = makeConfiguredWorkspace({ memory: null });
  assert.equal(recordEntry(root, { type: "meeting", title: "x", summary: "x" }), null);
});

test("recordEntry returns null on an invalid entry instead of writing a broken journal line", () => {
  const root = makeConfiguredWorkspace();
  assert.equal(recordEntry(root, { type: "not-a-real-type", title: "x", summary: "x" }), null);
  assert.equal(existsSync(path.join(root, "memory", "journal")), false);
});

test("recordEntry returns null outside any configured workspace", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-memory-unconfigured-"));
  assert.equal(recordEntry(root, { type: "meeting", title: "x", summary: "x" }), null);
});
