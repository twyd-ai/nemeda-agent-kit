// Workspace configuration hosted on the shared drive (docs/drive-config-plan.md).
//
// A local pointer, .nemeda/agent-kit.link.json, names the shared drive and
// the path of the real agent-kit.json on it. This module resolves that
// pointer, reads and validates the drive copy, keeps a last-good copy in
// .nemeda/state/config-cache.json so a missing mount or a broken edit on the
// drive does not stop every teammate at once, and tracks which instructions
// read from the drive this machine has already shown in a session.
//
// It never writes to the drive. Validation is passed in by workspace.mjs so
// this module does not import it back.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_DRIVE_PROVIDER, DRIVE_PROVIDERS, findSharedDrive } from "./drive.mjs";
import { loadEnvLocal } from "./env.mjs";

export const CONFIG_LINK_RELATIVE_PATH = path.join(".nemeda", "agent-kit.link.json");
export const DEFAULT_DRIVE_CONFIG_PATH = "config/agent-kit.json";
export const CONFIG_CACHE_RELATIVE_PATH = path.join(".nemeda", "state", "config-cache.json");
export const INSTRUCTIONS_SEEN_RELATIVE_PATH = path.join(".nemeda", "state", "instructions-seen.json");

const POINTER_SCHEMA_VERSION = 1;
const CACHE_SCHEMA_VERSION = 1;
// Sync clients keep both sides of a conflicting edit next to the file:
// "agent-kit (1).json", "agent-kit (conflicted copy).json",
// "agent-kit-DESKTOP-ABC.json" (OneDrive appends the machine name, upper
// case). A sibling like "agent-kit-notes.json" is not a conflict copy.
const CONFLICT_HINT_PATTERNS = [/\(\d+\)|conflict/i, /^-[A-Z0-9][A-Z0-9-]{3,}$/];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRelativeInside(value) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) return false;
  return !value.replaceAll("\\", "/").split("/").includes("..");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Structural validation of the pointer. Mirrors the style of validateConfig:
// a list of { level, code, message } with no exceptions.
export function validatePointer(value) {
  const issues = [];
  const fail = (message) => issues.push({ level: "error", code: "invalid-config-link", message });
  if (!isObject(value)) {
    fail(`${CONFIG_LINK_RELATIVE_PATH} must be a JSON object.`);
    return issues;
  }
  for (const key of Object.keys(value)) {
    if (!["schemaVersion", "source"].includes(key)) fail(`${CONFIG_LINK_RELATIVE_PATH}: ${key} is not supported.`);
  }
  if (value.schemaVersion !== POINTER_SCHEMA_VERSION) fail(`${CONFIG_LINK_RELATIVE_PATH}: schemaVersion must be ${POINTER_SCHEMA_VERSION}.`);
  const source = value.source;
  if (!isObject(source)) {
    fail(`${CONFIG_LINK_RELATIVE_PATH}: source must be an object with sharedDrive (and optionally provider and path).`);
    return issues;
  }
  for (const key of Object.keys(source)) {
    if (!["provider", "sharedDrive", "path"].includes(key)) fail(`${CONFIG_LINK_RELATIVE_PATH}: source.${key} is not supported.`);
  }
  if (source.provider !== undefined && !DRIVE_PROVIDERS.includes(source.provider)) {
    fail(`${CONFIG_LINK_RELATIVE_PATH}: source.provider must be one of: ${DRIVE_PROVIDERS.join(", ")}.`);
  }
  if (typeof source.sharedDrive !== "string" || !source.sharedDrive.trim()) {
    fail(`${CONFIG_LINK_RELATIVE_PATH}: source.sharedDrive must name the shared drive that holds the configuration.`);
  }
  if (source.path !== undefined && (!isRelativeInside(source.path) || !source.path.endsWith(".json"))) {
    fail(`${CONFIG_LINK_RELATIVE_PATH}: source.path must be a .json path inside the shared drive, without "..".`);
  }
  return issues;
}

export function pointerSource(pointer) {
  return {
    provider: pointer.source.provider || DEFAULT_DRIVE_PROVIDER,
    sharedDrive: pointer.source.sharedDrive,
    path: pointer.source.path || DEFAULT_DRIVE_CONFIG_PATH
  };
}

// The environment used to locate the shared drive for a workspace: the
// caller's variables, plus the workspace .env.local for anything not already
// set (a per-project NEMEDA_DRIVE_ROOT). Returns a copy; the caller's object is
// never modified. Anything that must find the same drive as the
// configuration (memory and meetings destination pins) should use it.
export function workspaceDriveEnvironment(root, environment = process.env) {
  const merged = { ...environment };
  if (root) loadEnvLocal(root, merged);
  return merged;
}

function sameSource(a, b) {
  return Boolean(a && b) && a.provider === b.provider && a.sharedDrive === b.sharedDrive && a.path === b.path;
}

