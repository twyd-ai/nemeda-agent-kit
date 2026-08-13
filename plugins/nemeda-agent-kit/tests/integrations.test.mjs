import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractPrUrl, extractRecordIds, noteWithPr } from "../scripts/lib/airtable.mjs";
import { loadEnvLocal } from "../scripts/lib/env.mjs";
import { prSyncFromEvent, reconcilePrs } from "../scripts/lib/hooks.mjs";
import { setupWorkspace } from "../scripts/lib/setup.mjs";
import { initializeWorkspace, validateConfig, workspaceDoctor } from "../scripts/lib/workspace.mjs";

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "nemeda-agent-kit-"));
}

// Installs a fake `gh` on PATH so reconcilePrs can be tested without network
// access or a real GitHub CLI. Returns an environment with PATH prepended.
function withFakeGh(environment, { open = [], merged = [] } = {}) {
  const binDir = temporaryDirectory();
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const state = args[args.indexOf("--state") + 1];
const data = ${JSON.stringify({ open, merged })};
process.stdout.write(JSON.stringify(state === "open" ? data.open : data.merged));
`;
  const ghPath = path.join(binDir, "gh");
  writeFileSync(ghPath, script);
  chmodSync(ghPath, 0o755);
  return { ...environment, PATH: `${binDir}${path.delimiter}${environment.PATH || process.env.PATH}` };
}

const TASKS = {
  tableId: "tblAAAAAAAAAAAAAA",
  statusField: "Status",
  notesField: "Notes",
  statusInProgress: "En progreso",
  statusDone: "Hecho"
};

function fullConfig() {
  return {
    schemaVersion: 1,
    project: { id: "example", name: "Example" },
    workspace: {
      repositories: [{ id: "backend", path: "backend", role: "backend", profiles: ["python"] }]
    },
    drive: {
      sharedDrive: "Example-Workspace",
      links: { docs: "docs", ".claude/skills": "skills" }
    },
    airtable: {
      baseId: "appAAAAAAAAAAAAAA",
      tasks: TASKS,
      reconcileRepos: ["example/backend"],
      lookbackDays: 21
    },
    context: { instructions: ["AGENTS.md"], documents: [] },
    tools: { required: ["git"], optional: ["github"] },
    policies: { protectSecrets: true }
  };
}

function writeWorkspace(root, config = fullConfig()) {
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Instructions\n\n- Example.\n");
}

test("secret path pattern uses word boundaries", () => {
  const config = fullConfig();
  config.context.documents = ["docs/tokenization.md"];
  assert.deepEqual(validateConfig(config).filter((issue) => issue.code === "invalid-context-path"), []);
  for (const blocked of ["docs/api-tokens.md", ".env.local", "config/secrets.md", "keys/private-key.pem"]) {
    config.context.documents = [blocked];
    assert.equal(validateConfig(config).some((issue) => issue.code === "invalid-context-path"), true, blocked);
  }
});

test("validates drive and airtable sections", () => {
  const config = fullConfig();
  assert.deepEqual(validateConfig(config), []);

  config.drive.links = { "../escape": "docs" };
  assert.equal(validateConfig(config).some((issue) => issue.code === "invalid-drive-link"), true);
  config.drive.links = { docs: "docs" };

  config.airtable.baseId = "not-a-base";
  assert.equal(validateConfig(config).some((issue) => issue.code === "invalid-airtable"), true);
  config.airtable.baseId = "appAAAAAAAAAAAAAA";

  config.airtable.tasks = { ...TASKS, statusDone: "" };
  assert.equal(validateConfig(config).some((issue) => issue.code === "invalid-airtable"), true);
  config.airtable.tasks = TASKS;

  config.airtable.reconcileRepos = ["not a repo"];
  assert.equal(validateConfig(config).some((issue) => issue.code === "invalid-airtable"), true);
});

test("record id extraction only accepts labelled ids and task-table URLs", () => {
  const body = [
    "Airtable: recAAAAAAAAAAAAAA",
    "task #recBBBBBBBBBBBBBB",
    "unrelated recCCCCCCCCCCCCCC",
    `https://airtable.com/appX/${TASKS.tableId}/recDDDDDDDDDDDDDD`
  ].join("\n");
  assert.deepEqual(extractRecordIds(body, TASKS.tableId), [
    "recAAAAAAAAAAAAAA",
    "recBBBBBBBBBBBBBB",
    "recDDDDDDDDDDDDDD"
  ]);
});

