// The opportunistic harvest trigger: the per-machine lock, the decision the
// SessionStart hook makes, the detached run it spawns, and the pending-review
// line it adds. Host CLIs are stubbed (NEMEDA_CLAUDE_BIN), as in
// harvest.test.mjs, so nothing here calls a real model.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appendEntry, createEntry, readAllJournals } from "../scripts/lib/memory.mjs";
import {
  acquireHarvestLock,
  harvestLockHeld,
  harvestLockPath,
  harvestLogPath,
  ledgerPath,
  pendingReviewCount,
  readLedger,
  recordSessionActivity,
  shouldTriggerHarvest
} from "../scripts/lib/harvest.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = path.join(pluginRoot, "scripts", "hooks", "memory-ledger.mjs");
const cliPath = path.join(pluginRoot, "scripts", "cli.mjs");
const config = { project: { id: "acme", name: "Acme" }, repository: { id: "acme", role: "backend", profiles: [] }, memory: { project: { path: "memory" } } };

function makeWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-harvest-trigger-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(
    path.join(root, ".nemeda", "agent-kit.json"),
    JSON.stringify({ schemaVersion: 1, ...config, context: { instructions: ["AGENTS.md"] }, tools: { required: [], optional: [] }, policies: { protectSecrets: true } })
  );
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  return root;
}

