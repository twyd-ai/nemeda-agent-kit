import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { airtableConfigSnippet, canonicalBaseSchema } from "../scripts/lib/airtable-provision.mjs";
import {
  DEFAULT_DRIVE_PROVIDER,
  DRIVE_PROVIDERS,
  driveInstallInstructions,
  driveMountCandidates,
  driveProvider,
  findSharedDrive,
  planDriveLinks
} from "../scripts/lib/drive.mjs";
import { setupWorkspace } from "../scripts/lib/setup.mjs";
import { validateConfig } from "../scripts/lib/workspace.mjs";

function makeWorkspace({ scaffold = [], driveContent = null } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "nemeda-prov-"));
  const root = path.join(base, "workspace");
  const drive = path.join(base, "drive", "Acme");
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  mkdirSync(drive, { recursive: true });
  if (driveContent) for (const folder of driveContent) mkdirSync(path.join(drive, folder), { recursive: true });
  const config = {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "workspace", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    drive: {
      sharedDrive: "Acme",
      links: { docs: "docs", ".claude/skills": "skills" },
      ...(scaffold.length ? { scaffold } : {})
    }
  };
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  return { root, drive };
}

test("setup provisions missing drive folders with convention READMEs, then links them", () => {
  const { root, drive } = makeWorkspace({ scaffold: ["docs/meetings", "docs/plans"] });
  const report = setupWorkspace(root, { environment: { NEMEDA_DRIVE_ROOT: drive } });
  assert.ok(existsSync(path.join(drive, "docs")), "docs created on the drive");
  assert.ok(existsSync(path.join(drive, "skills")));
  assert.ok(existsSync(path.join(drive, "docs", "meetings")), "scaffold created");
  assert.ok(existsSync(path.join(drive, "docs", "plans")));
  assert.match(readFileSync(path.join(drive, "docs", "README.md"), "utf8"), /File things in the matching subfolder/);
  assert.match(readFileSync(path.join(drive, "skills", "README.md"), "utf8"), /improves for everyone/);
  assert.ok(lstatSync(path.join(root, "docs")).isSymbolicLink(), "link created after provisioning");
  assert.ok(report.actions.some((entry) => entry.kind === "drive-folder" && entry.status === "created"));
  assert.ok(report.actions.some((entry) => entry.kind === "scaffold" && entry.status === "created"));
});

test("setup is idempotent over provisioned folders and never overwrites a README", () => {
  const { root, drive } = makeWorkspace({ scaffold: ["docs/meetings"] });
  setupWorkspace(root, { environment: { NEMEDA_DRIVE_ROOT: drive } });
  writeFileSync(path.join(drive, "docs", "README.md"), "custom content\n");
  const second = setupWorkspace(root, { environment: { NEMEDA_DRIVE_ROOT: drive } });
  assert.equal(readFileSync(path.join(drive, "docs", "README.md"), "utf8"), "custom content\n");
  assert.ok(second.actions.every((entry) => entry.status !== "created" || entry.kind === "env" || entry.kind === "gitignore"));
});

test("dry run plans drive folders without touching the drive", () => {
  const { root, drive } = makeWorkspace({ scaffold: ["docs/meetings"] });
  const report = setupWorkspace(root, { dryRun: true, environment: { NEMEDA_DRIVE_ROOT: drive } });
  assert.ok(!existsSync(path.join(drive, "docs")));
  assert.ok(report.actions.some((entry) => entry.status === "planned"));
});

test("planDriveLinks exposes scaffold targets inside the located drive", () => {
  const { root, drive } = makeWorkspace({ scaffold: [] });
  const plan = planDriveLinks(root, { sharedDrive: "Acme", links: { docs: "docs" }, scaffold: ["docs/x"] }, { NEMEDA_DRIVE_ROOT: drive });
  assert.equal(plan.scaffold.length, 1);
  assert.equal(plan.scaffold[0].target, path.join(drive, "docs/x"));
});

test("findSharedDrive prefers the container that holds only directories", () => {
  const mount = mkdtempSync(path.join(tmpdir(), "nemeda-mount-"));
  // Personal side: a folder with the same name, next to loose files.
  mkdirSync(path.join(mount, "My Drive", "Acme"), { recursive: true });
  writeFileSync(path.join(mount, "My Drive", "notes.txt"), "x");
  // Shared side, localized name, only directories inside.
  mkdirSync(path.join(mount, "Unidades compartidas", "Acme"), { recursive: true });
  mkdirSync(path.join(mount, "Unidades compartidas", "Other"), { recursive: true });
  const found = findSharedDrive("Acme", { NEMEDA_DRIVE_MOUNTS: mount });
  assert.equal(found.drivePath, path.join(mount, "Unidades compartidas", "Acme"));
  const missing = findSharedDrive("Nope", { NEMEDA_DRIVE_MOUNTS: mount });
  assert.equal(missing.drivePath, null);
  assert.match(missing.error, /not found/);
});

