// `nemeda-agent setup` — assembles the machine-local parts of a configured
// workspace: Drive symlinks, declared code repositories, the .env.local
// template, and the .gitignore entries that keep all of it out of git.
// Create-if-absent only: existing files and links are reported, never touched.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planDriveLinks } from "./drive.mjs";
import { ENV_LOCAL_NAME } from "./env.mjs";
import { readWorkspaceContext, validateConfig } from "./workspace.mjs";

const GITIGNORE_MARKER = "# nemeda-agent-kit: machine-local paths (managed by `nemeda-agent setup`)";

const ENV_LOCAL_TEMPLATE = `# Personal secrets - do NOT commit to git and do NOT upload to Drive.
AIRTABLE_API_KEY=

# Optional switches for the Airtable automations:
# PR_AIRTABLE_SYNC_DISABLED=true
# PR_AIRTABLE_SYNC_DRYRUN=true
# KNOWLEDGE_LOG_AUTO=true
`;

function action(kind, status, message) {
  return { kind, status, message };
}

// Conventions travel with the folders: every provisioned Drive folder gets a
// short README saying what belongs in it, so the structure explains itself to
// every teammate and every AI, on every machine, and does not degrade into
// loose files at the root.
const DRIVE_FOLDER_READMES = {
  docs: "# docs\n\nProject documentation, shared by the whole team.\n\nFile things in the matching subfolder (meeting notes in `meets/`, transcripts in `transcriptions/`, analysis in `analisis/`). Create a new subfolder rather than leaving files loose in this root.\n",
  config: "# config\n\nShared, non-secret configuration: environment templates, service settings, VPN profiles.\n\nSecrets never go here — they live in each person's local `.env` files.\n",
  skills: "# skills\n\nShared agent skills for this project. Every teammate's AI loads these through the workspace symlinks, so a skill improved here improves for everyone.\n",
  commands: "# commands\n\nShared slash commands for this project, loaded by every teammate's AI through the workspace symlinks.\n"
};

function provisionDriveFolder(target, relativePath, actions, dryRun, kind) {
  if (existsSync(target)) {
    actions.push(action(kind, "kept", `${relativePath}/ already exists on the shared drive.`));
    return;
  }
  if (dryRun) {
    actions.push(action(kind, "planned", `create ${relativePath}/ on the shared drive`));
    return;
  }
  mkdirSync(target, { recursive: true });
  const readme = DRIVE_FOLDER_READMES[path.basename(relativePath)];
  if (readme && !existsSync(path.join(target, "README.md"))) {
    writeFileSync(path.join(target, "README.md"), readme);
  }
  actions.push(action(kind, "created", `${relativePath}/ created on the shared drive.`));
}

function createLink(target, linkPath) {
  // Windows needs no privileges for directory junctions, unlike symlinks,
  // and Node falls back transparently on other platforms.
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : null);
}

function setupDriveLinks(root, driveConfig, actions, dryRun, environment) {
  const plan = planDriveLinks(root, driveConfig, environment);
  if (plan.error) {
    actions.push(action("drive", "error", plan.error));
    return;
  }
  actions.push(action("drive", "ok", `Shared drive found at ${plan.drivePath}.`));
  for (const link of plan.links) {
    // The drive-side folder is provisioned, not required: a brand-new shared
    // drive starts empty and setup builds the canonical structure in it.
    provisionDriveFolder(link.target, path.relative(plan.drivePath, link.target), actions, dryRun, "drive-folder");
    let linkStat = null;
    try {
      linkStat = lstatSync(link.linkPath);
    } catch {
      linkStat = null;
    }
    if (linkStat?.isSymbolicLink()) {
      actions.push(action("link", "kept", `${link.relativeLinkPath} already links to ${readlinkSafe(link.linkPath)}.`));
    } else if (linkStat) {
      actions.push(action("link", "conflict", `${link.relativeLinkPath} exists and is not a symlink; resolve it by hand (move its content to Drive?).`));
    } else if (dryRun) {
      actions.push(action("link", "planned", `${link.relativeLinkPath} -> ${link.target}`));
    } else if (!existsSync(link.target)) {
      actions.push(action("link", "error", `${link.relativeLinkPath}: shared-drive folder is missing: ${link.target}.`));
    } else {
      mkdirSync(path.dirname(link.linkPath), { recursive: true });
      createLink(link.target, link.linkPath);
      actions.push(action("link", "created", `${link.relativeLinkPath} -> ${link.target}`));
    }
  }
  for (const folder of plan.scaffold) {
    provisionDriveFolder(folder.target, folder.relativePath, actions, dryRun, "scaffold");
  }
}

function readlinkSafe(linkPath) {
  try {
    return readlinkSync(linkPath);
  } catch {
    return "?";
  }
}