test("PR URL extraction and idempotent note appending", () => {
  const url = "https://github.com/example/backend/pull/12";
  assert.equal(extractPrUrl("created", `output ${url} done`), url);
  assert.equal(extractPrUrl("no url here"), "");

  const line = `PR (1/2/2026): ${url}`;
  assert.deepEqual(noteWithPr("Notes", "", line), { Notes: line });
  assert.deepEqual(noteWithPr("Notes", `previous\n${line}`, line), {});
  assert.deepEqual(noteWithPr("Notes", `already links ${url}`, `PR (2/2/2026): ${url}`), {});
});

test("env loader handles quotes and export prefixes without overriding the shell", () => {
  const root = temporaryDirectory();
  writeFileSync(path.join(root, ".env.local"), 'AIRTABLE_API_KEY="patXYZ"\nexport EXTRA=1\n# comment\n');
  const environment = { AIRTABLE_API_KEY: "from-shell" };
  const loaded = loadEnvLocal(root, environment);
  assert.equal(loaded.AIRTABLE_API_KEY, "patXYZ");
  assert.equal(environment.AIRTABLE_API_KEY, "from-shell");
  assert.equal(environment.EXTRA, "1");
});

test("setup creates drive links, env template, and gitignore entries idempotently", () => {
  const root = temporaryDirectory();
  const fakeDrive = temporaryDirectory();
  mkdirSync(path.join(fakeDrive, "docs"));
  mkdirSync(path.join(fakeDrive, "skills"));
  writeWorkspace(root);
  execFileSync("git", ["init", "-q", root]);
  const environment = { ...process.env, NEMEDA_DRIVE_ROOT: fakeDrive };

  const dryRun = setupWorkspace(root, { dryRun: true, environment });
  assert.equal(dryRun.actions.some((entry) => entry.status === "planned"), true);
  assert.equal(existsSync(path.join(root, "docs")), false);

  const first = setupWorkspace(root, { environment });
  assert.equal(lstatSync(path.join(root, "docs")).isSymbolicLink(), true);
  assert.equal(lstatSync(path.join(root, ".claude", "skills")).isSymbolicLink(), true);
  assert.equal(readFileSync(path.join(root, ".env.local"), "utf8").includes("AIRTABLE_API_KEY="), true);
  const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const entry of ["docs", ".claude/skills", ".env.local", ".nemeda/state/", "backend/"]) {
    assert.equal(gitignore.includes(entry), true, entry);
  }
  assert.equal(first.actions.some((entry) => entry.status === "error"), false);

  const second = setupWorkspace(root, { environment });
  assert.equal(second.actions.every((entry) => ["kept", "ok", "skipped"].includes(entry.status)), true);
});

test("doctor reports drive, repository, and airtable readiness", () => {
  const root = temporaryDirectory();
  const fakeDrive = temporaryDirectory();
  mkdirSync(path.join(fakeDrive, "docs"));
  mkdirSync(path.join(fakeDrive, "skills"));
  writeFileSync(path.join(fakeDrive, "docs", "README.md"), "content");
  writeWorkspace(root);
  execFileSync("git", ["init", "-q", root]);

  process.env.NEMEDA_DRIVE_ROOT = fakeDrive;
  try {
    const before = workspaceDoctor(root);
    assert.equal(before.checks.some((check) => check.code === "drive-link" && check.status === "fail"), true);
    assert.equal(before.checks.some((check) => check.code === "workspace-repository" && check.status === "warn"), true);
    assert.equal(before.checks.some((check) => check.code === "airtable-env" && check.status === "warn"), true);

    setupWorkspace(root, { environment: { ...process.env } });
    const after = workspaceDoctor(root);
    assert.equal(after.checks.some((check) => check.code === "drive-link" && check.status === "fail"), false);
    assert.equal(after.checks.some((check) => check.code === "airtable-env-ignored"), false);
  } finally {
    delete process.env.NEMEDA_DRIVE_ROOT;
  }
});

test("init --workspace scans nested git repositories", () => {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, "backend"));
  mkdirSync(path.join(root, "frontend"));
  execFileSync("git", ["init", "-q", path.join(root, "backend")]);
  execFileSync("git", ["init", "-q", path.join(root, "frontend")]);
  writeFileSync(path.join(root, "backend", "package.json"), JSON.stringify({ dependencies: { "@nestjs/core": "1" } }));

  const result = initializeWorkspace(root, { workspace: true, projectId: "demo" });
  const repositories = result.config.workspace.repositories;
  assert.deepEqual(repositories.map((repository) => repository.path).sort(), ["backend", "frontend"]);
  assert.equal(repositories.find((repository) => repository.path === "backend").profiles.includes("nestjs"), true);
  assert.equal(result.config.project.id, "demo");
  assert.equal(result.config.repository, undefined);
});

