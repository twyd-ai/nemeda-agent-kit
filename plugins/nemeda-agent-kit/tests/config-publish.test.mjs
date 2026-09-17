// Phase 3 of docs/drive-config-plan.md: `init --from-drive` and
// `config publish`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyInitFromDrive, applyPublish, planInitFromDrive, planPublish } from "../scripts/lib/config-publish.mjs";
import { centralSettings, resolveCentralToken } from "../scripts/lib/memory-central.mjs";
import { evaluateCentralPins } from "../scripts/lib/memory-pins.mjs";
import { readWorkspaceContext } from "../scripts/lib/workspace.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "nemeda-config-publish-"));
}

function projectConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    workspace: { repositories: [{ id: "acme-api", path: "api", role: "backend", profiles: [] }] },
    context: { instructions: ["AGENTS.md"], documents: [] },
    tools: { required: ["git"], optional: [] },
    policies: { protectSecrets: true },
    drive: { provider: "google", sharedDrive: "Acme", links: { docs: "docs" } },
    memory: { project: { path: ".nemeda/memory" }, central: { mcpUrl: "https://memory.example.test/mcp", projectId: "acme" } },
    ...overrides
  };
}

function makeDrive(base, { config = projectConfig(), agents = "# Acme\n\n- Drive rule.\n" } = {}) {
  const drive = path.join(base, "drive");
  mkdirSync(path.join(drive, "config"), { recursive: true });
  if (config) writeFileSync(path.join(drive, "config", "agent-kit.json"), JSON.stringify(config, null, 2));
  if (agents) writeFileSync(path.join(drive, "config", "AGENTS.md"), agents);
  return drive;
}

function makeLocalWorkspace(base, { config = projectConfig(), agents = "# Acme\n\n- Local rule.\n" } = {}) {
  const root = path.join(base, "workspace");
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), `${JSON.stringify(config, null, 2)}\n`);
  if (agents) writeFileSync(path.join(root, "AGENTS.md"), agents);
  return root;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("init --from-drive shows what the drive copy declares, then writes only the pointer", () => {
  const base = temporaryDirectory();
  const drive = makeDrive(base);
  const root = path.join(base, "workspace");
  mkdirSync(root);
  const environment = { NEMEDA_DRIVE_ROOT: drive };

  const plan = planInitFromDrive(root, { sharedDrive: "Acme", environment });
  assert.deepEqual(plan.project, { id: "acme", name: "Acme" });
  assert.deepEqual(plan.sections, ["drive", "memory"]);
  assert.deepEqual(plan.instructions, [{ path: "AGENTS.md", from: "drive" }]);
  assert.deepEqual(plan.central, { url: "https://memory.example.test/mcp", origin: "https://memory.example.test", projectId: "acme" });
  assert.deepEqual(plan.pointer, { schemaVersion: 1, source: { provider: "google", sharedDrive: "Acme" } });
  assert.equal(plan.gitExclude, null);
  assert.equal(existsSync(path.join(root, ".nemeda")), false, "planning writes nothing");

  const result = applyInitFromDrive(plan);
  assert.equal(result.actions[0].kind, "pointer");
  assert.ok(result.nextSteps.some((step) => /memory trust/.test(step)), "trusting the service is left to memory trust");
  const context = readWorkspaceContext(root, { environment });
  assert.equal(context.configSource, "drive");
  assert.equal(context.config.project.id, "acme");
  assert.equal(existsSync(path.join(root, ".nemeda", "state", "pins.json")), false, "init records no central trust");

  // The first use from the pointer sends nothing until a person trusts it.
  const personal = { ...environment, NEMEDA_HOME: path.join(base, "home"), NEMEDA_MEMORY_TOKEN: "nmt_test" };
  const token = resolveCentralToken(root, centralSettings(context.config, { configSource: context.configSource }), personal);
  assert.equal(token.token, null);
  assert.equal(token.reason, "untrusted-origin");
});

test("init --from-drive refuses a folder that is already configured, and a drive copy it cannot use", () => {
  const base = temporaryDirectory();
  const drive = makeDrive(base);
  const environment = { NEMEDA_DRIVE_ROOT: drive };
  const configured = makeLocalWorkspace(base);
  assert.throws(() => planInitFromDrive(configured, { sharedDrive: "Acme", environment }), /config publish/);

  const empty = path.join(base, "empty");
  mkdirSync(empty);
  assert.throws(() => planInitFromDrive(empty, { sharedDrive: "Acme", environment: { NEMEDA_DRIVE_ROOT: path.join(base, "nowhere") } }), /cannot be used: .*not available/);
  assert.throws(() => planInitFromDrive(empty, { sharedDrive: "Acme", drivePath: "../escape.json", environment }), /source.path/);

  const other = path.join(base, "other");
  makeDrive(other, { config: projectConfig({ drive: { provider: "google", sharedDrive: "Other", links: { docs: "docs" } } }) });
  assert.throws(() => planInitFromDrive(empty, { sharedDrive: "Acme", environment: { NEMEDA_DRIVE_ROOT: path.join(other, "drive") } }), /declares google "Other"/);
  assert.equal(existsSync(path.join(empty, ".nemeda")), false);
});

