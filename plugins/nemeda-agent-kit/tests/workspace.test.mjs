import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializeWorkspace,
  readWorkspaceContext,
  validateConfig,
  workspaceDoctor
} from "../scripts/lib/workspace.mjs";

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "nemeda-agent-kit-"));
}

function validConfig() {
  return {
    schemaVersion: 1,
    project: { id: "example", name: "Example" },
    repository: { id: "example", role: "backend", profiles: ["python"] },
    context: { instructions: ["AGENTS.md"], documents: [] },
    tools: { required: ["git"], optional: ["github"] },
    policies: { protectSecrets: true }
  };
}

test("loads configured context from a nested directory", () => {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(validConfig()));
  writeFileSync(path.join(root, "AGENTS.md"), "# Instructions\n\n- Keep changes scoped.\n");

  const context = readWorkspaceContext(path.join(root, "src"));
  assert.equal(context.mode, "configured");
  assert.equal(context.root, root);
  assert.equal(context.instructions[0].content.includes("Keep changes scoped"), true);
  assert.deepEqual(context.issues, []);
});

test("rejects instruction paths that escape the repository", () => {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"));
  const config = validConfig();
  config.context.instructions = ["../outside.md"];
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));

  const context = readWorkspaceContext(root);
  assert.equal(context.issues.some((issue) => issue.code === "invalid-instruction"), true);
});

test("rejects secret-bearing context paths before reading files", () => {
  const config = validConfig();
  config.context.documents = [".env.production"];
  assert.equal(validateConfig(config).some((issue) => issue.code === "invalid-context-path"), true);
});

test("validates exactly one repository scope", () => {
  const config = validConfig();
  config.workspace = { repositories: [] };
  assert.equal(validateConfig(config).some((issue) => issue.code === "ambiguous-scope"), true);
});

test("rejects empty workspaces, escaping paths, duplicate repositories, and unknown fields", () => {
  const config = validConfig();
  delete config.repository;
  config.workspace = { repositories: [] };
  assert.equal(validateConfig(config).some((issue) => issue.code === "empty-workspace"), true);

  config.workspace.repositories = [
    { id: "api", path: "../api", role: "backend", profiles: ["python"] },
    { id: "api", path: "../api", role: "worker", profiles: ["python"], extra: true }
  ];
  const issues = validateConfig(config);
  assert.equal(issues.some((issue) => issue.code === "invalid-repository-path"), true);
  assert.equal(issues.some((issue) => issue.code === "duplicate-repository"), true);
  assert.equal(issues.some((issue) => issue.code === "unknown-field"), true);
});

test("init creates missing files and never overwrites them", () => {
  const root = temporaryDirectory();
  const first = initializeWorkspace(root, { projectId: "sample", projectName: "Sample" });
  assert.equal(first.agentsCreated, true);
  assert.equal(JSON.parse(readFileSync(first.configPath, "utf8")).project.id, "sample");
  assert.throws(() => initializeWorkspace(root), /already exists/);
});

test("doctor identifies substantial parallel instruction files", () => {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"));
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(validConfig()));
  writeFileSync(path.join(root, "AGENTS.md"), "A".repeat(100));
  writeFileSync(path.join(root, "CLAUDE.md"), "B".repeat(100));

  const report = workspaceDoctor(root);
  assert.equal(report.checks.some((check) => check.code === "instruction-drift"), true);
});

function configWithMemory(memory) {
  return { ...validConfig(), memory };
}

test("validateConfig accepts a minimal memory.project and rejects unknown keys or providers", () => {
  const minimal = configWithMemory({ project: { path: "memory" } });
  assert.deepEqual(validateConfig(minimal), []);

  const withCentral = configWithMemory({
    project: { path: "memory", store: "journal", tags: ["architecture"] },
    central: { urlVariable: "NEMEDA_MEMORY_DB_URL", promote: "reviewed" }
  });
  assert.deepEqual(validateConfig(withCentral), []);

  const badStore = configWithMemory({ project: { path: "memory", store: "dropbox" } });
  assert.equal(validateConfig(badStore).some((issue) => issue.code === "invalid-memory" && /store must be one of/.test(issue.message)), true);

  const badPath = configWithMemory({ project: { path: "/etc/memory" } });
  assert.equal(validateConfig(badPath).some((issue) => issue.code === "invalid-memory" && /path must be a relative path/.test(issue.message)), true);

  const unknownKey = configWithMemory({ project: { path: "memory" }, extra: true });
  assert.equal(validateConfig(unknownKey).some((issue) => issue.code === "unknown-field" && issue.message.includes("memory.extra")), true);

  const badVariable = configWithMemory({ project: { path: "memory" }, central: { urlVariable: "not_a_var_name" } });
  assert.equal(validateConfig(badVariable).some((issue) => issue.code === "invalid-memory" && /urlVariable must be an environment variable name/.test(issue.message)), true);

  const badPromote = configWithMemory({ project: { path: "memory" }, central: { urlVariable: "NEMEDA_MEMORY_DB_URL", promote: "sometimes" } });
  assert.equal(validateConfig(badPromote).some((issue) => issue.code === "invalid-memory" && /promote must be one of/.test(issue.message)), true);
});