test("driveInstallInstructions cover the three platforms", () => {
  assert.match(driveInstallInstructions("darwin"), /brew install/);
  assert.match(driveInstallInstructions("win32"), /drive-letter/);
  assert.match(driveInstallInstructions("linux"), /rclone/);
});

test("drive providers: google is the default and the registry is explicit", () => {
  assert.equal(DEFAULT_DRIVE_PROVIDER, "google");
  assert.deepEqual(DRIVE_PROVIDERS, ["google", "onedrive"]);
  assert.equal(driveProvider().label, "Google Drive");
  assert.equal(driveProvider({ sharedDrive: "Acme" }).id, "google");
  assert.equal(driveProvider({ provider: "google" }).id, "google");
  assert.equal(driveProvider("dropbox"), null);
});

test("provider argument does not change Google behaviour or the escape hatches", () => {
  const mount = mkdtempSync(path.join(tmpdir(), "nemeda-mount-"));
  mkdirSync(path.join(mount, "Shared drives", "Acme"), { recursive: true });
  const environment = { NEMEDA_DRIVE_MOUNTS: mount };
  assert.deepEqual(driveMountCandidates(environment, "darwin", "google"), [mount]);
  assert.deepEqual(driveMountCandidates(environment, "darwin"), driveMountCandidates(environment, "darwin", "google"));
  const implicit = findSharedDrive("Acme", environment);
  const explicit = findSharedDrive("Acme", environment, process.platform, "google");
  assert.deepEqual(explicit, implicit);
  assert.equal(implicit.drivePath, path.join(mount, "Shared drives", "Acme"));
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-root-"));
  const plan = planDriveLinks(root, { provider: "google", sharedDrive: "Acme", links: { docs: "docs" } }, { NEMEDA_DRIVE_ROOT: path.join(mount, "Shared drives", "Acme") });
  assert.equal(plan.provider, "google");
  assert.equal(plan.error, null);
  assert.equal(planDriveLinks(root, { sharedDrive: "Acme", links: { docs: "docs" } }, environment).provider, "google");
});

test("unknown providers are reported, never guessed", () => {
  const mount = mkdtempSync(path.join(tmpdir(), "nemeda-mount-"));
  const missing = findSharedDrive("Acme", { NEMEDA_DRIVE_MOUNTS: mount }, process.platform, "dropbox");
  assert.equal(missing.drivePath, null);
  assert.match(missing.error, /Unknown drive provider "dropbox"/);
  assert.match(driveInstallInstructions("darwin", "dropbox"), /Unknown drive provider/);
  assert.deepEqual(driveMountCandidates({}, "darwin", "dropbox"), []);
});

