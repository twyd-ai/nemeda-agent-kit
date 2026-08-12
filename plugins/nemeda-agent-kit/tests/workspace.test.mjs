import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
