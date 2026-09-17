// Drive-config plan phase 2a (docs/drive-config-plan.md, guards 1, 2, and 4):
// the NEMEDA_MEMORY_ prefix for token and connection-string variables, the
// per-person origin pin and per-workspace project pin checked in
// resolveCentralToken, silent first use for repository-hosted configurations,
// and `memory trust` refusing without a person at a terminal.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CentralError, centralOfflineChecks, centralSettings, requireCentralToken, resolveCentralToken } from "../scripts/lib/memory-central.mjs";
import { evaluateCentralPins, personalOriginsPath, trustCentralPins, workspacePinsPath } from "../scripts/lib/memory-pins.mjs";
import { psqlConnection } from "../scripts/lib/memory-psql.mjs";
import { syncToCentral } from "../scripts/lib/memory-sync.mjs";
import { validateConfig } from "../scripts/lib/workspace.mjs";
import { STUB_TOKEN, startStub } from "./central-stub.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "cli.mjs");
const execFileAsync = promisify(execFile);

function baseConfig(central, projectId = "acme") {
  return {
    schemaVersion: 1,
    project: { id: projectId, name: "Acme" },
    repository: { id: "acme", role: "backend", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    memory: { project: { path: "memory" }, central }
  };
}

function workspace(config) {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-pins-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  return root;
}

function personalEnvironment(extra = {}) {
  return { NEMEDA_HOME: mkdtempSync(path.join(tmpdir(), "nemeda-home-")), NEMEDA_MEMORY_TOKEN: STUB_TOKEN, ...extra };
}

test("token and connection-string variables must start with NEMEDA_MEMORY_", () => {
  const errors = (central) =>
    validateConfig(baseConfig(central))
      .filter((issue) => issue.code === "invalid-memory" && issue.level === "error")
      .map((issue) => issue.message)
      .join(" | ");
  assert.equal(errors({ mcpUrl: "https://memory.example.ts.net/mcp", tokenVariable: "NEMEDA_MEMORY_TOKEN" }), "");
  assert.match(errors({ mcpUrl: "https://memory.example.ts.net/mcp", tokenVariable: "AIRTABLE_API_KEY" }), /tokenVariable must be an environment variable name starting with NEMEDA_MEMORY_/);
  assert.match(errors({ urlVariable: "DATABASE_URL" }), /urlVariable must be an environment variable name starting with NEMEDA_MEMORY_/);
});

test("a token variable without the prefix is never read, even when the configuration was loaded anyway", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-pins-root-"));
  const settings = centralSettings(baseConfig({ mcpUrl: "https://memory.example.ts.net/mcp", tokenVariable: "AIRTABLE_API_KEY" }));
  const resolved = resolveCentralToken(root, settings, { NEMEDA_HOME: mkdtempSync(path.join(tmpdir(), "nemeda-home-")), AIRTABLE_API_KEY: "airtable-secret" });
  assert.equal(resolved.token, null);
  assert.equal(resolved.reason, "invalid-token-variable");
  assert.throws(() => requireCentralToken(root, settings, { AIRTABLE_API_KEY: "airtable-secret" }), (error) => error instanceof CentralError && !error.message.includes("airtable-secret"));
  assert.throws(
    () => psqlConnection(root, centralSettings(baseConfig({ urlVariable: "DATABASE_URL" })), { DATABASE_URL: "postgresql://x:y@h/db" }),
    /must start with NEMEDA_MEMORY_/
  );
});

test("a repository-hosted workspace pins its origin and project silently on first use, then refuses a change", () => {
  const environment = personalEnvironment();
  const config = baseConfig({ mcpUrl: "https://memory.example.ts.net/mcp" });
  const root = workspace(config);

  const first = resolveCentralToken(root, centralSettings(config), environment);
  assert.equal(first.token, STUB_TOKEN);
  const origins = JSON.parse(readFileSync(personalOriginsPath(environment), "utf8")).origins;
  assert.ok(origins["https://memory.example.ts.net"]);
  assert.deepEqual(
    (({ origin, projectId, via }) => ({ origin, projectId, via }))(JSON.parse(readFileSync(workspacePinsPath(root), "utf8")).central),
    { origin: "https://memory.example.ts.net", projectId: "acme", via: "repository-first-use" }
  );

  const moved = centralSettings(baseConfig({ mcpUrl: "https://collector.example.com/mcp" }));
  const refused = resolveCentralToken(root, moved, environment);
  assert.equal(refused.token, null);
  assert.equal(refused.reason, "untrusted-origin");
  assert.match(refused.message, /collector\.example\.com.*memory\.example\.ts\.net/);
  assert.throws(() => requireCentralToken(root, moved, environment), (error) => error.code === "untrusted-origin");

  const renamed = centralSettings(baseConfig({ mcpUrl: "https://memory.example.ts.net/mcp" }, "other-client"));
  assert.equal(resolveCentralToken(root, renamed, environment).reason, "untrusted-project");

  trustCentralPins(root, { mcpUrl: "https://memory.example.ts.net/mcp", projectId: "other-client" }, environment);
  assert.equal(resolveCentralToken(root, renamed, environment).token, STUB_TOKEN, "memory trust accepts the change");
});

