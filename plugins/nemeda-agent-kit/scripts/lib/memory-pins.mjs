// Pins that decide where a person's token and a project's memory may go
// (docs/drive-config-plan.md, "Protecting the token and the routing", guards
// 1 and 4). Two stores:
//
// - Per person, ~/.nemeda/central-origins.json: the memory service origins
//   this person trusts with their token.
// - Per workspace, <root>/.nemeda/state/pins.json: the service origin and
//   project.id this workspace was trusted with.
//
// A repository-hosted configuration pins itself silently on its first use
// (push rights and history already vouch for it, and nothing changes for
// existing workspaces). A drive-hosted one, or any later change of origin or
// project, waits for a person to run `nemeda-agent memory trust` at a
// terminal. The check sits in resolveCentralToken, the one step every
// consumer takes before sending the token.
//
// Imports nothing from memory-central.mjs, memory.mjs, or workspace.mjs, so
// every one of them can use it.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceDriveEnvironment } from "./config-source.mjs";
import { findSharedDrive } from "./drive.mjs";

const STORE_VERSION = 1;

export function personalOriginsPath(environment = process.env) {
  return path.join(environment.NEMEDA_HOME || path.join(os.homedir(), ".nemeda"), "central-origins.json");
}

export function workspacePinsPath(root) {
  return path.join(root, ".nemeda", "state", "pins.json");
}

