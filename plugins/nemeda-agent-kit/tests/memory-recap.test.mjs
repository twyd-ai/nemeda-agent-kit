// Phase 3b (docs/memory-plan.md): digests on the drive, `memory recap`
// written by a stubbed host CLI or taken from stdin, promotion of digests,
// `memory close` / `memory reopen`, and the 12 h automatic sync.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appendEntry, createEntry, reviseEntry } from "../scripts/lib/memory.mjs";
import { createDigest, parseDigest, formatDigest, readDigests, writeDigest } from "../scripts/lib/memory-digest.mjs";
import { closeProject, periodRange, recapProject, reopenProject } from "../scripts/lib/memory-recap.mjs";
import { AUTO_SYNC_INTERVAL_MS, readSyncState, shouldTriggerSync, spawnDetachedSync, syncToCentral, writeSyncState } from "../scripts/lib/memory-sync.mjs";
import { STUB_TOKEN, startStub } from "./central-stub.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "cli.mjs");
const THIS_MONTH = new Date().toISOString().slice(0, 7);

function workspace(central, email = "ana@example.com") {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-recap-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  const config = {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "backend", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    memory: { project: { path: "memory" }, ...(central ? { central } : {}) }
  };
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", email], { cwd: root });
  return { root, config };
}

function seed(root) {
  const memoryRoot = path.join(root, "memory");
  appendEntry(memoryRoot, createEntry({ project: "acme", type: "decision", title: "Pending idea", author: "ana@example.com", summary: "Not reviewed yet." }));
  const ana = appendEntry(memoryRoot, reviseEntry(appendEntry(memoryRoot, createEntry({ project: "acme", type: "decision", title: "Use bge-m3", author: "ana@example.com", summary: "We chose bge-m3." })), { status: "reviewed" }));
  const bob = appendEntry(memoryRoot, reviseEntry(appendEntry(memoryRoot, createEntry({ project: "acme", type: "finding", title: "Bob's finding", author: "bob@example.com", summary: "Found it." })), { status: "reviewed" }));
  return { ana, bob };
}

// A stub `claude` that saves its stdin (the prompt) and its recursion guard
// next to itself, then answers in Claude Code's JSON envelope.
function stubClaude(markdown) {
  const dir = mkdtempSync(path.join(tmpdir(), "nemeda-stub-claude-"));
  const file = path.join(dir, "claude");
  const envelope = JSON.stringify({ type: "result", subtype: "success", result: markdown });
  writeFileSync(file, `#!/bin/sh\ncat > "${dir}/prompt.txt"\necho "$NEMEDA_MEMORY_HARVESTER" > "${dir}/guard.txt"\ncat <<'EOF'\n${envelope}\nEOF\n`);
  chmodSync(file, 0o755);
  return { file, prompt: () => readFileSync(path.join(dir, "prompt.txt"), "utf8"), guard: () => readFileSync(path.join(dir, "guard.txt"), "utf8").trim() };
}

function tokenEnvironment(extra = {}) {
  return { ...process.env, NEMEDA_HOME: mkdtempSync(path.join(tmpdir(), "nemeda-home-")), NEMEDA_MEMORY_TOKEN: STUB_TOKEN, ...extra };
}

test("periods are years, quarters, or months", () => {
  assert.deepEqual(periodRange("2026"), { since: "2026-01-01", until: "2026-12-31" });
  assert.deepEqual(periodRange("2026-Q3"), { since: "2026-07-01", until: "2026-09-30" });
  assert.deepEqual(periodRange("2024-02"), { since: "2024-02-01", until: "2024-02-29" });
  assert.equal(periodRange("2026-13"), null);
  assert.equal(periodRange("last week"), null);
});

test("digests round-trip through Markdown files that are never overwritten", () => {
  const memoryRoot = path.join(mkdtempSync(path.join(tmpdir(), "nemeda-digests-")), "memory");
  const digest = createDigest({ project: "acme", period: "2026-Q3", body: "## Decided\nThings.", generatedBy: "ana@example.com" });
  assert.deepEqual(parseDigest(formatDigest(digest)).digest, digest);
  const file = writeDigest(memoryRoot, digest);
  assert.match(path.basename(file), /^2026-Q3-recap-.+\.md$/);
  assert.throws(() => writeDigest(memoryRoot, digest), /EEXIST/);
  writeFileSync(path.join(path.dirname(file), "broken.md"), "no front matter");
  writeFileSync(path.join(path.dirname(file), "README.md"), "# digests");
  const { digests, malformed } = readDigests(memoryRoot);
  assert.equal(digests.length, 1);
  assert.equal(digests[0].id, digest.id);
  assert.deepEqual(malformed.map((item) => item.file), ["broken.md"]);
  assert.throws(() => writeDigest(memoryRoot, { ...digest, id: "x", kind: "weekly" }), /kind must be one of/);
});

