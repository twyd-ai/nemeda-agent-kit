// The memory identity (scripts/lib/memory-author.mjs): NEMEDA_MEMORY_AUTHOR,
// from the environment or ~/.nemeda/.env.local, wins over git config
// user.email for every memory path, and doctor flags a GitHub noreply
// address.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { memoryAuthor, memoryAuthorCheck } from "../scripts/lib/memory-author.mjs";
import { resolveAuthorEmail } from "../scripts/lib/memory.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "cli.mjs");

function repository(email) {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-author-"));
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
  if (email) execFileSync("git", ["config", "user.email", email], { cwd: root });
  return root;
}

function home(contents) {
  const directory = mkdtempSync(path.join(tmpdir(), "nemeda-home-"));
  if (contents) writeFileSync(path.join(directory, ".env.local"), contents);
  return directory;
}

test("git config user.email is the identity when no override is set", () => {
  const root = repository("ana@example.com");
  assert.deepEqual(memoryAuthor(root, { NEMEDA_HOME: home() }), { email: "ana@example.com", source: "git", from: "git config user.email", invalid: false });
});

test("NEMEDA_MEMORY_AUTHOR wins, from the environment first, then ~/.nemeda/.env.local", () => {
  const root = repository("12345+ana@users.noreply.github.com");
  const personal = home("NEMEDA_MEMORY_AUTHOR=ana@acme.io\n");
  assert.equal(memoryAuthor(root, { NEMEDA_HOME: personal }).email, "ana@acme.io");
  assert.equal(memoryAuthor(root, { NEMEDA_HOME: personal, NEMEDA_MEMORY_AUTHOR: "ana@other.io" }).email, "ana@other.io");
  const broken = memoryAuthor(root, { NEMEDA_HOME: home("NEMEDA_MEMORY_AUTHOR=not an email\n") });
  assert.equal(broken.email, "");
  assert.equal(broken.invalid, true, "a typo never falls back to git silently");
});

test("doctor warns about a GitHub noreply identity and passes once the override is set", () => {
  const root = repository("12345+ana@users.noreply.github.com");
  const noreply = memoryAuthorCheck(root, { NEMEDA_HOME: home() });
  assert.equal(noreply.status, "warn");
  assert.match(noreply.message, /GitHub noreply address/);
  assert.equal(memoryAuthorCheck(root, { NEMEDA_HOME: home("NEMEDA_MEMORY_AUTHOR=ana@acme.io\n") }).status, "pass");
  assert.equal(memoryAuthorCheck(root, { NEMEDA_HOME: home("NEMEDA_MEMORY_AUTHOR=nope\n") }).status, "fail");
  assert.equal(memoryAuthorCheck(repository(null), { NEMEDA_HOME: home() }).status, "warn");
});

test("every memory path follows the override: resolveAuthorEmail and the CLI's journal", () => {
  const root = repository("12345+ana@users.noreply.github.com");
  const personal = home("NEMEDA_MEMORY_AUTHOR=ana@acme.io\n");
  const previous = process.env.NEMEDA_HOME;
  process.env.NEMEDA_HOME = personal;
  try {
    assert.equal(resolveAuthorEmail(root), "ana@acme.io");
  } finally {
    process.env.NEMEDA_HOME = previous;
  }
  const written = JSON.parse(execFileSync(process.execPath, [cliPath, "memory", "add", "--json", "--cwd", root], {
    input: JSON.stringify({ type: "decision", title: "Identity", summary: "Filed under the override." }),
    encoding: "utf8",
    env: { ...process.env, NEMEDA_HOME: personal }
  }));
  assert.equal(written.author, "ana@acme.io");
  assert.ok(existsSync(path.join(root, "memory", "journal", "ana@acme.io.jsonl")));
  assert.equal(existsSync(path.join(root, "memory", "journal", "12345+ana@users.noreply.github.com.jsonl")), false);
});
