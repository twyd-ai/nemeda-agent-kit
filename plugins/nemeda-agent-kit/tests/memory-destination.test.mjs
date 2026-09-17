// Drive-config plan phase 2b (docs/drive-config-plan.md, guards 4 and 5):
// memory folders identified relative to their shared drive, containment in
// that drive, and a move within it pausing unattended writers (harvest,
// meeting entries, the automatic sync) until `memory trust`, while
// interactive commands only warn.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordEntry } from "../scripts/lib/memory.mjs";
import {
  checkMemoryWrite,
  describeCentralTrust,
  folderIdentity,
  memoryDestinationChecks,
  pendingFolderChanges,
  trustCentralPins,
  trustPendingFolders,
  workspacePinsPath
} from "../scripts/lib/memory-pins.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "cli.mjs");
const execFileAsync = promisify(execFile);

// A workspace whose .nemeda/memory links into a temporary "shared drive"
// (NEMEDA_DRIVE_ROOT), with a second, more widely shared folder to move to.
function driveWorkspace({ central } = {}) {
  const drive = mkdtempSync(path.join(tmpdir(), "nemeda-drive-"));
  mkdirSync(path.join(drive, "memory"), { recursive: true });
  mkdirSync(path.join(drive, "shared-with-everyone"), { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-destination-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  const config = {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "backend", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    drive: { provider: "google", sharedDrive: "Acme", links: { ".nemeda/memory": "memory" } },
    memory: { project: { path: ".nemeda/memory" }, ...(central ? { central } : {}) }
  };
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  symlinkSync(path.join(drive, "memory"), path.join(root, ".nemeda", "memory"));
  return { root, drive, config, environment: { ...process.env, NEMEDA_DRIVE_ROOT: drive } };
}

function relink(root, target) {
  rmSync(path.join(root, ".nemeda", "memory"));
  symlinkSync(target, path.join(root, ".nemeda", "memory"));
}

test("a memory folder is identified relative to its shared drive, whatever the mount path", () => {
  const { root, drive, config, environment } = driveWorkspace();
  assert.equal(folderIdentity(root, ".nemeda/memory", config.drive, environment).identity, "drive:google:Acme:memory");
  const alias = path.join(mkdtempSync(path.join(tmpdir(), "nemeda-mount-")), "Acme");
  symlinkSync(drive, alias);
  assert.equal(folderIdentity(root, ".nemeda/memory", config.drive, { ...environment, NEMEDA_DRIVE_ROOT: alias }).identity, "drive:google:Acme:memory");
});

test("the drive is located with the workspace .env.local too, like the configuration loader", () => {
  const { root, drive, config, environment } = driveWorkspace();
  const { NEMEDA_DRIVE_ROOT: _drive, ...withoutDrive } = environment;
  writeFileSync(path.join(root, ".env.local"), `NEMEDA_DRIVE_ROOT=${drive}\n`);
  assert.deepEqual(checkMemoryWrite(root, config, { unattended: true, environment: withoutDrive }), { allowed: true });
  assert.equal(JSON.parse(readFileSync(workspacePinsPath(root), "utf8")).folders.memory.identity, "drive:google:Acme:memory");
  assert.equal(withoutDrive.NEMEDA_DRIVE_ROOT, undefined, "the caller's environment is never mutated");
});

test("a move within the drive pauses unattended writers, warns interactive ones, and one trust resumes both", () => {
  const { root, drive, config, environment } = driveWorkspace();
  assert.deepEqual(checkMemoryWrite(root, config, { unattended: true, environment }), { allowed: true }, "first use pins silently");

  relink(root, path.join(drive, "shared-with-everyone"));
  const unattended = checkMemoryWrite(root, config, { unattended: true, environment });
  assert.equal(unattended.allowed, false);
  assert.equal(unattended.reason, "folder-moved");
  assert.match(unattended.message, /Acme\/memory to Acme\/shared-with-everyone/);
  const interactive = checkMemoryWrite(root, config, { environment });
  assert.equal(interactive.allowed, true);
  assert.match(interactive.warning, /paused until a person confirms/);
  assert.deepEqual(pendingFolderChanges(root), [{ kind: "memory folder", from: "Acme/memory", to: "Acme/shared-with-everyone" }]);

  trustPendingFolders(root);
  assert.deepEqual(checkMemoryWrite(root, config, { unattended: true, environment }), { allowed: true });
  assert.deepEqual(pendingFolderChanges(root), []);
});

test("a memory folder outside its shared drive is refused for every writer", () => {
  const { root, config, environment } = driveWorkspace();
  checkMemoryWrite(root, config, { environment });
  relink(root, mkdtempSync(path.join(tmpdir(), "nemeda-elsewhere-")));
  for (const unattended of [true, false]) {
    const guard = checkMemoryWrite(root, config, { unattended, environment });
    assert.equal(guard.allowed, false);
    assert.equal(guard.reason, "outside-drive");
  }
});

test("a changed project refuses memory writes until trusted", () => {
  const central = { mcpUrl: "https://memory.example.ts.net/mcp" };
  const { root, config, environment } = driveWorkspace({ central });
  const personal = { ...environment, NEMEDA_HOME: mkdtempSync(path.join(tmpdir(), "nemeda-home-")) };
  trustCentralPins(root, { mcpUrl: central.mcpUrl, projectId: "acme" }, personal);
  const renamed = { ...config, memory: { ...config.memory, central: { ...central, projectId: "other-client" } } };
  const guard = checkMemoryWrite(root, renamed, { environment: personal });
  assert.equal(guard.allowed, false);
  assert.equal(guard.reason, "untrusted-project");
  assert.ok(describeCentralTrust(root, { mcpUrl: central.mcpUrl, projectId: "other-client" }, personal).changes.some((change) => change.kind === "project"));
});

test("recordEntry (meeting entries) stops writing while the folder move is unconfirmed", () => {
  const { root, drive, environment } = driveWorkspace();
  const previous = process.env.NEMEDA_DRIVE_ROOT;
  process.env.NEMEDA_DRIVE_ROOT = environment.NEMEDA_DRIVE_ROOT;
  try {
    assert.ok(recordEntry(root, { type: "meeting", title: "Kick-off", summary: "Before the move." }));
    relink(root, path.join(drive, "shared-with-everyone"));
    assert.equal(recordEntry(root, { type: "meeting", title: "Stand-up", summary: "After the move." }), null);
    assert.equal(existsSync(path.join(drive, "shared-with-everyone", "journal")), false, "nothing written to the new folder");
  } finally {
    if (previous === undefined) delete process.env.NEMEDA_DRIVE_ROOT;
    else process.env.NEMEDA_DRIVE_ROOT = previous;
  }
});

test("doctor reports the paused destination without recording anything, and the CLI applies the guard", async () => {
  const { root, drive, config, environment } = driveWorkspace();
  checkMemoryWrite(root, config, { environment });
  relink(root, path.join(drive, "shared-with-everyone"));

  assert.deepEqual(memoryDestinationChecks(root, config, environment).map((check) => [check.code, check.status]), [["memory-destination", "warn"]]);
  assert.equal(JSON.parse(readFileSync(workspacePinsPath(root), "utf8")).pendingFolders, undefined, "doctor records no pending move");

  const run = (args, input = "") => execFileAsync(process.execPath, [cliPath, ...args, "--cwd", root], { env: environment, encoding: "utf8", input });
  await assert.rejects(run(["memory", "sync", "--unattended"]), (error) => /Unattended writes .* are paused/.test(error.stderr));

  const added = execFileSync(process.execPath, [cliPath, "memory", "add", "--type", "decision", "--title", "Interactive", "--cwd", root], {
    env: environment,
    encoding: "utf8",
    input: "A person is at the terminal.",
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.match(added, /Logged/);
  assert.ok(existsSync(path.join(drive, "shared-with-everyone", "journal", "ana@example.com.jsonl")), "an interactive write goes ahead with a warning");
});