test("memory recap has the host CLI write the digest from reviewed entries only, on stdin, with the recursion guard", () => {
  const { root, config } = workspace();
  seed(root);
  const claude = stubClaude("## Decided\nUse bge-m3.\n\n## Learned\nNothing.\n\n## Still open\nNothing.");
  const result = recapProject(root, config, { period: THIS_MONTH, host: "claude", environment: { ...process.env, NEMEDA_CLAUDE_BIN: claude.file } });
  assert.equal(result.entries, 2);
  assert.equal(result.generatedWith, "claude");
  const prompt = claude.prompt();
  assert.match(prompt, /Use bge-m3/);
  assert.match(prompt, /Bob's finding/);
  assert.doesNotMatch(prompt, /Pending idea/);
  assert.equal(claude.guard(), "1");
  const [digest] = readDigests(path.join(root, "memory")).digests;
  assert.equal(digest.kind, "recap");
  assert.equal(digest.period, THIS_MONTH);
  assert.equal(digest.generatedBy, "ana@example.com");
  assert.match(digest.body, /^## Decided/);
});

test("memory recap takes the digest from stdin through the CLI, and refuses an empty period", () => {
  const { root } = workspace();
  seed(root);
  const output = JSON.parse(execFileSync(process.execPath, [cliPath, "memory", "recap", "--period", THIS_MONTH, "--json", "--cwd", root], { input: "## Decided\nWritten in session.", encoding: "utf8" }));
  assert.equal(output.generatedWith, null);
  assert.ok(existsSync(output.file));
  assert.throws(
    () => execFileSync(process.execPath, [cliPath, "memory", "recap", "--period", "1999", "--cwd", root], { input: "", encoding: "utf8", stdio: "pipe" }),
    (error) => /No reviewed entries in 1999/.test(error.stderr)
  );
});

test("memory sync promotes digests once, after the entries", async () => {
  const stub = await startStub();
  try {
    const { root, config } = workspace({ mcpUrl: stub.url });
    seed(root);
    const { digest } = recapProject(root, config, { period: THIS_MONTH, body: "## Decided\nUse bge-m3." });
    const environment = tokenEnvironment();
    const report = await syncToCentral(root, config, { environment });
    assert.deepEqual(report.digests.inserted, [digest.id]);
    const row = stub.state.digests.get(digest.id);
    assert.equal(row.kind, "recap");
    assert.equal(row.project_id, "acme");
    assert.equal(row.generated_by, "ana@example.com");
    assert.equal(row.scope, "project");
    const promotes = stub.state.requests.filter((request) => request.url === "/promote");
    assert.deepEqual(promotes.at(-1).body.entries, []);
    assert.equal(promotes.at(-1).body.digests.length, 1);
    assert.equal(readSyncState(root).digests[digest.id], true);
    const again = await syncToCentral(root, config, { environment });
    assert.equal(again.digests.candidates.length, 0);
  } finally {
    await stub.close();
  }
});

test("memory close needs --yes, then promotes everyone's entries and a closure digest; reopen adds a reopen digest", async () => {
  const stub = await startStub();
  try {
    const { root, config } = workspace({ mcpUrl: stub.url });
    const { ana, bob } = seed(root);
    assert.throws(
      () => execFileSync(process.execPath, [cliPath, "memory", "close", "--cwd", root], { input: "", encoding: "utf8", stdio: "pipe" }),
      (error) => /--yes/.test(error.stderr)
    );
    const environment = tokenEnvironment();
    const preview = await closeProject(root, config, { body: "## Decided\nAll of it.", dryRun: true, environment });
    assert.equal(preview.file, null);
    assert.equal(stub.state.requests.length, 0);

    const closed = await closeProject(root, config, { body: "## Decided\nAll of it.", environment });
    assert.equal(closed.digest.kind, "closure");
    assert.deepEqual(closed.sync.inserted.map((item) => item.id).sort(), [ana.id, bob.id].sort());
    assert.deepEqual(closed.sync.digests.inserted, [closed.digest.id]);
    assert.equal(stub.state.digests.get(closed.digest.id).kind, "closure");

    const reopened = await reopenProject(root, config, { environment });
    assert.equal(reopened.digest.kind, "reopen");
    assert.match(reopened.digest.body, /Reopened by ana@example\.com/);
    assert.deepEqual(reopened.sync.digests.inserted, [reopened.digest.id]);
  } finally {
    await stub.close();
  }
});

test("the automatic sync needs the service and a token, respects MEMORY_SYNC_AUTO, and runs at most every 12 h", () => {
  const { root: bare, config: bareConfig } = workspace();
  assert.equal(shouldTriggerSync(bare, bareConfig, tokenEnvironment()).trigger, false);

  const { root, config } = workspace({ mcpUrl: "https://memory.example.ts.net/mcp" });
  const home = mkdtempSync(path.join(tmpdir(), "nemeda-home-"));
  assert.equal(shouldTriggerSync(root, config, { NEMEDA_HOME: home }).reason, "no token for the memory service");
  const environment = { NEMEDA_HOME: home, NEMEDA_MEMORY_TOKEN: STUB_TOKEN };
  assert.equal(shouldTriggerSync(root, config, environment).trigger, true);
  assert.equal(shouldTriggerSync(root, config, { ...environment, MEMORY_SYNC_AUTO: "false" }).trigger, false);

  const now = Date.now();
  writeSyncState(root, { ...readSyncState(root), lastAttemptAt: new Date(now).toISOString() });
  assert.equal(shouldTriggerSync(root, config, environment, { now: now + 60_000 }).trigger, false);
  assert.equal(shouldTriggerSync(root, config, environment, { now: now + AUTO_SYNC_INTERVAL_MS + 1 }).trigger, true);
});

test("spawnDetachedSync records the attempt and starts `memory sync` in the background", async () => {
  const { root } = workspace({ mcpUrl: "https://memory.example.ts.net/mcp" });
  const dir = mkdtempSync(path.join(tmpdir(), "nemeda-fake-cli-"));
  const marker = path.join(dir, "argv.json");
  const fakeCli = path.join(dir, "cli.mjs");
  writeFileSync(fakeCli, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`);
  const pid = spawnDetachedSync(root, { environment: process.env, cliPath: fakeCli });
  assert.ok(Number.isInteger(pid));
  assert.ok(readSyncState(root).lastAttemptAt);
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), ["memory", "sync", "--cwd", root]);
  assert.match(readFileSync(path.join(root, ".nemeda", "state", "memory-sync.log"), "utf8"), /background sync started/);
});