test("init honours --project-id for the repository id", () => {
  const root = temporaryDirectory();
  const result = initializeWorkspace(root, { projectId: "custom-id" });
  assert.equal(result.config.repository.id, "custom-id");
});

test("pr sync hook skips safely and honours dry-run without network access", async () => {
  const root = temporaryDirectory();
  writeWorkspace(root);
  const environment = { ...process.env, PR_AIRTABLE_SYNC_DRYRUN: "true" };
  delete environment.CLAUDE_PROJECT_DIR;

  assert.equal((await prSyncFromEvent({ tool_name: "Read" }, environment)).skipped, "not-bash");
  assert.equal(
    (await prSyncFromEvent({ tool_name: "Bash", cwd: root, tool_input: { command: "ls" } }, environment)).skipped,
    "not-pr-create"
  );
  const noId = await prSyncFromEvent(
    { tool_name: "Bash", cwd: root, tool_input: { command: "gh pr create --title x" } },
    environment
  );
  assert.equal(noId.skipped, "no-record-ids");

  const noUrl = await prSyncFromEvent(
    {
      tool_name: "Bash",
      cwd: root,
      tool_input: { command: "gh pr create --body 'Airtable: recAAAAAAAAAAAAAA'" },
      tool_response: { stdout: "error: could not create" }
    },
    environment
  );
  assert.equal(noUrl.skipped, "no-pr-url");

  const dryRun = await prSyncFromEvent(
    {
      tool_name: "Bash",
      cwd: root,
      tool_input: { command: "gh pr create --body 'Airtable: recAAAAAAAAAAAAAA'" },
      tool_response: { stdout: "https://github.com/example/backend/pull/7" }
    },
    environment
  );
  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(dryRun.recordIds, ["recAAAAAAAAAAAAAA"]);
  assert.equal(dryRun.status, "En progreso");
});

test("reconcile hook is throttled between runs", async () => {
  const root = temporaryDirectory();
  writeWorkspace(root);
  const environment = { ...process.env, PR_AIRTABLE_SYNC_DRYRUN: "true", PR_RECONCILE_REPO: "example/none" };
  delete environment.CLAUDE_PROJECT_DIR;

  const first = await reconcilePrs({ cwd: root }, environment);
  assert.equal(first.dryRun, true);
  const second = await reconcilePrs({ cwd: root }, environment);
  assert.equal(second.skipped, "throttled");
  const forced = await reconcilePrs({ cwd: root }, environment, { force: true });
  assert.equal(forced.dryRun, true);
});

test("reconcile detects open and merged PRs from GitHub directly, without a local `gh pr create` command", async () => {
  const root = temporaryDirectory();
  writeWorkspace(root);
  const environment = withFakeGh({ ...process.env, PR_AIRTABLE_SYNC_DRYRUN: "true", PR_RECONCILE_REPO: "example/backend" }, {
    open: [{ number: 1, url: "https://github.com/example/backend/pull/1", body: "Airtable: recOPENOPENOPENA1", createdAt: new Date().toISOString() }],
    merged: [{ number: 2, url: "https://github.com/example/backend/pull/2", body: "Airtable: recDONEDONEDONEB2", mergedAt: new Date().toISOString() }]
  });
  delete environment.CLAUDE_PROJECT_DIR;

  const result = await reconcilePrs({ cwd: root }, environment);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.inProgressTargets, { recOPENOPENOPENA1: "https://github.com/example/backend/pull/1" });
  assert.deepEqual(result.doneTargets, { recDONEDONEDONEB2: "https://github.com/example/backend/pull/2" });
});

test("reconcile lets a merged PR win over a stale open one for the same task", async () => {
  const root = temporaryDirectory();
  writeWorkspace(root);
  const environment = withFakeGh({ ...process.env, PR_AIRTABLE_SYNC_DRYRUN: "true", PR_RECONCILE_REPO: "example/backend" }, {
    open: [{ number: 1, url: "https://github.com/example/backend/pull/1", body: "Airtable: recSAMESAMESAME01", createdAt: new Date().toISOString() }],
    merged: [{ number: 3, url: "https://github.com/example/backend/pull/3", body: "Airtable: recSAMESAMESAME01", mergedAt: new Date().toISOString() }]
  });
  delete environment.CLAUDE_PROJECT_DIR;

  const result = await reconcilePrs({ cwd: root }, environment);
  assert.deepEqual(result.inProgressTargets, {});
  assert.deepEqual(result.doneTargets, { recSAMESAMESAME01: "https://github.com/example/backend/pull/3" });
});
