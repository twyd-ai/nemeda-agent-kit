// Phase 3 of docs/drive-config-plan.md: putting a workspace on a
// configuration that lives on the shared drive.
//
//   init --from-drive "<shared drive>"  a teammate's folder gets the pointer
//                                       after they have read what the drive
//                                       copy declares.
//   config publish                      an existing local agent-kit.json (and
//                                       its AGENTS.md) moves to the drive, and
//                                       the local file becomes a pointer only
//                                       once the drive copy reads back
//                                       identical.
//
// Nothing here trusts the central memory service. The CLI offers that step
// after `init --from-drive` and `config publish` only at an interactive
// terminal, through the same gate as `nemeda-agent memory trust`
// (lib/memory-trust.mjs). Publishing never touches .nemeda/state/ or the
// .nemeda/memory link, so sync state and pins stay where they are.

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_LINK_RELATIVE_PATH,
  DEFAULT_DRIVE_CONFIG_PATH,
  loadDriveConfig,
  pointerSource,
  validatePointer,
  workspaceDriveEnvironment
} from "./config-source.mjs";
import { DEFAULT_DRIVE_PROVIDER, findSharedDrive } from "./drive.mjs";
import { evaluateCentralPins } from "./memory-pins.mjs";
import { CONFIG_RELATIVE_PATH, readWorkspaceContext, validateConfig } from "./workspace.mjs";

export const LOCAL_BACKUP_RELATIVE_PATH = path.join(".nemeda", "state", "agent-kit.local-backup.json");

function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Order-independent comparison of two JSON values.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sameJson(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function errorsOf(issues) {
  return issues.filter((issue) => issue.level === "error").map((issue) => issue.message);
}

function buildPointer({ sharedDrive, provider, drivePath }) {
  const source = { provider: provider || DEFAULT_DRIVE_PROVIDER, sharedDrive };
  if (drivePath && drivePath !== DEFAULT_DRIVE_CONFIG_PATH) source.path = drivePath;
  return { schemaVersion: 1, source };
}

// When the workspace folder is inside a Git repository (a client repository
// that must not change), the pointer and local state stay out of it through
// .git/info/exclude, which is never committed. Returns what to add, or null.
function gitExcludePlan(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const ignored = git(root, ["check-ignore", "-q", CONFIG_LINK_RELATIVE_PATH]) !== null;
  if (ignored) return null;
  const excludePath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (!excludePath) return null;
  // Git reports the real path (/private/var on macOS for /var).
  const relative = path.relative(realpathSync(top), path.join(realpathSync(root), ".nemeda")).split(path.sep).join("/");
  return { file: excludePath, pattern: `/${relative}/` };
}

function applyGitExclude(plan, actions) {
  if (!plan) return;
  const existing = existsSync(plan.file) ? readFileSync(plan.file, "utf8") : "";
  if (existing.split("\n").some((line) => line.trim() === plan.pattern)) return;
  mkdirSync(path.dirname(plan.file), { recursive: true });
  appendFileSync(plan.file, `${existing && !existing.endsWith("\n") ? "\n" : ""}# nemeda-agent-kit: local pointer and state\n${plan.pattern}\n`);
  actions.push({ kind: "git-exclude", status: "created", message: `Added ${plan.pattern} to ${plan.file} (local only, never committed).` });
}

// `root` and `environment`, when given, add whether this workspace would
// still trust the service once its configuration comes from the drive: only
// when it already pinned the same origin and project (a drive-hosted
// configuration never pins silently). Read-only.
function centralSummary(config, root = null, environment = process.env) {
  const url = config?.memory?.central?.mcpUrl;
  if (!url) return null;
  let origin = null;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }
  const projectId = config.memory.central.projectId || config.project?.id;
  const summary = { url, origin, projectId };
  if (root) {
    summary.trustedFromDrive = evaluateCentralPins(root, { mcpUrl: url, projectId, configSource: "drive" }, environment, { recordFirstUse: false }).trusted;
  }
  return summary;
}

function sectionsOf(config) {
  return ["drive", "meetings", "memory", "airtable", "slack"].filter((key) => config?.[key] !== undefined);
}

// ---------------------------------------------------------------------------
// init --from-drive
// ---------------------------------------------------------------------------