function readStore(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStore(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

// scheme://host[:port] of a service URL, or null.
export function serviceOrigin(mcpUrl) {
  if (!mcpUrl) return null;
  try {
    return new URL(mcpUrl).origin;
  } catch {
    return null;
  }
}

export function trustedOrigins(environment = process.env) {
  const store = readStore(personalOriginsPath(environment));
  return store?.origins && typeof store.origins === "object" ? store.origins : {};
}

export function readWorkspacePins(root) {
  return readStore(workspacePinsPath(root)) || {};
}

function isRepositorySource(configSource) {
  return !configSource || configSource === "repository";
}

// Whether this workspace may send the token (and promote) with the given
// origin and project. `recordFirstUse` lets a repository-hosted workspace pin
// itself silently on first use; doctor passes false so diagnosing never
// changes state. Returns { trusted, reason, message, firstUse, recorded,
// origin, pinnedOrigin, projectId, pinnedProjectId }.
export function evaluateCentralPins(root, { mcpUrl, projectId, configSource } = {}, environment = process.env, { recordFirstUse = true } = {}) {
  const origin = serviceOrigin(mcpUrl);
  const pins = readWorkspacePins(root);
  const central = pins.central && typeof pins.central === "object" ? pins.central : null;
  const origins = trustedOrigins(environment);
  const base = { origin, pinnedOrigin: central?.origin ?? null, projectId, pinnedProjectId: central?.projectId ?? null, firstUse: !central, recorded: false };

  if (!central) {
    if (isRepositorySource(configSource)) {
      if (recordFirstUse) {
        trustCentralPins(root, { mcpUrl, projectId }, environment, { via: "repository-first-use" });
        return { ...base, trusted: true, reason: null, message: null, recorded: true };
      }
      return { ...base, trusted: true, reason: null, message: null };
    }
    if (origin && !origins[origin]) return untrusted(base, "untrusted-origin");
    return untrusted(base, "untrusted-project");
  }
  if (origin && (central.origin !== origin || !origins[origin])) return untrusted(base, "untrusted-origin");
  if (central.projectId !== projectId) return untrusted(base, "untrusted-project");
  return { ...base, trusted: true, reason: null, message: null };
}

function untrusted(base, reason) {
  const message = reason === "untrusted-origin"
    ? `The central memory URL ${base.origin} is not trusted for this workspace (trusted: ${base.pinnedOrigin || "none yet"}). A person must confirm it at a terminal: nemeda-agent memory trust`
    : `This workspace promotes to project "${base.projectId}", but it was trusted with "${base.pinnedProjectId || "none yet"}". A person must confirm it at a terminal: nemeda-agent memory trust`;
  return { ...base, trusted: false, reason, message };
}

// Records the origin for this person and the origin plus project for this
// workspace. Called on a repository's silent first use and by
// `memory trust` after a person confirmed.
export function trustCentralPins(root, { mcpUrl, projectId }, environment = process.env, { via = "memory trust", now = new Date() } = {}) {
  const origin = serviceOrigin(mcpUrl);
  const at = now.toISOString();
  if (origin) {
    const file = personalOriginsPath(environment);
    const store = readStore(file) || {};
    const origins = store.origins && typeof store.origins === "object" ? store.origins : {};
    if (!origins[origin]) origins[origin] = { trustedAt: at, via };
    writeStore(file, { version: STORE_VERSION, origins });
  }
  const pins = readWorkspacePins(root);
  writeStore(workspacePinsPath(root), { ...pins, version: STORE_VERSION, central: { origin, projectId, trustedAt: at, via } });
}

// What `memory trust` would change, for a person to read before confirming.
export function describeCentralTrust(root, { mcpUrl, projectId, configSource } = {}, environment = process.env) {
  const evaluation = evaluateCentralPins(root, { mcpUrl, projectId, configSource }, environment, { recordFirstUse: false });
  const origin = serviceOrigin(mcpUrl);
  const changes = [];
  if (origin && (evaluation.pinnedOrigin !== origin || !trustedOrigins(environment)[origin])) {
    changes.push({ kind: "origin", from: evaluation.pinnedOrigin, to: origin });
  }
  if (evaluation.pinnedProjectId !== projectId) changes.push({ kind: "project", from: evaluation.pinnedProjectId, to: projectId });
  changes.push(...folderTrustChanges(root));
  return { origin, projectId, configSource: configSource || "repository", trusted: evaluation.trusted, changes };
}

// ---------------------------------------------------------------------------
// Write destinations (guards 4 and 5). Memory must be written inside the
// configured shared drive, and a move within that drive, which can widen the
// audience of a folder, pauses unattended writers until a person confirms it.
// ---------------------------------------------------------------------------

function realpathOrNull(target) {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function insideOf(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// A folder's identity, relative to its shared drive when the workspace has
// one ("drive:google:Scharlab-Workspace:memory"), so a changed mount path (a
// renamed account folder, a re-linked OneDrive) is not mistaken for a move.
// insideDrive is false when the folder resolves outside that drive, null
// when there is no drive to compare with or it is not mounted.
export function folderIdentity(root, relativeFolder, driveConfig, environment = process.env, platform = process.platform) {
  const folder = realpathOrNull(path.join(root, relativeFolder));
  if (!folder) return { identity: null, realpath: null, insideDrive: null };
  if (driveConfig?.sharedDrive) {
    const provider = driveConfig.provider || "google";
    const located = findSharedDrive(driveConfig.sharedDrive, environment, platform, provider);
    const drive = located.drivePath ? realpathOrNull(located.drivePath) : null;
    if (!drive) return { identity: null, realpath: folder, insideDrive: null };
    if (!insideOf(drive, folder)) return { identity: `path:${folder}`, realpath: folder, insideDrive: false, sharedDrive: driveConfig.sharedDrive };
    const relative = path.relative(drive, folder).split(path.sep).join("/");
    return { identity: `drive:${provider}:${driveConfig.sharedDrive}:${relative}`, realpath: folder, insideDrive: true, sharedDrive: driveConfig.sharedDrive };
  }
  const base = realpathOrNull(root) || root;
  const identity = insideOf(base, folder) ? `local:${path.relative(base, folder).split(path.sep).join("/")}` : `path:${folder}`;
  return { identity, realpath: folder, insideDrive: null };
}

export function describeFolderIdentity(identity) {
  if (!identity) return "(not trusted yet)";
  if (identity.startsWith("drive:")) {
    const [, , drive, ...rest] = identity.split(":");
    return `${drive}/${rest.join(":")}`;
  }
  if (identity.startsWith("local:")) return `./${identity.slice("local:".length)}`;
  return identity.slice(identity.indexOf(":") + 1);
}

// How a pin kind reads in messages, and which unattended writers it pauses.
// Kinds name a role ("memory", "meetings:transcripts"), never a configured
// path: a path in the kind would turn a changed path into a new kind that
// pins silently as a first use, skipping the pause.
function folderKindWording(kind) {
  if (kind === "memory") return { label: "memory", paused: "harvest, meeting entries, the automatic sync" };
  if (kind.startsWith("meetings:")) return { label: `meetings ${kind.slice("meetings:".length)}`, paused: "the meeting watch loop" };
  return { label: kind, paused: "unattended writers" };
}

// `kind` is a role: "memory" for the memory writers, "meetings:transcripts",
// "meetings:notes", "meetings:inbox", or "meetings:archive" for the meetings
// watch loop, all in the same store. The first sighting pins silently; a
// different identity is recorded as pending for `memory trust` and pauses
// unattended writers, while interactive commands get a warning.
// `recordFirstUse: false` (doctor) writes nothing.
export function checkFolderPin(root, kind, destination, { unattended = false, recordFirstUse = true, via = "first-use", now = new Date() } = {}) {
  const wording = folderKindWording(kind);
  if (destination.insideDrive === false) {
    return {
      allowed: false,
      reason: "outside-drive",
      message: `The ${wording.label} folder resolves to ${destination.realpath}, outside the shared drive ${destination.sharedDrive}; nothing is written there. Check drive.links and the local link.`
    };
  }
  if (!destination.identity) return { allowed: true };
  const pins = readWorkspacePins(root);
  const folders = pins.folders && typeof pins.folders === "object" ? pins.folders : {};
  const pinned = folders[kind];
  if (!pinned) {
    if (recordFirstUse) {
      writeStore(workspacePinsPath(root), { ...pins, version: STORE_VERSION, folders: { ...folders, [kind]: { identity: destination.identity, trustedAt: now.toISOString(), via } } });
    }
    return { allowed: true };
  }
  if (pinned.identity === destination.identity) return { allowed: true };
  if (recordFirstUse) {
    const pending = pins.pendingFolders && typeof pins.pendingFolders === "object" ? pins.pendingFolders : {};
    writeStore(workspacePinsPath(root), { ...pins, version: STORE_VERSION, pendingFolders: { ...pending, [kind]: { identity: destination.identity, seenAt: now.toISOString() } } });
  }
  const message = `The ${wording.label} folder moved from ${describeFolderIdentity(pinned.identity)} to ${describeFolderIdentity(destination.identity)}, which may be shared with a different audience. Unattended writes (${wording.paused}) are paused until a person confirms it at a terminal: nemeda-agent memory trust`;
  return unattended ? { allowed: false, reason: "folder-moved", message } : { allowed: true, warning: message };
}

// Every memory write asks this first. Refused when the project this
// workspace was trusted with changed (guard 4) or the memory folder resolves
// outside its shared drive; unattended writers also stop when the folder
// moved within the drive (guard 5).
export function checkMemoryWrite(root, config, { unattended = false, environment = process.env, recordFirstUse = true } = {}) {
  const pins = readWorkspacePins(root);
  const expectedProject = config?.memory?.central?.projectId || config?.project?.id;
  if (pins.central && config?.memory?.central && pins.central.projectId !== expectedProject) {
    return {
      allowed: false,
      reason: "untrusted-project",
      message: `This workspace now names project "${expectedProject}", but it was trusted with "${pins.central.projectId}"; memory writes wait until a person confirms it at a terminal: nemeda-agent memory trust`
    };
  }
  if (!config?.memory?.project?.path) return { allowed: true };
  // Locate the drive with the configuration loader's own environment (the
  // given one plus the workspace .env.local, on a copy), so the identity is
  // computed against the same shared drive the configuration came from.
  const driveEnvironment = workspaceDriveEnvironment(root, environment);
  return checkFolderPin(root, "memory", folderIdentity(root, config.memory.project.path, config.drive, driveEnvironment), { unattended, recordFirstUse });
}

// The doctor's `memory-destination` row, only when something is wrong
// (a project change is reported by the central checks instead).
export function memoryDestinationChecks(root, config, environment = process.env) {
  if (!config?.memory?.project?.path) return [];
  const guard = checkMemoryWrite(root, config, { unattended: true, environment, recordFirstUse: false });
  if (guard.allowed || guard.reason === "untrusted-project") return [];
  return [{ status: guard.reason === "folder-moved" ? "warn" : "fail", code: "memory-destination", message: guard.message }];
}

function folderTrustChanges(root) {
  const pins = readWorkspacePins(root);
  const folders = pins.folders && typeof pins.folders === "object" ? pins.folders : {};
  const pending = pins.pendingFolders && typeof pins.pendingFolders === "object" ? pins.pendingFolders : {};
  return Object.entries(pending).map(([kind, next]) => ({
    kind: `${kind} folder`,
    from: describeFolderIdentity(folders[kind]?.identity),
    to: describeFolderIdentity(next.identity)
  }));
}

export function pendingFolderChanges(root) {
  return folderTrustChanges(root);
}

// Accepts every pending folder move at once, so one `memory trust` resumes
// all paused writers.
export function trustPendingFolders(root, { now = new Date() } = {}) {
  const pins = readWorkspacePins(root);
  const pending = pins.pendingFolders && typeof pins.pendingFolders === "object" ? pins.pendingFolders : {};
  if (!Object.keys(pending).length) return;
  const folders = { ...(pins.folders && typeof pins.folders === "object" ? pins.folders : {}) };
  for (const [kind, next] of Object.entries(pending)) folders[kind] = { identity: next.identity, trustedAt: now.toISOString(), via: "memory trust" };
  const { pendingFolders: _pending, ...rest } = pins;
  writeStore(workspacePinsPath(root), { ...rest, version: STORE_VERSION, folders });
}