function remoteReachable(remote) {
  try {
    execFileSync("git", ["ls-remote", remote], { stdio: ["ignore", "ignore", "ignore"], timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function setupRepositories(root, repositories, actions, dryRun) {
  for (const repository of repositories) {
    const target = path.join(root, repository.path);
    if (existsSync(path.join(target, ".git"))) {
      actions.push(action("repository", "kept", `${repository.path}/ is already a git repository.`));
      continue;
    }
    if (existsSync(target)) {
      actions.push(action("repository", "conflict", `${repository.path}/ exists but is not a git repository; resolve it by hand.`));
      continue;
    }
    if (!repository.remote) {
      actions.push(action("repository", "skipped", `${repository.path}/ has no remote configured; clone it by hand or add "remote" to the config.`));
      continue;
    }
    if (dryRun) {
      actions.push(action("repository", "planned", `clone ${repository.remote}${repository.branch ? ` (branch ${repository.branch})` : ""} into ${repository.path}/`));
      continue;
    }
    if (!remoteReachable(repository.remote)) {
      actions.push(action("repository", "error", `No access to ${repository.remote}; authenticate first (e.g. \`gh auth login\`) and re-run setup.`));
      continue;
    }
    try {
      const cloneArgs = ["clone", ...(repository.branch ? ["--branch", repository.branch] : []), repository.remote, target];
      execFileSync("git", cloneArgs, { stdio: ["ignore", "ignore", "pipe"] });
      actions.push(action("repository", "created", `Cloned ${repository.remote} into ${repository.path}/.`));
    } catch (error) {
      actions.push(action("repository", "error", `Clone of ${repository.remote} failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

function setupEnvLocal(root, actions, dryRun) {
  const envPath = path.join(root, ENV_LOCAL_NAME);
  if (!existsSync(envPath)) {
    if (dryRun) {
      actions.push(action("env", "planned", `create ${ENV_LOCAL_NAME} template`));
    } else {
      writeFileSync(envPath, ENV_LOCAL_TEMPLATE, { flag: "wx" });
      actions.push(action("env", "created", `${ENV_LOCAL_NAME} created; fill AIRTABLE_API_KEY.`));
    }
    return;
  }
  const content = readFileSync(envPath, "utf8");
  if (/^AIRTABLE_API_KEY=/m.test(content)) {
    actions.push(action("env", "kept", `${ENV_LOCAL_NAME} already has AIRTABLE_API_KEY.`));
  } else if (dryRun) {
    actions.push(action("env", "planned", `append AIRTABLE_API_KEY= to ${ENV_LOCAL_NAME}`));
  } else {
    appendFileSync(envPath, "\nAIRTABLE_API_KEY=\n");
    actions.push(action("env", "created", `Added AIRTABLE_API_KEY= to ${ENV_LOCAL_NAME}; fill the value.`));
  }
}

export function requiredGitignoreEntries(config) {
  const entries = new Set([".nemeda/state/"]);
  if (config.airtable) entries.add(ENV_LOCAL_NAME);
  for (const linkPath of Object.keys(config.drive?.links || {})) entries.add(linkPath);
  for (const repository of config.workspace?.repositories || []) entries.add(`${repository.path}/`);
  return [...entries];
}

function setupGitignore(root, config, actions, dryRun) {
  const gitignorePath = path.join(root, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const existingLines = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = requiredGitignoreEntries(config).filter((entry) => !existingLines.has(entry) && !existingLines.has(entry.replace(/\/$/, "")));
  if (missing.length === 0) {
    actions.push(action("gitignore", "kept", ".gitignore already covers the machine-local paths."));
    return;
  }
  if (dryRun) {
    actions.push(action("gitignore", "planned", `append to .gitignore: ${missing.join(", ")}`));
    return;
  }
  const block = `${existing && !existing.endsWith("\n") ? "\n" : ""}${existing.includes(GITIGNORE_MARKER) ? "" : `\n${GITIGNORE_MARKER}\n`}${missing.join("\n")}\n`;
  appendFileSync(gitignorePath, block);
  actions.push(action("gitignore", "created", `Added to .gitignore: ${missing.join(", ")}.`));
}

export function setupWorkspace(start, options = {}) {
  const environment = options.environment || process.env;
  const dryRun = Boolean(options.dryRun);
  const context = readWorkspaceContext(start);
  if (context.mode !== "configured") {
    throw new Error("No .nemeda/agent-kit.json found; run `nemeda-agent init` first.");
  }
  if (validateConfig(context.config).some((issue) => issue.level === "error")) {
    throw new Error("Configuration is invalid; run `nemeda-agent doctor` and fix it before setup.");
  }

  const actions = [];
  const config = context.config;
  if (config.drive) setupDriveLinks(context.root, config.drive, actions, dryRun, environment);
  if (config.workspace?.repositories?.length) setupRepositories(context.root, config.workspace.repositories, actions, dryRun);
  if (config.airtable) setupEnvLocal(context.root, actions, dryRun);
  setupGitignore(context.root, config, actions, dryRun);

  const nextSteps = [];
  if (config.airtable) {
    nextSteps.push("Fill AIRTABLE_API_KEY in .env.local (Airtable > Developer hub > Personal access tokens; scopes data.records:read + data.records:write).");
    nextSteps.push("Restart the agent session so hooks pick up the new configuration.");
  }
  if (actions.some((entry) => entry.status === "error" || entry.status === "conflict")) {
    nextSteps.push("Resolve the reported conflicts/errors and re-run `nemeda-agent setup` (it is idempotent).");
  }
  return { root: context.root, dryRun, actions, nextSteps };
}