function stubClaude() {
  const dir = mkdtempSync(path.join(tmpdir(), "nemeda-harvest-trigger-bin-"));
  const file = path.join(dir, "fake-claude");
  const result = JSON.stringify([{ type: "finding", title: "Harvested in the background", summary: "Written by the detached run." }]);
  writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ type: "result", subtype: "success", result })}\nEOF\n`);
  chmodSync(file, 0o755);
  return file;
}

function seedClosedSession(root, sessionId, minutesAgo = 60) {
  recordSessionActivity(root, { sessionId, cwd: root, environment: {} });
  const ledger = readLedger(root);
  ledger[sessionId].lastActivity = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  writeFileSync(ledgerPath(root), JSON.stringify(ledger));
}

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

// Runs the hook the way a host does: event JSON on stdin, output on stdout.
function runHook(root, { args = [], env = {} } = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [hookPath, ...args], {
    input: JSON.stringify({ session_id: `hook-${Date.now()}`, cwd: root }),
    encoding: "utf8",
    env: { ...process.env, NEMEDA_MEMORY_INDEX_ENGINE: "memory", ...env }
  });
  return { ...result, durationMs: Date.now() - started };
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

test("the harvest lock admits one holder, and release frees it", () => {
  const root = makeWorkspace();
  const release = acquireHarvestLock(root);
  assert.equal(typeof release, "function");
  assert.equal(harvestLockHeld(root), true);
  assert.equal(acquireHarvestLock(root), null, "a second run is refused while the first is alive");
  release();
  assert.equal(existsSync(harvestLockPath(root)), false);
  const again = acquireHarvestLock(root);
  assert.equal(typeof again, "function");
  again();
});

test("a lock left by a dead process, or older than an hour, is taken over", () => {
  const root = makeWorkspace();
  mkdirSync(path.dirname(harvestLockPath(root)), { recursive: true });

  writeFileSync(harvestLockPath(root), JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));
  assert.equal(harvestLockHeld(root), false);
  const takenFromDead = acquireHarvestLock(root);
  assert.equal(typeof takenFromDead, "function");
  takenFromDead();

  writeFileSync(harvestLockPath(root), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }));
  assert.equal(harvestLockHeld(root), false, "alive but two hours old counts as abandoned");
  const takenFromOld = acquireHarvestLock(root);
  assert.equal(typeof takenFromOld, "function");
  takenFromOld();
});

test("release never deletes a lock that another process now holds", () => {
  const root = makeWorkspace();
  const release = acquireHarvestLock(root);
  writeFileSync(harvestLockPath(root), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
  release();
  assert.equal(existsSync(harvestLockPath(root)), true);
});

test("shouldTriggerHarvest needs the opt-in, a closed session, and a free lock", () => {
  const root = makeWorkspace();
  assert.equal(shouldTriggerHarvest(root, config, {}).trigger, false);
  assert.match(shouldTriggerHarvest(root, config, {}).reason, /MEMORY_HARVEST/);

  const optedIn = { MEMORY_HARVEST: "true" };
  assert.equal(shouldTriggerHarvest(root, config, optedIn).trigger, false, "nothing closed yet");
  recordSessionActivity(root, { sessionId: "fresh", cwd: root, environment: {} });
  assert.equal(shouldTriggerHarvest(root, config, optedIn).trigger, false, "a fresh session is not closed");

  seedClosedSession(root, "old-1");
  seedClosedSession(root, "old-2");
  assert.deepEqual(shouldTriggerHarvest(root, config, optedIn), { trigger: true, closed: 2 });

  const release = acquireHarvestLock(root);
  const blocked = shouldTriggerHarvest(root, config, optedIn);
  assert.equal(blocked.trigger, false);
  assert.match(blocked.reason, /already running/);
  release();
});

test("pendingReviewCount counts only this author's pending entries", () => {
  const root = makeWorkspace();
  const memoryRoot = path.join(root, "memory");
  const base = { project: "acme", type: "finding", title: "t", summary: "s" };
  appendEntry(memoryRoot, createEntry({ ...base, author: "test@example.com" }));
  appendEntry(memoryRoot, createEntry({ ...base, author: "test@example.com" }));
  appendEntry(memoryRoot, createEntry({ ...base, author: "test@example.com", status: "reviewed" }));
  appendEntry(memoryRoot, createEntry({ ...base, author: "someone-else@example.com" }));
  assert.equal(pendingReviewCount(root, config, { NEMEDA_MEMORY_INDEX_ENGINE: "memory" }), 2);
});

test("SessionStart returns at once, harvests closed sessions in the background, and reports pending entries", async () => {
  const root = makeWorkspace();
  seedClosedSession(root, "old-1");
  const env = { MEMORY_HARVEST: "true", NEMEDA_CLAUDE_BIN: stubClaude() };

  const hook = runHook(root, { args: ["--session-start"], env });
  assert.equal(hook.status, 0);
  assert.ok(hook.durationMs < 5000, `the hook must not wait for the harvest (took ${hook.durationMs}ms)`);
  const context = JSON.parse(hook.stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, "SessionStart");
  assert.match(context.additionalContext, /summarising 1 earlier session in the background/);

  const finished = await waitFor(() => Boolean(readLedger(root)["old-1"]?.harvestedAt) && !existsSync(harvestLockPath(root)));
  assert.ok(finished, "the detached harvest completed and released its lock");
  const { entries } = readAllJournals(path.join(root, "memory"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source.sessionId, "old-1");
  assert.equal(entries[0].status, "pending");
  assert.match(readFileSync(harvestLogPath(root), "utf8"), /background harvest started from SessionStart/);

  // The next session start has nothing left to harvest, but reports the
  // entry that the harvest produced as waiting for review.
  const next = runHook(root, { args: ["--session-start"], env });
  const nextContext = JSON.parse(next.stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(nextContext, /summarising/);
  assert.match(nextContext, /1 entry by the user is pending review/);
});

test("Stop never triggers a harvest, and the harvester's own sessions record nothing", async () => {
  const root = makeWorkspace();
  seedClosedSession(root, "old-1");
  const env = { MEMORY_HARVEST: "true", NEMEDA_CLAUDE_BIN: stubClaude() };

  const stop = runHook(root, { env });
  assert.equal(stop.status, 0);
  assert.equal(stop.stdout, "");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(readLedger(root)["old-1"].harvestedAt, null, "Stop fires every turn and must never spawn anything");

  const before = Object.keys(readLedger(root)).length;
  const resumed = runHook(root, { args: ["--session-start"], env: { ...env, NEMEDA_MEMORY_HARVESTER: "1" } });
  assert.equal(resumed.stdout, "");
  assert.equal(Object.keys(readLedger(root)).length, before, "a resumed session never enters the ledger");
  assert.equal(readLedger(root)["old-1"].harvestedAt, null);
});

test("a manual harvest skips cleanly while another one holds the lock", () => {
  const root = makeWorkspace();
  seedClosedSession(root, "old-1");
  const release = acquireHarvestLock(root);
  try {
    const result = spawnSync(process.execPath, [cliPath, "memory", "harvest", "--cwd", root], {
      encoding: "utf8",
      env: { ...process.env, MEMORY_HARVEST: "true", NEMEDA_CLAUDE_BIN: stubClaude() }
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /another harvest is already running/);
    assert.equal(readLedger(root)["old-1"].harvestedAt, null);
  } finally {
    release();
  }
});

test("without MEMORY_HARVEST the SessionStart hook only reports, never spawns", async () => {
  const root = makeWorkspace();
  seedClosedSession(root, "old-1");
  const hook = runHook(root, { args: ["--session-start"], env: { NEMEDA_CLAUDE_BIN: stubClaude() } });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, "", "no harvest, and nothing pending yet");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(readLedger(root)["old-1"].harvestedAt, null);
  assert.equal(existsSync(harvestLogPath(root)), false);
});

// Keep the imported helper referenced for readers of the harness: spawn is
// what the trigger itself uses, exercised end to end through the hook above.
void spawn;