test("OneDrive: macOS layout resolves a shared folder, a synced library, and flags ambiguity", () => {
  const previousHome = process.env.HOME;
  try {
    // A shared folder someone added to "My files": the exact declared name.
    const personalHome = mkdtempSync(path.join(tmpdir(), "nemeda-onedrive-home-"));
    mkdirSync(path.join(personalHome, "Library", "CloudStorage", "OneDrive-Personal", "Acme"), { recursive: true });
    process.env.HOME = personalHome;
    const personal = findSharedDrive("Acme", {}, "darwin", "onedrive");
    assert.equal(personal.drivePath, path.join(personalHome, "Library", "CloudStorage", "OneDrive-Personal", "Acme"));
    assert.deepEqual(personal.ambiguous, []);

    // A synced SharePoint library: localized library name after "Acme - ".
    const libraryHome = mkdtempSync(path.join(tmpdir(), "nemeda-onedrive-home-"));
    mkdirSync(path.join(libraryHome, "Library", "CloudStorage", "OneDrive-SharedLibraries-Org", "Acme - Documentos"), { recursive: true });
    process.env.HOME = libraryHome;
    const library = findSharedDrive("Acme", {}, "darwin", "onedrive");
    assert.equal(library.drivePath, path.join(libraryHome, "Library", "CloudStorage", "OneDrive-SharedLibraries-Org", "Acme - Documentos"));
    assert.deepEqual(library.ambiguous, []);

    // Both at once: a genuine ambiguity, reported rather than guessed.
    const bothHome = mkdtempSync(path.join(tmpdir(), "nemeda-onedrive-home-"));
    const personalMatch = path.join(bothHome, "Library", "CloudStorage", "OneDrive-Personal", "Acme");
    const libraryMatch = path.join(bothHome, "Library", "CloudStorage", "OneDrive-SharedLibraries-Org", "Acme - Documents");
    mkdirSync(personalMatch, { recursive: true });
    mkdirSync(libraryMatch, { recursive: true });
    process.env.HOME = bothHome;
    const both = findSharedDrive("Acme", {}, "darwin", "onedrive");
    assert.equal(both.ambiguous.length, 2);
    assert.ok(both.ambiguous.includes(personalMatch));
    assert.ok(both.ambiguous.includes(libraryMatch));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("OneDrive: Windows mounts come from injected environment variables, not a blind profile scan", () => {
  const profile = mkdtempSync(path.join(tmpdir(), "nemeda-onedrive-win-"));
  const oneDriveConsumer = mkdtempSync(path.join(tmpdir(), "nemeda-onedrive-consumer-"));
  mkdirSync(path.join(oneDriveConsumer, "Acme"), { recursive: true }); // shared folder in "My files"
  const legacyOrgRoot = path.join(profile, "OneDrive - Acme Org");
  mkdirSync(legacyOrgRoot, { recursive: true });
  const syncClientOrg = path.join(profile, "Acme Org"); // newer SharePoint sync client naming
  mkdirSync(path.join(syncClientOrg, "Acme Team - Documents"), { recursive: true });
  mkdirSync(path.join(profile, "Desktop", "notes"), { recursive: true }); // noise: no " - " child, not a mount

  const environment = { OneDriveConsumer: oneDriveConsumer, USERPROFILE: profile };
  const mounts = driveMountCandidates(environment, "win32", "onedrive");
  assert.ok(mounts.includes(oneDriveConsumer));
  assert.ok(mounts.includes(legacyOrgRoot));
  assert.ok(mounts.includes(syncClientOrg));
  assert.ok(!mounts.includes(path.join(profile, "Desktop")));

  const shared = findSharedDrive("Acme", environment, "win32", "onedrive");
  assert.equal(shared.drivePath, path.join(oneDriveConsumer, "Acme"));
  const library = findSharedDrive("Acme Team", environment, "win32", "onedrive");
  assert.equal(library.drivePath, path.join(syncClientOrg, "Acme Team - Documents"));
});

test("driveInstallInstructions cover OneDrive on the three platforms", () => {
  assert.match(driveInstallInstructions("darwin", "onedrive"), /brew install --cask onedrive/);
  assert.match(driveInstallInstructions("win32", "onedrive"), /microsoft-365\/onedrive/);
  assert.match(driveInstallInstructions("linux", "onedrive"), /rclone mount onedrive/);
});

test("validator accepts an omitted, google, or onedrive provider and rejects others", () => {
  const base = {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "workspace", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true }
  };
  const drive = { sharedDrive: "Acme", links: { docs: "docs" } };
  assert.deepEqual(validateConfig({ ...base, drive }), []);
  assert.deepEqual(validateConfig({ ...base, drive: { provider: "google", ...drive } }), []);
  assert.deepEqual(validateConfig({ ...base, drive: { provider: "onedrive", ...drive } }), []);
  const rejected = validateConfig({ ...base, drive: { provider: "dropbox", ...drive } });
  assert.ok(rejected.some((issue) => issue.code === "invalid-drive" && /drive\.provider must be one of: google, onedrive/.test(issue.message)));
});

test("setup and doctor run unchanged with an explicit google provider", async () => {
  const { root, drive } = makeWorkspace({ scaffold: ["docs/meetings"] });
  const configPath = path.join(root, ".nemeda", "agent-kit.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.drive = { provider: "google", ...config.drive };
  writeFileSync(configPath, JSON.stringify(config));
  const report = setupWorkspace(root, { environment: { NEMEDA_DRIVE_ROOT: drive } });
  assert.ok(report.actions.some((entry) => entry.status === "created"), "links were created");
  assert.ok(existsSync(path.join(drive, "docs", "meetings")));
  const { workspaceDoctor } = await import("../scripts/lib/workspace.mjs");
  const previous = process.env.NEMEDA_DRIVE_ROOT;
  process.env.NEMEDA_DRIVE_ROOT = drive;
  try {
    const checks = workspaceDoctor(root).checks;
    const mountCheck = checks.find((check) => check.code === "drive-mount");
    assert.equal(mountCheck.status, "pass");
    assert.match(mountCheck.message, /\(Google Drive\)/);
    assert.ok(checks.filter((check) => check.code === "drive-link").every((check) => check.status === "pass"));
  } finally {
    if (previous === undefined) delete process.env.NEMEDA_DRIVE_ROOT;
    else process.env.NEMEDA_DRIVE_ROOT = previous;
  }
});

test("setup and doctor run unchanged with an explicit onedrive provider", async () => {
  const { root, drive } = makeWorkspace({ scaffold: ["docs/meetings"] });
  const configPath = path.join(root, ".nemeda", "agent-kit.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.drive = { provider: "onedrive", ...config.drive };
  writeFileSync(configPath, JSON.stringify(config));
  const report = setupWorkspace(root, { environment: { NEMEDA_DRIVE_ROOT: drive } });
  assert.ok(report.actions.some((entry) => entry.status === "created"), "links were created");
  assert.ok(existsSync(path.join(drive, "docs", "meetings")));
  const { workspaceDoctor } = await import("../scripts/lib/workspace.mjs");
  const previous = process.env.NEMEDA_DRIVE_ROOT;
  process.env.NEMEDA_DRIVE_ROOT = drive;
  try {
    const checks = workspaceDoctor(root).checks;
    const mountCheck = checks.find((check) => check.code === "drive-mount");
    assert.equal(mountCheck.status, "pass");
    assert.match(mountCheck.message, /\(OneDrive\)/);
    assert.ok(checks.filter((check) => check.code === "drive-link").every((check) => check.status === "pass"));
  } finally {
    if (previous === undefined) delete process.env.NEMEDA_DRIVE_ROOT;
    else process.env.NEMEDA_DRIVE_ROOT = previous;
  }
});

test("doctor reports drive-ambiguous instead of silently picking a candidate", async () => {
  const { root } = makeWorkspace({});
  const mountA = mkdtempSync(path.join(tmpdir(), "nemeda-mount-a-"));
  const mountB = mkdtempSync(path.join(tmpdir(), "nemeda-mount-b-"));
  mkdirSync(path.join(mountA, "Acme"), { recursive: true });
  mkdirSync(path.join(mountB, "Acme"), { recursive: true });
  const { workspaceDoctor } = await import("../scripts/lib/workspace.mjs");
  const previous = process.env.NEMEDA_DRIVE_MOUNTS;
  process.env.NEMEDA_DRIVE_MOUNTS = [mountA, mountB].join(path.delimiter);
  try {
    const checks = workspaceDoctor(root).checks;
    const ambiguous = checks.find((check) => check.code === "drive-ambiguous");
    assert.ok(ambiguous, "drive-ambiguous check present");
    assert.equal(ambiguous.status, "warn");
    assert.match(ambiguous.message, /Acme/);
    assert.match(ambiguous.message, /NEMEDA_DRIVE_ROOT/);
  } finally {
    if (previous === undefined) delete process.env.NEMEDA_DRIVE_MOUNTS;
    else process.env.NEMEDA_DRIVE_MOUNTS = previous;
  }
});

test("canonical Airtable schema matches what the hooks write", () => {
  const schema = canonicalBaseSchema("Acme");
  const backlog = schema.tables.find((table) => table.name === "Backlog");
  assert.ok(backlog.fields.some((field) => field.name === "Status" && field.type === "singleSelect"));
  assert.ok(backlog.fields.some((field) => field.name === "Notes"));
  const knowledgeLog = schema.tables.find((table) => table.name === "Knowledge Log");
  for (const name of ["Entry", "Date", "Type", "AI Tool", "AI Model", "Status", "Summary"]) {
    assert.ok(knowledgeLog.fields.some((field) => field.name === name), name);
  }
  const snippet = airtableConfigSnippet({ baseId: "appXXXXXXXXXXXXXX", tables: { Backlog: "tblXXXXXXXXXXXXXX", "Knowledge Log": "tblYYYYYYYYYYYYYY" } });
  const config = {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "workspace", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    ...snippet
  };
  // The snippet still carries airtable.knowledgeLog, which the validator now
  // flags as deprecated (warn); only errors would make the config unusable.
  assert.deepEqual(validateConfig(config).filter((issue) => issue.level === "error"), []);
});

test("scaffold appears in the session context so every AI gets the filing map", async () => {
  const { root, drive } = makeWorkspace({ scaffold: ["docs/meetings"] });
  setupWorkspace(root, { environment: { NEMEDA_DRIVE_ROOT: drive } });
  const { readWorkspaceContext, formatContextForHook } = await import("../scripts/lib/workspace.mjs");
  const text = formatContextForHook(readWorkspaceContext(root));
  assert.match(text, /Where things live/);
  assert.match(text, /docs\/meetings/);
  assert.match(text, /never leave files loose/);
});