function readJson(filePath) {
  try {
    return { value: JSON.parse(readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// Files On-Demand and Drive streaming list a file before its bytes are on
// disk; reading it then blocks while the client downloads it. On macOS a
// non-empty file with no allocated blocks is that placeholder (the same test
// the doctor uses for skills). Elsewhere stat.blocks is not reliable.
export function isPlaceholderFile(filePath, platform = process.platform) {
  if (platform !== "darwin") return false;
  try {
    const stat = statSync(filePath);
    return typeof stat.blocks === "number" && stat.size > 0 && stat.blocks === 0;
  } catch {
    return false;
  }
}

export function readConfigCache(root) {
  const cachePath = path.join(root, CONFIG_CACHE_RELATIVE_PATH);
  if (!existsSync(cachePath)) return null;
  const parsed = readJson(cachePath);
  const cache = parsed.value;
  if (!isObject(cache) || cache.schemaVersion !== CACHE_SCHEMA_VERSION || !isObject(cache.config) || !isObject(cache.source)) return null;
  return cache;
}

function writeJsonAtomically(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, filePath);
}

// Saves the last good drive copy with the instructions that came from the
// drive, so a session started offline still gets them. Rewrites only when
// something changed; a read-only workspace simply keeps no cache.
export function writeConfigCache(root, { source, configPath, text, config, instructions }) {
  const driveInstructions = (instructions || [])
    .filter((instruction) => instruction.source === "drive" && typeof instruction.content === "string")
    .map((instruction) => ({ path: instruction.path, content: instruction.content, sha256: sha256(instruction.content) }));
  const digest = sha256(text);
  const previous = readConfigCache(root);
  const unchanged = previous
    && sameSource(previous.source, source)
    && previous.sha256 === digest
    && JSON.stringify((previous.instructions || []).map((item) => [item.path, item.sha256])) === JSON.stringify(driveInstructions.map((item) => [item.path, item.sha256]));
  if (unchanged) return false;
  try {
    writeJsonAtomically(path.join(root, CONFIG_CACHE_RELATIVE_PATH), {
      schemaVersion: CACHE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      source,
      configPath,
      sha256: digest,
      config,
      instructions: driveInstructions
    });
    return true;
  } catch {
    return false;
  }
}

function conflictCopies(configPath) {
  const directory = path.dirname(configPath);
  const base = path.basename(configPath, ".json");
  try {
    return readdirSync(directory)
      .filter((name) => name !== path.basename(configPath) && name.endsWith(".json") && name.startsWith(base))
      .filter((name) => {
        const suffix = name.slice(0, -".json".length).slice(base.length).trim();
        return CONFLICT_HINT_PATTERNS.some((pattern) => pattern.test(suffix));
      });
  } catch {
    return [];
  }
}

function hasErrors(issues) {
  return issues.some((issue) => issue.level === "error");
}

// Resolves the pointer and returns the configuration to use:
//   { ok: true, fromCache, config, issues, configPath, configDir, source, text, cachedInstructions }
//   { ok: false, config, issues, configPath, source }
// `validate` is workspace.mjs's validateConfig. `onPlaceholder: "cache"`
// (the SessionStart hook) prefers the cache over a read that would block.
export function loadDriveConfig({
  root,
  pointerPath,
  validate,
  environment = process.env,
  platform = process.platform,
  onPlaceholder = "read",
  isPlaceholder = isPlaceholderFile
}) {
  const pointerJson = readJson(pointerPath);
  if (pointerJson.error) {
    return { ok: false, config: null, configPath: null, source: null, issues: [{ level: "error", code: "invalid-config-link", message: `${CONFIG_LINK_RELATIVE_PATH}: ${pointerJson.error}` }] };
  }
  const pointerIssues = validatePointer(pointerJson.value);
  if (hasErrors(pointerIssues)) return { ok: false, config: null, configPath: null, source: null, issues: pointerIssues };

  const source = pointerSource(pointerJson.value);
  const cache = readConfigCache(root);
  const usableCache = cache && sameSource(cache.source, source) ? cache : null;

  // A per-project NEMEDA_DRIVE_ROOT in the workspace .env.local must work, but
  // must not leak into the caller's environment.
  const env = workspaceDriveEnvironment(root, environment);

  const fallback = (cause) => {
    if (!usableCache) {
      return { ok: false, config: cause.config ?? null, configPath: cause.configPath ?? null, source, issues: cause.issues };
    }
    const issues = [];
    if (cause.code === "config-mismatch") issues.push(...cause.issues);
    issues.push({
      level: "warning",
      code: "config-cache",
      message: `Using the copy of the shared-drive configuration cached at ${usableCache.savedAt}, because ${cause.reason}.`
    });
    issues.push(...validate(usableCache.config));
    return {
      ok: true,
      fromCache: true,
      config: usableCache.config,
      configPath: usableCache.configPath,
      configDir: usableCache.configPath ? path.dirname(usableCache.configPath) : null,
      source,
      issues,
      cachedInstructions: usableCache.instructions || []
    };
  };

  const located = findSharedDrive(source.sharedDrive, env, platform, source.provider);
  if (located.error) {
    return fallback({
      code: "config-drive",
      reason: `the shared drive is not available (${located.error})`,
      issues: [{ level: "error", code: "config-drive", message: `The workspace configuration lives on shared drive "${source.sharedDrive}", which is not available: ${located.error}` }]
    });
  }
  const configPath = path.join(located.drivePath, source.path);
  if (!existsSync(configPath)) {
    return fallback({
      code: "config-drive",
      reason: `${source.path} does not exist on shared drive "${source.sharedDrive}"`,
      configPath,
      issues: [{ level: "error", code: "config-drive", message: `${source.path} does not exist on shared drive "${source.sharedDrive}" (${located.drivePath}).` }]
    });
  }
  try {
    if (!isInside(realpathSync(located.drivePath), realpathSync(configPath))) {
      return fallback({
        code: "config-drive",
        reason: `${source.path} resolves outside the shared drive`,
        configPath,
        issues: [{ level: "error", code: "config-drive", message: `${source.path} resolves outside shared drive "${source.sharedDrive}"; refusing to read it.` }]
      });
    }
  } catch (error) {
    return fallback({
      code: "config-drive",
      reason: `${source.path} could not be resolved`,
      configPath,
      issues: [{ level: "error", code: "config-drive", message: `${source.path} on shared drive "${source.sharedDrive}" could not be resolved: ${error instanceof Error ? error.message : String(error)}` }]
    });
  }
  if (onPlaceholder === "cache" && usableCache && isPlaceholder(configPath, platform)) {
    return fallback({ code: "config-drive", reason: "the drive copy is not downloaded yet", configPath, issues: [] });
  }

  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallback({
      code: "config-drive",
      reason: `the drive copy could not be read (${message})`,
      configPath,
      issues: [{ level: "error", code: "config-drive", message: `${source.path} on shared drive "${source.sharedDrive}" could not be read: ${message}` }]
    });
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallback({
      code: "config-drive",
      reason: `the drive copy is not valid JSON (${message})`,
      configPath,
      issues: [{ level: "error", code: "invalid-json", message: `${configPath}: ${message}` }]
    });
  }

  const issues = validate(config);
  if (hasErrors(issues)) {
    const first = issues.find((issue) => issue.level === "error");
    // Without a cache this mirrors a local invalid file: the configuration
    // is returned with its errors so doctor can explain them.
    return fallback({ code: "config-drive", reason: `the drive copy is invalid (${first.message})`, configPath, config, issues });
  }

  const configuredProvider = config.drive?.provider || DEFAULT_DRIVE_PROVIDER;
  if (!config.drive || configuredProvider !== source.provider || config.drive.sharedDrive !== source.sharedDrive) {
    const named = config.drive ? `${configuredProvider} "${config.drive.sharedDrive}"` : "no shared drive";
    return fallback({
      code: "config-mismatch",
      reason: "the drive copy names a different shared drive",
      configPath,
      issues: [{
        level: "error",
        code: "config-mismatch",
        message: `The configuration on ${source.provider} "${source.sharedDrive}" declares ${named} in its drive section. A configuration must name the drive that holds it; this one may have been copied from another project.`
      }]
    });
  }

  const conflicts = conflictCopies(configPath);
  if (conflicts.length > 0) {
    issues.push({
      level: "warning",
      code: "config-conflict",
      message: `Sync-client conflict copies next to the shared-drive configuration: ${conflicts.join(", ")}. Merge any change they hold into ${path.basename(configPath)} and delete them.`
    });
  }
  return { ok: true, fromCache: false, config, configPath, configDir: path.dirname(configPath), source, text, issues, cachedInstructions: [] };
}

function readSeen(root) {
  const seenPath = path.join(root, INSTRUCTIONS_SEEN_RELATIVE_PATH);
  if (!existsSync(seenPath)) return null;
  const parsed = readJson(seenPath);
  return isObject(parsed.value) && isObject(parsed.value.instructions) ? parsed.value.instructions : null;
}

// Instructions from the drive whose content differs from what the last
// session on this machine showed. Nothing counts as changed before the first
// recorded session.
export function changedDriveInstructions(root, instructions) {
  const seen = readSeen(root);
  if (!seen) return [];
  return (instructions || [])
    .filter((instruction) => instruction.source === "drive" && typeof instruction.content === "string")
    .filter((instruction) => seen[instruction.path] !== undefined && seen[instruction.path] !== sha256(instruction.content))
    .map((instruction) => instruction.path);
}

// Called by the SessionStart hook after it has injected the instructions.
export function recordSeenInstructions(root, instructions) {
  const driveInstructions = (instructions || []).filter((instruction) => instruction.source === "drive" && typeof instruction.content === "string");
  if (!root || driveInstructions.length === 0) return false;
  const current = Object.fromEntries(driveInstructions.map((instruction) => [instruction.path, sha256(instruction.content)]));
  const seen = readSeen(root);
  if (seen && JSON.stringify(seen) === JSON.stringify(current)) return false;
  try {
    writeJsonAtomically(path.join(root, INSTRUCTIONS_SEEN_RELATIVE_PATH), { recordedAt: new Date().toISOString(), instructions: current });
    return true;
  } catch {
    return false;
  }
}