test("a drive-hosted workspace sends nothing until a person trusts it, and doctor never records a pin", () => {
  const environment = personalEnvironment();
  const config = baseConfig({ mcpUrl: "https://memory.example.ts.net/mcp" });
  const root = workspace(config);
  const settings = centralSettings(config, { configSource: "drive" });

  const offline = centralOfflineChecks(root, config, environment, { configSource: "drive" });
  assert.deepEqual(offline.map((check) => [check.code, check.status]), [["central-origin", "fail"]]);
  assert.equal(existsSync(workspacePinsPath(root)), false, "doctor records nothing");

  assert.equal(resolveCentralToken(root, settings, environment).reason, "untrusted-origin");
  assert.equal(existsSync(workspacePinsPath(root)), false, "a drive configuration never pins itself");

  // The person already trusts the origin elsewhere: the project still needs confirming.
  trustCentralPins(mkdtempSync(path.join(tmpdir(), "nemeda-other-")), { mcpUrl: "https://memory.example.ts.net/mcp", projectId: "elsewhere" }, environment);
  assert.equal(evaluateCentralPins(root, { mcpUrl: "https://memory.example.ts.net/mcp", projectId: "acme", configSource: "drive" }, environment).reason, "untrusted-project");

  trustCentralPins(root, { mcpUrl: "https://memory.example.ts.net/mcp", projectId: "acme" }, environment);
  assert.equal(resolveCentralToken(root, settings, environment).token, STUB_TOKEN);
});

test("sync refuses an untrusted origin before any request leaves the machine", async () => {
  const stub = await startStub();
  try {
    const environment = personalEnvironment();
    const root = workspace(baseConfig({ mcpUrl: "https://memory.example.ts.net/mcp" }));
    trustCentralPins(root, { mcpUrl: "https://memory.example.ts.net/mcp", projectId: "acme" }, environment);
    const redirected = baseConfig({ mcpUrl: stub.url });
    writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(redirected));
    const memoryRoot = path.join(root, "memory", "journal");
    mkdirSync(memoryRoot, { recursive: true });
    writeFileSync(path.join(memoryRoot, "ana@example.com.jsonl"), `${JSON.stringify({ id: "01TESTPINSENTRY00000000001", revision: 1, project: "acme", type: "decision", title: "Pinned", date: "2026-09-17", author: "ana@example.com", tags: [], summary: "Must not leave.", clientSummary: null, status: "reviewed", source: { kind: "manual" }, createdAt: "2026-09-17T10:00:00.000Z" })}\n`);
    await assert.rejects(syncToCentral(root, redirected, { environment }), (error) => error.code === "untrusted-origin");
    assert.equal(stub.state.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("memory trust refuses without a person at an interactive terminal", async () => {
  const environment = personalEnvironment();
  const config = baseConfig({ mcpUrl: "https://memory.example.ts.net/mcp" });
  const root = workspace(config);
  trustCentralPins(root, { mcpUrl: "https://memory.example.ts.net/mcp", projectId: "acme" }, environment);
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(baseConfig({ mcpUrl: "https://collector.example.com/mcp" })));
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "memory", "trust", "--cwd", root], { env: { ...process.env, ...environment }, encoding: "utf8" }),
    (error) => /interactive terminal/.test(error.stderr) && /collector\.example\.com/.test(error.stdout)
  );
  assert.equal(JSON.parse(readFileSync(workspacePinsPath(root), "utf8")).central.origin, "https://memory.example.ts.net", "nothing changed");
});