export function planInitFromDrive(start, { sharedDrive, provider, drivePath, environment = process.env, platform = process.platform } = {}) {
  const root = path.resolve(start);
  if (existsSync(path.join(root, CONFIG_RELATIVE_PATH))) {
    throw new Error(`${CONFIG_RELATIVE_PATH} already exists here; use \`nemeda-agent config publish\` to move it to the shared drive. No files were changed.`);
  }
  if (existsSync(path.join(root, CONFIG_LINK_RELATIVE_PATH))) {
    throw new Error(`${CONFIG_LINK_RELATIVE_PATH} already exists here; no files were changed.`);
  }
  const pointer = buildPointer({ sharedDrive, provider, drivePath });
  const pointerErrors = errorsOf(validatePointer(pointer));
  if (pointerErrors.length) throw new Error(pointerErrors.join(" "));

  const loaded = loadDriveConfig({ root, pointer, validate: validateConfig, environment, platform, allowCache: false });
  if (!loaded.ok || errorsOf(loaded.issues).length) {
    const reasons = errorsOf(loaded.issues);
    throw new Error(`The configuration on shared drive "${sharedDrive}" cannot be used: ${reasons.join(" ") || "unknown error"} No files were changed.`);
  }
  const instructions = (loaded.config.context?.instructions || []).map((relative) => ({
    path: relative,
    from: existsSync(path.join(loaded.configDir, relative)) ? "drive" : existsSync(path.join(root, relative)) ? "local" : "missing"
  }));
  return {
    root,
    pointerPath: path.join(root, CONFIG_LINK_RELATIVE_PATH),
    pointer,
    source: pointerSource(pointer),
    configPath: loaded.configPath,
    project: { id: loaded.config.project.id, name: loaded.config.project.name },
    sections: sectionsOf(loaded.config),
    instructions,
    central: centralSummary(loaded.config),
    warnings: loaded.issues.filter((issue) => issue.level !== "error").map((issue) => issue.message),
    gitExclude: gitExcludePlan(root)
  };
}

export function applyInitFromDrive(plan) {
  const actions = [];
  mkdirSync(path.dirname(plan.pointerPath), { recursive: true });
  writeFileSync(plan.pointerPath, `${JSON.stringify(plan.pointer, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  actions.push({ kind: "pointer", status: "created", message: `${CONFIG_LINK_RELATIVE_PATH} -> ${plan.source.sharedDrive}/${plan.source.path}` });
  applyGitExclude(plan.gitExclude, actions);
  return { root: plan.root, actions, nextSteps: nextStepsAfterInit(plan) };
}

function nextStepsAfterInit(plan) {
  const steps = ["nemeda-agent setup    # links to the shared drive, repository clones, .env.local", "nemeda-agent doctor"];
  if (plan.central) {
    steps.push(`nemeda-agent memory trust    # at a terminal, yourself: lets the kit send your token to ${plan.central.origin} for project ${plan.central.projectId}`);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// config publish
// ---------------------------------------------------------------------------

export function planPublish(start, { drivePath, environment = process.env, platform = process.platform } = {}) {
  const context = readWorkspaceContext(start, { environment, platform });
  if (context.mode !== "configured") {
    throw new Error(`No ${CONFIG_RELATIVE_PATH} found; \`config publish\` moves an existing local configuration to the shared drive.`);
  }
  if (context.configSource !== "repository") {
    throw new Error("This workspace already takes its configuration from the shared drive; nothing to publish.");
  }
  if (context.pointerPath) {
    throw new Error(`${CONFIG_RELATIVE_PATH} and ${CONFIG_LINK_RELATIVE_PATH} are both present; delete the pointer before publishing. No files were changed.`);
  }
  if (!context.config) throw new Error(`${CONFIG_RELATIVE_PATH} could not be read; run \`nemeda-agent doctor\` and fix it first.`);
  const configErrors = errorsOf(context.issues.filter((issue) => issue.code !== "invalid-instruction"));
  if (configErrors.length) throw new Error(`The local configuration has errors; fix them before publishing: ${configErrors.join(" ")}`);
  const drive = context.config.drive;
  if (!drive?.sharedDrive) {
    throw new Error("The configuration has no drive section; add drive.provider and drive.sharedDrive (the drive that will hold it) before publishing.");
  }

  const root = context.root;
  const localConfigPath = path.join(root, CONFIG_RELATIVE_PATH);
  if (git(root, ["ls-files", "--error-unmatch", CONFIG_RELATIVE_PATH]) !== null) {
    throw new Error(`${CONFIG_RELATIVE_PATH} is tracked by Git in this repository. Publishing would delete a committed file; keep the repository-hosted configuration, or remove it from Git yourself first.`);
  }
  const pointer = buildPointer({ sharedDrive: drive.sharedDrive, provider: drive.provider, drivePath });
  const pointerErrors = errorsOf(validatePointer(pointer));
  if (pointerErrors.length) throw new Error(pointerErrors.join(" "));
  const source = pointerSource(pointer);

  const located = findSharedDrive(source.sharedDrive, workspaceDriveEnvironment(root, environment), platform, source.provider);
  if (located.error) throw new Error(`Shared drive "${source.sharedDrive}" is not available: ${located.error}`);
  const target = path.join(located.drivePath, source.path);
  const targetDir = path.dirname(target);
  const localText = readFileSync(localConfigPath, "utf8");

  let copyConfig = true;
  if (existsSync(target)) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      existing = undefined;
    }
    if (!sameJson(existing, context.config)) {
      throw new Error(`A different configuration already exists at ${target}. Compare the two and merge by hand; nothing was changed.`);
    }
    copyConfig = false;
  }

  const instructions = [];
  for (const relative of context.config.context?.instructions || []) {
    const local = path.join(root, relative);
    const onDrive = path.join(targetDir, relative);
    const localExists = existsSync(local);
    const driveExists = existsSync(onDrive);
    if (localExists && driveExists) {
      if (readFileSync(local, "utf8") !== readFileSync(onDrive, "utf8")) {
        throw new Error(`${relative} differs between this folder and ${onDrive}. Keep one version and try again; nothing was changed.`);
      }
      instructions.push({ path: relative, action: "kept", from: local, to: onDrive });
    } else if (localExists) {
      instructions.push({ path: relative, action: "copy", from: local, to: onDrive });
    } else {
      instructions.push({ path: relative, action: driveExists ? "kept" : "missing", from: null, to: onDrive });
    }
  }

  return {
    root,
    localConfigPath,
    localText,
    config: context.config,
    pointerPath: path.join(root, CONFIG_LINK_RELATIVE_PATH),
    pointer,
    source,
    target,
    copyConfig,
    instructions,
    backupPath: path.join(root, LOCAL_BACKUP_RELATIVE_PATH),
    central: centralSummary(context.config, root, environment),
    gitExclude: gitExcludePlan(root)
  };
}

