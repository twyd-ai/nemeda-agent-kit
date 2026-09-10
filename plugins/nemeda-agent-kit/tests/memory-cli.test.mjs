// End-to-end tests for `nemeda-agent memory`, spawned as a real process —
// unlike scripts/lib/memory.mjs and mcp-server.mjs, cli.mjs itself has no
// other unit tests (it is a thin dispatcher elsewhere in the kit too), but
// `review`'s single-writer-per-journal safety check is exactly the kind of
// behavior worth locking in with a real invocation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "cli.mjs");

function configuredWorkspace(email = "test@example.com") {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-memory-cli-"));
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
      memory: { project: { path: "memory" } }
    })
  );
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", email], { cwd: root });
  return root;
}

function cli(args, { input, expectFailure = false, env } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      input: input || "",
      encoding: "utf8",
      env: env ? { ...process.env, ...env } : process.env
    });
    if (expectFailure) throw new Error(`Expected failure but got: ${stdout}`);
    return { stdout, code: 0 };
  } catch (error) {
    if (!expectFailure) throw error;
    return { stdout: error.stdout || "", stderr: error.stderr || "", code: error.status };
  }
}

test("memory add, list --json, and review round-trip through the real CLI", () => {
  const root = configuredWorkspace();
  cli(["memory", "add", "--type", "decision", "--title", "Ship it", "--cwd", root], { input: "We shipped it." });

  const listed = JSON.parse(cli(["memory", "list", "--json", "--cwd", root]).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "pending");
  const id = listed[0].id;

  const reviewed = JSON.parse(
    cli(["memory", "review", id, "--json", "--cwd", root], { input: JSON.stringify({ tags: ["shipped"] }) }).stdout
  );
  assert.equal(reviewed.status, "reviewed");
  assert.deepEqual(reviewed.tags, ["shipped"]);
  assert.equal(reviewed.revision, 2);

  const secondAttempt = cli(["memory", "review", id, "--cwd", root], { expectFailure: true });
  assert.match(secondAttempt.stderr, /already "reviewed"/);
});

test("memory review refuses to touch another author's entry", () => {
  const root = configuredWorkspace("me@example.com");
  mkdirSync(path.join(root, "memory", "journal"), { recursive: true });
  const foreignEntry = {
    id: "01FOREIGNENTRY0000000000",
    revision: 1,
    project: "acme",
    type: "finding",
    title: "Someone else's finding",
    date: "2026-09-10",
    author: "someone-else@example.com",
    tags: [],
    summary: "Not mine to review.",
    clientSummary: null,
    status: "pending",
    source: { kind: "manual" },
    createdAt: "2026-09-10T00:00:00.000Z"
  };
  appendFileSync(path.join(root, "memory", "journal", "someone-else@example.com.jsonl"), `${JSON.stringify(foreignEntry)}\n`);

  const result = cli(["memory", "review", foreignEntry.id, "--cwd", root], { expectFailure: true });
  assert.match(result.stderr, /belongs to someone-else@example\.com/);

  // --all lists it (visibility), but never lets it through for review.
  const inbox = cli(["memory", "review", "--all", "--cwd", root]).stdout;
  assert.match(inbox, /Someone else's finding/);
});

test("memory review with no pending entries reports an empty inbox instead of erroring", () => {
  const root = configuredWorkspace();
  const inbox = cli(["memory", "review", "--json", "--cwd", root]).stdout;
  assert.deepEqual(JSON.parse(inbox), []);
});

function stubClaude(dir, resultText) {
  const file = path.join(dir, "fake-claude");
  writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ type: "result", subtype: "success", result: resultText })}\nEOF\n`);
  chmodSync(file, 0o755);
  return file;
}

test("memory harvest refuses without MEMORY_HARVEST=true, and never spawns the stub", () => {
  const root = configuredWorkspace();
  const claude = stubClaude(mkdtempSync(path.join(tmpdir(), "nemeda-harvest-bin-")), JSON.stringify([{ type: "finding", title: "x", summary: "y" }]));
  const result = cli(["memory", "harvest", "--cwd", root], { expectFailure: true, env: { NEMEDA_CLAUDE_BIN: claude } });
  assert.match(result.stderr, /MEMORY_HARVEST is not enabled/);
});

test("memory harvest --session ID resumes a stubbed CLI and files the entry, through the real CLI end to end", () => {
  const root = configuredWorkspace();
  const claude = stubClaude(
    mkdtempSync(path.join(tmpdir(), "nemeda-harvest-bin-")),
    JSON.stringify([{ type: "finding", title: "Harvested via CLI", summary: "End to end through the real CLI." }])
  );
  const env = { MEMORY_HARVEST: "true", NEMEDA_CLAUDE_BIN: claude };

  const dryRun = cli(["memory", "harvest", "--session", "cli-session", "--dry-run", "--json", "--cwd", root], { env }).stdout;
  const dryRunResult = JSON.parse(dryRun)[0];
  assert.equal(dryRunResult.ok, true);
  assert.equal(JSON.parse(cli(["memory", "list", "--json", "--cwd", root]).stdout).length, 0, "dry run wrote nothing");

  const real = JSON.parse(cli(["memory", "harvest", "--session", "cli-session", "--json", "--cwd", root], { env }).stdout)[0];
  assert.equal(real.ok, true);
  assert.equal(real.created[0].title, "Harvested via CLI");
  const listed = JSON.parse(cli(["memory", "list", "--json", "--cwd", root]).stdout);
  assert.equal(listed.length, 1);
});