test("init --from-drive inside a Git repository keeps the pointer out of it through .git/info/exclude", () => {
  const base = temporaryDirectory();
  const drive = makeDrive(base);
  const repository = path.join(base, "client-repo");
  mkdirSync(repository);
  git(repository, "init", "-q");
  const environment = { NEMEDA_DRIVE_ROOT: drive };

  const plan = planInitFromDrive(repository, { sharedDrive: "Acme", environment });
  assert.equal(plan.gitExclude.pattern, "/.nemeda/");
  applyInitFromDrive(plan);
  assert.match(readFileSync(path.join(repository, ".git", "info", "exclude"), "utf8"), /^\/\.nemeda\/$/m);
  assert.equal(git(repository, "status", "--porcelain"), "", "the client repository shows no change");
  assert.equal(existsSync(path.join(repository, ".gitignore")), false);
});

test("config publish moves the configuration and AGENTS.md to the drive and leaves a pointer and a backup", () => {
  const base = temporaryDirectory();
  const drive = makeDrive(base, { config: null, agents: null });
  const root = makeLocalWorkspace(base);
  const environment = { NEMEDA_DRIVE_ROOT: drive };

  const plan = planPublish(root, { environment });
  assert.equal(plan.copyConfig, true);
  assert.deepEqual(plan.instructions.map((entry) => [entry.path, entry.action]), [["AGENTS.md", "copy"]]);
  assert.equal(existsSync(path.join(drive, "config", "agent-kit.json")), false, "planning writes nothing");

  const result = applyPublish(plan, { environment });
  assert.equal(existsSync(path.join(drive, "config", "agent-kit.json")), true);
  assert.match(readFileSync(path.join(drive, "config", "AGENTS.md"), "utf8"), /Local rule/);
  assert.equal(existsSync(path.join(root, ".nemeda", "agent-kit.json")), false);
  assert.equal(existsSync(path.join(root, ".nemeda", "agent-kit.link.json")), true);
  assert.equal(JSON.parse(readFileSync(path.join(root, ".nemeda", "state", "agent-kit.local-backup.json"), "utf8")).project.id, "acme");
  assert.ok(result.nextSteps.some((step) => step.includes('init --from-drive "Acme"')));

  const context = readWorkspaceContext(root, { environment });
  assert.equal(context.configSource, "drive");
  assert.equal(context.config.memory.central.projectId, "acme");
  assert.equal(context.instructions[0].source, "drive");
});

function trustAsRepository(root, environment) {
  const config = readWorkspaceContext(root).config;
  const settings = centralSettings(config, { configSource: "repository" });
  return evaluateCentralPins(root, { mcpUrl: settings.mcpUrl, projectId: settings.projectId, configSource: "repository" }, environment);
}

test("config publish keeps central trust a workspace already had, and sync state and the memory link in place", () => {
  const base = temporaryDirectory();
  const drive = makeDrive(base, { config: null, agents: null });
  const root = makeLocalWorkspace(base);
  mkdirSync(path.join(root, ".nemeda", "memory"), { recursive: true });
  mkdirSync(path.join(root, ".nemeda", "state"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "state", "memory-sync.json"), "{\"sent\":[]}\n");
  const environment = { NEMEDA_DRIVE_ROOT: drive, NEMEDA_HOME: path.join(base, "home"), NEMEDA_MEMORY_TOKEN: "nmt_test" };
  assert.equal(trustAsRepository(root, environment).recorded, true, "a repository-hosted workspace pins on first use");

  const plan = planPublish(root, { environment });
  assert.equal(plan.central.trustedFromDrive, true);
  const result = applyPublish(plan, { environment });
  assert.equal(result.nextSteps.some((step) => /memory trust/.test(step)), false);

  const context = readWorkspaceContext(root, { environment });
  const token = resolveCentralToken(root, centralSettings(context.config, { configSource: context.configSource }), environment);
  assert.equal(token.token, "nmt_test", "the trusted service still gets the token");
  assert.equal(readFileSync(path.join(root, ".nemeda", "state", "memory-sync.json"), "utf8"), "{\"sent\":[]}\n");
  assert.equal(existsSync(path.join(root, ".nemeda", "memory")), true);
});