export function applyPublish(plan, { environment = process.env, platform = process.platform } = {}) {
  const actions = [];
  mkdirSync(path.dirname(plan.target), { recursive: true });
  if (plan.copyConfig) {
    writeFileSync(plan.target, plan.localText, { encoding: "utf8", flag: "wx" });
    actions.push({ kind: "drive", status: "created", message: `Copied ${CONFIG_RELATIVE_PATH} to ${plan.target}.` });
  } else {
    actions.push({ kind: "drive", status: "kept", message: `${plan.target} already holds the same configuration.` });
  }
  for (const instruction of plan.instructions.filter((entry) => entry.action === "copy")) {
    mkdirSync(path.dirname(instruction.to), { recursive: true });
    writeFileSync(instruction.to, readFileSync(instruction.from, "utf8"), { encoding: "utf8", flag: "wx" });
    actions.push({ kind: "instructions", status: "created", message: `Copied ${instruction.path} to ${instruction.to}.` });
  }

  let readBack;
  try {
    readBack = JSON.parse(readFileSync(plan.target, "utf8"));
  } catch {
    readBack = undefined;
  }
  if (!sameJson(readBack, plan.config)) {
    throw new Error(`The copy at ${plan.target} does not read back identical; the local configuration was left in place.`);
  }

  // Swap the local file for the pointer, keeping a backup, and undo the swap
  // unless the workspace now reads the same configuration from the drive.
  mkdirSync(path.dirname(plan.backupPath), { recursive: true });
  copyFileSync(plan.localConfigPath, plan.backupPath);
  writeFileSync(plan.pointerPath, `${JSON.stringify(plan.pointer, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  rmSync(plan.localConfigPath);
  const context = readWorkspaceContext(plan.root, { environment, platform });
  if (context.configSource !== "drive" || !sameJson(context.config, plan.config)) {
    copyFileSync(plan.backupPath, plan.localConfigPath);
    rmSync(plan.pointerPath, { force: true });
    const reasons = errorsOf(context.issues || []);
    throw new Error(`The workspace did not read the published configuration back from the drive${reasons.length ? ` (${reasons.join(" ")})` : ""}; the local configuration was restored.`);
  }
  actions.push({ kind: "pointer", status: "created", message: `Replaced ${CONFIG_RELATIVE_PATH} with ${CONFIG_LINK_RELATIVE_PATH}; the previous file is kept at ${plan.backupPath}.` });
  applyGitExclude(plan.gitExclude, actions);

  const nextSteps = [
    `Teammates, in their own folder for this project: nemeda-agent init --from-drive "${plan.source.sharedDrive}"${plan.source.provider !== DEFAULT_DRIVE_PROVIDER ? ` --provider ${plan.source.provider}` : ""}${plan.pointer.source.path ? ` --path ${plan.pointer.source.path}` : ""}`,
    "From now on, edit the configuration on the shared drive; every teammate picks it up at their next command or session."
  ];
  if (plan.central && !plan.central.trustedFromDrive) {
    nextSteps.push(`nemeda-agent memory trust    # at a terminal, yourself: this workspace had not pinned ${plan.central.origin} for project ${plan.central.projectId}, so nothing is sent until you confirm`);
  }
  const localInstructions = plan.instructions.filter((entry) => entry.from);
  if (localInstructions.length) {
    nextSteps.push(`The local ${localInstructions.map((entry) => entry.path).join(", ")} stay in place but the drive copies are read first; delete the local copies when you no longer need them.`);
  }
  return { root: plan.root, actions, nextSteps };
}
