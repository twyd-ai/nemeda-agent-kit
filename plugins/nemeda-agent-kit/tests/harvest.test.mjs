import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readAllJournals } from "../scripts/lib/memory.mjs";
import {
  closedSessions,
  harvestClosedSessions,
  harvestHostNames,
  harvestSessionById,
  ledgerPath,
  markHarvested,
  readLedger,
  recordSessionActivity,
  resolveMemoryHookWorkspace
} from "../scripts/lib/harvest.mjs";

function makeWorkspace({ memory = true, email = "test@example.com" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-harvest-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(
    path.join(root, ".nemeda", "agent-kit.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: "acme", name: "Acme" },
      repository: { id: "acme", role: "backend", profiles: [] },
      context: { instructions: ["AGENTS.md"] },
      tools: { required: [], optional: [] },
      policies: { protectSecrets: true },
      ...(memory ? { memory: { project: { path: "memory" } } } : {})
    })
  );
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  if (email) execFileSync("git", ["config", "user.email", email], { cwd: root });
  return root;
}

// A stub CLI on disk: writes whatever `stdoutJson` is (already a string, so
// callers can hand it a raw non-JSON body too) to stdout and exits 0.
function stubHostBinary(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\n`);
  chmodSync(file, 0o755);
  return file;
}

function claudeEnvelope(resultText) {
  return JSON.stringify({ type: "result", subtype: "success", result: resultText });
}

test("recordSessionActivity upserts a ledger entry, preserving startedAt", async () => {
  const root = makeWorkspace();
  const first = recordSessionActivity(root, { sessionId: "s1", cwd: root, environment: { NEMEDA_AI_TOOL: "Claude Code", CLAUDE_MODEL: "claude-opus" } });
  assert.equal(first.tool, "claude");
  assert.equal(first.model, "claude-opus");
  assert.equal(first.harvestedAt, null);

  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = recordSessionActivity(root, { sessionId: "s1", cwd: root, environment: {} });
  assert.equal(second.startedAt, first.startedAt, "startedAt is preserved across updates");
  assert.notEqual(second.lastActivity, first.lastActivity, "lastActivity moves forward");

  const codex = recordSessionActivity(root, { sessionId: "s2", cwd: root, environment: { NEMEDA_AI_TOOL: "Codex" } });
  assert.equal(codex.tool, "codex");
});

test("recordSessionActivity with no sessionId is a no-op", () => {
  const root = makeWorkspace();
  assert.equal(recordSessionActivity(root, { cwd: root }), null);
});

test("closedSessions returns only idle, unharvested entries, oldest first", () => {
  const root = makeWorkspace();
  const ledger = {
    fresh: { tool: "claude", lastActivity: new Date().toISOString(), harvestedAt: null },
    "idle-recent": { tool: "claude", lastActivity: new Date(Date.now() - 40 * 60 * 1000).toISOString(), harvestedAt: null },
    "idle-old": { tool: "claude", lastActivity: new Date(Date.now() - 90 * 60 * 1000).toISOString(), harvestedAt: null },
    "already-harvested": { tool: "claude", lastActivity: new Date(Date.now() - 90 * 60 * 1000).toISOString(), harvestedAt: new Date().toISOString() }
  };
  mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  writeFileSync(ledgerPath(root), JSON.stringify(ledger));

  const closed = closedSessions(root, { idleMinutes: 30 });
  assert.deepEqual(
    closed.map((entry) => entry.sessionId),
    ["idle-old", "idle-recent"]
  );
});

test("readLedger tolerates a missing or corrupt file instead of throwing", () => {
  const root = makeWorkspace();
  assert.deepEqual(readLedger(root), {});
  mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  writeFileSync(ledgerPath(root), "not json");
  assert.deepEqual(readLedger(root), {});
});

test("markHarvested records entry ids and errors, and no-ops on an unknown session", () => {
  const root = makeWorkspace();
  recordSessionActivity(root, { sessionId: "s1", cwd: root, environment: {} });
  const updated = markHarvested(root, "s1", { entryIds: ["e1", "e2"] });
  assert.ok(updated.harvestedAt);
  assert.deepEqual(updated.harvestedEntryIds, ["e1", "e2"]);
  assert.equal(updated.harvestError, null);
  assert.equal(markHarvested(root, "does-not-exist", {}), null);
});

test("resolveMemoryHookWorkspace is null without a memory section, and non-null with one", () => {
  const withMemory = makeWorkspace({ memory: true });
  const withoutMemory = makeWorkspace({ memory: false });
  assert.ok(resolveMemoryHookWorkspace({ cwd: withMemory }));
  assert.equal(resolveMemoryHookWorkspace({ cwd: withoutMemory }), null);
  assert.equal(resolveMemoryHookWorkspace({ cwd: mkdtempSync(path.join(tmpdir(), "nemeda-harvest-none-")) }), null);
});

test("harvestSessionById resumes a stubbed claude CLI and files the resulting entries", () => {
  const root = makeWorkspace();
  const binDir = mkdtempSync(path.join(tmpdir(), "nemeda-harvest-bin-"));
  const claude = stubHostBinary(
    binDir,
    "fake-claude",
    claudeEnvelope(JSON.stringify([{ type: "finding", title: "Stubbed finding", summary: "From the stub.", tags: ["stub"] }]))
  );
  const config = JSON.parse(readFileSync(path.join(root, ".nemeda", "agent-kit.json"), "utf8"));

  const result = harvestSessionById(root, config, "session-1", { environment: { NEMEDA_CLAUDE_BIN: claude } });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].title, "Stubbed finding");
  assert.equal(result.created[0].source.sessionId, "session-1");
  assert.equal(result.created[0].source.tool, "claude");

  const { entries } = readAllJournals(path.join(root, "memory"));
  assert.equal(entries.length, 1);
});

test("harvestSessionById supports a Codex-shaped stub (plain text stdout)", () => {
  const root = makeWorkspace();
  const binDir = mkdtempSync(path.join(tmpdir(), "nemeda-harvest-bin-"));
  const codex = stubHostBinary(binDir, "fake-codex", JSON.stringify([{ type: "decision", title: "Codex stub", summary: "Decided via stub." }]));
  const config = JSON.parse(readFileSync(path.join(root, ".nemeda", "agent-kit.json"), "utf8"));

  const result = harvestSessionById(root, config, "session-codex", {
    environment: { NEMEDA_CODEX_BIN: codex }
  });
  // harvestSessionById defaults an unknown session to the "claude" host
  // unless the ledger says otherwise, so record it as a Codex session first.
  assert.equal(result.ok, false, "sanity: unlisted session defaults to claude, so the codex stub was never called");

  recordSessionActivity(root, { sessionId: "session-codex", cwd: root, environment: { NEMEDA_AI_TOOL: "Codex" } });
  const retried = harvestSessionById(root, config, "session-codex", { environment: { NEMEDA_CODEX_BIN: codex } });
  assert.equal(retried.ok, true);
  assert.equal(retried.created[0].source.tool, "codex");
});

test("a dry run resumes the host but writes nothing and does not mark the ledger", () => {
  const root = makeWorkspace();
  const binDir = mkdtempSync(path.join(tmpdir(), "nemeda-harvest-bin-"));
  const claude = stubHostBinary(binDir, "fake-claude", claudeEnvelope(JSON.stringify([{ type: "finding", title: "x", summary: "y" }])));
  recordSessionActivity(root, { sessionId: "session-1", cwd: root, environment: {} });
  const config = JSON.parse(readFileSync(path.join(root, ".nemeda", "agent-kit.json"), "utf8"));

  const result = harvestSessionById(root, config, "session-1", { environment: { NEMEDA_CLAUDE_BIN: claude }, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 1);
  assert.deepEqual(readAllJournals(path.join(root, "memory")).entries, []);
  assert.equal(readLedger(root)["session-1"].harvestedAt, null);
});

test("a missing binary, a non-zero exit, and unparseable output are all reported and marked harvested, never fabricated", () => {
  const root = makeWorkspace();
  const config = JSON.parse(readFileSync(path.join(root, ".nemeda", "agent-kit.json"), "utf8"));
  recordSessionActivity(root, { sessionId: "missing-bin", cwd: root, environment: {} });
  const missing = harvestSessionById(root, config, "missing-bin", { environment: { NEMEDA_CLAUDE_BIN: "/no/such/binary-xyz" } });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /could not be started/);
  assert.ok(readLedger(root)["missing-bin"].harvestedAt, "a permanently broken session is still marked harvested, so it is not retried forever");

  const binDir = mkdtempSync(path.join(tmpdir(), "nemeda-harvest-bin-"));
  const failing = path.join(binDir, "fake-claude-fail");
  writeFileSync(failing, "#!/bin/sh\necho boom 1>&2\nexit 1\n");
  chmodSync(failing, 0o755);
  recordSessionActivity(root, { sessionId: "nonzero-exit", cwd: root, environment: {} });
  const failed = harvestSessionById(root, config, "nonzero-exit", { environment: { NEMEDA_CLAUDE_BIN: failing } });
  assert.equal(failed.ok, false);
  assert.match(failed.errors[0], /exited with status 1/);

  const bogus = stubHostBinary(binDir, "fake-claude-bogus", claudeEnvelope("this is prose, not JSON"));
  recordSessionActivity(root, { sessionId: "bad-json", cwd: root, environment: {} });
  const badJson = harvestSessionById(root, config, "bad-json", { environment: { NEMEDA_CLAUDE_BIN: bogus } });
  assert.equal(badJson.ok, false);
  assert.match(badJson.errors[0], /not valid JSON/);

  assert.deepEqual(readAllJournals(path.join(root, "memory")).entries, [], "nothing was ever written for any of these failures");
});

test("a draft that fails entry validation is skipped and reported, valid siblings still get filed", () => {
  const root = makeWorkspace();
  const binDir = mkdtempSync(path.join(tmpdir(), "nemeda-harvest-bin-"));
  const claude = stubHostBinary(
    binDir,
    "fake-claude",
    claudeEnvelope(JSON.stringify([{ type: "not-a-real-type", title: "bad", summary: "x" }, { type: "finding", title: "good", summary: "y" }]))
  );
  recordSessionActivity(root, { sessionId: "mixed", cwd: root, environment: {} });
  const config = JSON.parse(readFileSync(path.join(root, ".nemeda", "agent-kit.json"), "utf8"));
  const result = harvestSessionById(root, config, "mixed", { environment: { NEMEDA_CLAUDE_BIN: claude } });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].title, "good");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /draft rejected/);
});

test("harvestClosedSessions bounds itself to maxSessionsPerRun and skips fresh sessions", () => {
  const root = makeWorkspace();
  const binDir = mkdtempSync(path.join(tmpdir(), "nemeda-harvest-bin-"));
  const claude = stubHostBinary(binDir, "fake-claude", claudeEnvelope(JSON.stringify([{ type: "finding", title: "x", summary: "y" }])));
  for (const id of ["old-1", "old-2", "old-3", "old-4"]) {
    recordSessionActivity(root, { sessionId: id, cwd: root, environment: {} });
  }
  recordSessionActivity(root, { sessionId: "fresh", cwd: root, environment: {} });
  const ledger = readLedger(root);
  for (const id of ["old-1", "old-2", "old-3", "old-4"]) ledger[id].lastActivity = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeFileSync(ledgerPath(root), JSON.stringify(ledger));

  const config = JSON.parse(readFileSync(path.join(root, ".nemeda", "agent-kit.json"), "utf8"));
  const results = harvestClosedSessions(root, config, { environment: { NEMEDA_CLAUDE_BIN: claude }, maxSessionsPerRun: 2, idleMinutes: 30 });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.sessionId.startsWith("old-")));
  assert.equal(readLedger(root).fresh.harvestedAt, null, "the fresh session was never touched");
});

test("harvestHostNames lists exactly the supported hosts", () => {
  assert.deepEqual(harvestHostNames().sort(), ["claude", "codex"]);
});