test("config publish of a workspace that never pinned the service asks for memory trust before anything is sent", () => {
  const base = temporaryDirectory();
  const drive = makeDrive(base, { config: null, agents: null });
  const root = makeLocalWorkspace(base);
  const environment = { NEMEDA_DRIVE_ROOT: drive, NEMEDA_HOME: path.join(base, "home"), NEMEDA_MEMORY_TOKEN: "nmt_test" };

  const plan = planPublish(root, { environment });
  assert.equal(plan.central.trustedFromDrive, false);
  const result = applyPublish(plan, { environment });
  assert.ok(result.nextSteps.some((step) => /memory trust/.test(step)));
  const context = readWorkspaceContext(root, { environment });
  const token = resolveCentralToken(root, centralSettings(context.config, { configSource: context.configSource }), environment);
  assert.equal(token.token, null);
  assert.equal(token.reason, "untrusted-origin");
});

test("config publish accepts an identical drive copy and refuses a different one without changing anything", () => {
  const base = temporaryDirectory();
  const reordered = Object.fromEntries(Object.entries(projectConfig()).reverse());
  const drive = makeDrive(base, { config: reordered, agents: "# Acme\n\n- Local rule.\n" });
  const root = makeLocalWorkspace(base);
  const environment = { NEMEDA_DRIVE_ROOT: drive };

  const same = planPublish(root, { environment });
  assert.equal(same.copyConfig, false);
  assert.deepEqual(same.instructions.map((entry) => entry.action), ["kept"]);

  writeFileSync(path.join(drive, "config", "agent-kit.json"), JSON.stringify(projectConfig({ project: { id: "acme", name: "Acme renamed" } })));
  assert.throws(() => planPublish(root, { environment }), /different configuration already exists/);
  writeFileSync(path.join(drive, "config", "agent-kit.json"), JSON.stringify(reordered));
  writeFileSync(path.join(drive, "config", "AGENTS.md"), "# Someone else's rules\n");
  assert.throws(() => planPublish(root, { environment }), /AGENTS\.md differs/);
  assert.equal(existsSync(path.join(root, ".nemeda", "agent-kit.json")), true);
});

test("config publish refuses what it should not move", () => {
  const base = temporaryDirectory();
  const drive = makeDrive(base, { config: null, agents: null });
  const environment = { NEMEDA_DRIVE_ROOT: drive };

  const noDrive = projectConfig();
  delete noDrive.drive;
  const withoutDrive = makeLocalWorkspace(path.join(base, "a"), { config: noDrive });
  mkdirSync(path.join(base, "a"), { recursive: true });
  assert.throws(() => planPublish(withoutDrive, { environment }), /no drive section/);

  const tracked = makeLocalWorkspace(path.join(base, "b"));
  git(tracked, "init", "-q");
  git(tracked, "add", ".nemeda/agent-kit.json");
  assert.throws(() => planPublish(tracked, { environment }), /tracked by Git/);

  const unconfigured = path.join(base, "c");
  mkdirSync(unconfigured);
  assert.throws(() => planPublish(unconfigured, { environment }), /No .*agent-kit\.json found/);
});

test("config publish restores the local configuration when the drive copy cannot be read back", () => {
  const base = temporaryDirectory();
  const drive = makeDrive(base, { config: null, agents: null });
  const root = makeLocalWorkspace(base);
  const plan = planPublish(root, { environment: { NEMEDA_DRIVE_ROOT: drive } });

  assert.throws(() => applyPublish(plan, { environment: { NEMEDA_DRIVE_ROOT: path.join(base, "unmounted") } }), /local configuration was restored/);
  assert.equal(existsSync(path.join(root, ".nemeda", "agent-kit.json")), true);
  assert.equal(existsSync(path.join(root, ".nemeda", "agent-kit.link.json")), false);
  assert.equal(readWorkspaceContext(root).configSource, "repository");
});

test("the CLI changes nothing without --yes when there is no terminal, and applies with it", () => {
  const base = temporaryDirectory();
  const drive = makeDrive(base);
  const root = path.join(base, "workspace");
  mkdirSync(root);
  const run = (...args) => execFileSync(process.execPath, [path.join(PLUGIN_ROOT, "scripts", "cli.mjs"), ...args], {
    cwd: root,
    env: { ...process.env, NEMEDA_DRIVE_ROOT: drive },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  assert.throws(() => run("init", "--from-drive", "Acme"), (error) => /Nothing changed/.test(error.stderr));
  assert.equal(existsSync(path.join(root, ".nemeda")), false);
  assert.match(run("init", "--from-drive", "Acme", "--dry-run"), /Will create: /);
  assert.equal(existsSync(path.join(root, ".nemeda")), false);
  assert.match(run("init", "--from-drive", "Acme", "--yes"), /\[CREATED\] pointer/);
  assert.equal(existsSync(path.join(root, ".nemeda", "agent-kit.link.json")), true);
  assert.throws(() => run("config", "publish", "--yes"), (error) => /already takes its configuration from the shared drive/.test(error.stderr));
});
