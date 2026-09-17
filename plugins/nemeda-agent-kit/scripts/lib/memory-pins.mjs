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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  return { origin, projectId, configSource: configSource || "repository", trusted: evaluation.trusted, changes };
}