test("validateConfig warns (does not fail) when airtable.knowledgeLog is still present", () => {
  const config = { ...validConfig(), airtable: { baseId: "appXXXXXXXXXXXXXX", knowledgeLog: { tableId: "tblXXXXXXXXXXXXXX" } } };
  const issues = validateConfig(config);
  const deprecation = issues.find((issue) => issue.code === "deprecated-knowledge-log");
  assert.ok(deprecation, "expected a deprecated-knowledge-log issue");
  assert.equal(deprecation.level, "warn");
  assert.equal(issues.some((issue) => issue.level === "error"), false);
});

test("doctor reports the memory folder's state: missing, unshared, broken link, and healthy", () => {
  const missing = temporaryDirectory();
  mkdirSync(path.join(missing, ".nemeda"));
  writeFileSync(path.join(missing, ".nemeda", "agent-kit.json"), JSON.stringify(configWithMemory({ project: { path: "memory" } })));
  assert.equal(workspaceDoctor(missing).checks.find((check) => check.code === "memory-folder").status, "warn");

  const unshared = temporaryDirectory();
  mkdirSync(path.join(unshared, ".nemeda"));
  mkdirSync(path.join(unshared, "memory"));
  writeFileSync(path.join(unshared, ".nemeda", "agent-kit.json"), JSON.stringify(configWithMemory({ project: { path: "memory" } })));
  const unsharedCheck = workspaceDoctor(unshared).checks.find((check) => check.code === "memory-folder");
  assert.equal(unsharedCheck.status, "warn");
  assert.match(unsharedCheck.message, /stay on this machine/);

  const broken = temporaryDirectory();
  mkdirSync(path.join(broken, ".nemeda"));
  symlinkSync(path.join(broken, "does-not-exist"), path.join(broken, "memory"));
  writeFileSync(path.join(broken, ".nemeda", "agent-kit.json"), JSON.stringify(configWithMemory({ project: { path: "memory" } })));
  assert.equal(workspaceDoctor(broken).checks.find((check) => check.code === "memory-folder").status, "fail");

  const healthy = temporaryDirectory();
  const drive = temporaryDirectory();
  mkdirSync(path.join(drive, "memory"));
  mkdirSync(path.join(healthy, ".nemeda"));
  symlinkSync(path.join(drive, "memory"), path.join(healthy, "memory"));
  writeFileSync(path.join(healthy, ".nemeda", "agent-kit.json"), JSON.stringify(configWithMemory({ project: { path: "memory" } })));
  assert.equal(workspaceDoctor(healthy).checks.find((check) => check.code === "memory-folder").status, "pass");
});

test("doctor checks this author's journal is writable and flags sync-client conflict copies", () => {
  const root = temporaryDirectory();
  const drive = temporaryDirectory();
  mkdirSync(path.join(drive, "memory", "journal"), { recursive: true });
  mkdirSync(path.join(root, ".nemeda"));
  symlinkSync(path.join(drive, "memory"), path.join(root, "memory"));
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(configWithMemory({ project: { path: "memory" } })));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });

  const beforeJournal = workspaceDoctor(root).checks.find((check) => check.code === "memory-journal");
  assert.equal(beforeJournal.status, "pass");
  assert.match(beforeJournal.message, /No journal yet/);
  assert.equal(workspaceDoctor(root).checks.find((check) => check.code === "memory-conflicts").status, "pass");

  writeFileSync(path.join(drive, "memory", "journal", "test@example.com.jsonl"), "");
  const afterJournal = workspaceDoctor(root).checks.find((check) => check.code === "memory-journal");
  assert.equal(afterJournal.status, "pass");
  assert.match(afterJournal.message, /is writable/);

  writeFileSync(path.join(drive, "memory", "journal", "test@example.com (1).jsonl"), "");
  const conflicts = workspaceDoctor(root).checks.find((check) => check.code === "memory-conflicts");
  assert.equal(conflicts.status, "warn");
  assert.match(conflicts.message, /test@example.com \(1\).jsonl/);
});
