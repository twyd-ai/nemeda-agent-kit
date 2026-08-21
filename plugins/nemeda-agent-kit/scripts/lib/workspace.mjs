import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planDriveLinks } from "./drive.mjs";
import { ENV_LOCAL_NAME, loadEnvLocal } from "./env.mjs";

export const CONFIG_RELATIVE_PATH = path.join(".nemeda", "agent-kit.json");
export const CONFIG_SCHEMA_VERSION = 1;

const MAX_INSTRUCTION_BYTES = 64 * 1024;
// Word-boundary matching so "docs/tokenization.md" passes while
// "api-tokens.md" or ".env.local" stay blocked.
const SECRET_PATH_PATTERN = /(^|\/)\.env(\.|$)|(^|[^a-z0-9])(secrets?|credentials?|tokens?|private[-_]?keys?)(?![a-z0-9])/i;
const AIRTABLE_ID_PATTERNS = { baseId: /^app[a-zA-Z0-9]{14}$/, tableId: /^tbl[a-zA-Z0-9]{14}$/, recordId: /^rec[a-zA-Z0-9]{14}$/ };
const SLACK_ID_PATTERNS = { channel: /^[CGD][A-Z0-9]{6,}$/, user: /^[UW][A-Z0-9]{6,}$/ };
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asStartDirectory(candidate) {
  if (typeof candidate !== "string" || !candidate.trim() || candidate.includes("${")) {
    return process.cwd();
  }
  const resolved = path.resolve(candidate);
  try {
    return lstatSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return resolved;
  }
}

export function defaultWorkspaceDirectory() {
  const configured = process.env.NEMEDA_WORKSPACE_CWD;
  const claudeProject = process.env.CLAUDE_PROJECT_DIR;
  return asStartDirectory(configured || claudeProject || process.cwd());
}

function parentDirectories(start) {
  const directories = [];
  let current = asStartDirectory(start);
  for (let depth = 0; depth < 32; depth += 1) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

export function findWorkspace(start = defaultWorkspaceDirectory()) {
  for (const directory of parentDirectories(start)) {
    const configPath = path.join(directory, CONFIG_RELATIVE_PATH);
    if (existsSync(configPath)) {
      return { root: directory, configPath };
    }
  }
  return null;
}

function readJsonFile(filePath) {
  try {
    return { value: JSON.parse(readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function validateStringArray(value, field, issues) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    issues.push({ level: "error", code: "invalid-array", message: `${field} must be an array of non-empty strings.` });
  }
}

function validateContextPaths(value, field, issues) {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    if (typeof entry !== "string") return;
    const normalized = entry.replaceAll("\\", "/");
    if (path.isAbsolute(entry) || normalized.split("/").includes("..") || SECRET_PATH_PATTERN.test(normalized)) {
      issues.push({ level: "error", code: "invalid-context-path", message: `${field}[${index}] must be a non-secret path inside the workspace.` });
    }
  });
}

function validateAllowedKeys(value, allowedKeys, field, issues) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      issues.push({ level: "error", code: "unknown-field", message: `${field}.${key} is not supported.` });
    }
  }
}

function validateRepository(repository, field, issues, requirePath = false) {
  if (!isObject(repository)) {
    issues.push({ level: "error", code: "missing-repository", message: `${field} must be an object.` });
    return;
  }
  const allowedKeys = requirePath
    ? ["id", "path", "role", "profiles", "remote", "branch"]
    : ["id", "role", "profiles"];
  validateAllowedKeys(repository, allowedKeys, field, issues);
  for (const key of ["id", "role"]) {
    if (typeof repository[key] !== "string" || !repository[key].trim()) {
      issues.push({ level: "error", code: "invalid-repository", message: `${field}.${key} must be a non-empty string.` });
    }
  }
  if (requirePath && (typeof repository.path !== "string" || !repository.path.trim())) {
    issues.push({ level: "error", code: "invalid-repository", message: `${field}.path must be a non-empty string.` });
  }
  for (const key of ["remote", "branch"]) {
    if (repository[key] !== undefined && (typeof repository[key] !== "string" || !repository[key].trim())) {
      issues.push({ level: "error", code: "invalid-repository", message: `${field}.${key} must be a non-empty string when present.` });
    }
  }
  validateStringArray(repository.profiles, `${field}.profiles`, issues);
}

function isRelativeInsidePath(value) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) return false;
  return !value.replaceAll("\\", "/").split("/").includes("..");
}

function validateDrive(drive, issues) {
  if (!isObject(drive)) {
    issues.push({ level: "error", code: "invalid-drive", message: "drive must be an object." });
    return;
  }
  validateAllowedKeys(drive, ["sharedDrive", "links"], "drive", issues);
  if (typeof drive.sharedDrive !== "string" || !drive.sharedDrive.trim()) {
    issues.push({ level: "error", code: "invalid-drive", message: "drive.sharedDrive must be a non-empty string." });
  }
  if (!isObject(drive.links) || Object.keys(drive.links).length === 0) {
    issues.push({ level: "error", code: "invalid-drive", message: "drive.links must map workspace paths to shared-drive folders." });
    return;
  }
  for (const [linkPath, drivePath] of Object.entries(drive.links)) {
    if (!isRelativeInsidePath(linkPath) || typeof drivePath !== "string" || !isRelativeInsidePath(drivePath)) {
      issues.push({ level: "error", code: "invalid-drive-link", message: `drive.links["${linkPath}"] must map a relative workspace path to a relative shared-drive path.` });
    }
  }
}

function validateAirtableId(value, field, kind, issues, required = true) {
  if (value === undefined) {
    if (required) issues.push({ level: "error", code: "invalid-airtable", message: `${field} is required.` });
    return;
  }
  if (typeof value !== "string" || !AIRTABLE_ID_PATTERNS[kind].test(value)) {
    issues.push({ level: "error", code: "invalid-airtable", message: `${field} must match ${AIRTABLE_ID_PATTERNS[kind]}.` });
  }
}

function validateAirtable(airtable, issues) {
  if (!isObject(airtable)) {
    issues.push({ level: "error", code: "invalid-airtable", message: "airtable must be an object." });
    return;
  }
  validateAllowedKeys(airtable, ["baseId", "tasks", "knowledgeLog", "reconcileRepos", "lookbackDays"], "airtable", issues);
  validateAirtableId(airtable.baseId, "airtable.baseId", "baseId", issues);
  if (airtable.tasks !== undefined) {
    if (!isObject(airtable.tasks)) {
      issues.push({ level: "error", code: "invalid-airtable", message: "airtable.tasks must be an object." });
    } else {
      validateAllowedKeys(airtable.tasks, ["tableId", "statusField", "notesField", "statusInProgress", "statusDone"], "airtable.tasks", issues);
      validateAirtableId(airtable.tasks.tableId, "airtable.tasks.tableId", "tableId", issues);
      for (const key of ["statusField", "notesField", "statusInProgress", "statusDone"]) {
        if (typeof airtable.tasks[key] !== "string" || !airtable.tasks[key].trim()) {
          issues.push({ level: "error", code: "invalid-airtable", message: `airtable.tasks.${key} must be a non-empty string.` });
        }
      }
    }
  }
  if (airtable.knowledgeLog !== undefined) {
    if (!isObject(airtable.knowledgeLog)) {
      issues.push({ level: "error", code: "invalid-airtable", message: "airtable.knowledgeLog must be an object." });
    } else {
      validateAllowedKeys(airtable.knowledgeLog, ["baseId", "tableId", "people"], "airtable.knowledgeLog", issues);
      // Some teams keep the Knowledge Log in a separate (internal) base.
      validateAirtableId(airtable.knowledgeLog.baseId, "airtable.knowledgeLog.baseId", "baseId", issues, false);
      validateAirtableId(airtable.knowledgeLog.tableId, "airtable.knowledgeLog.tableId", "tableId", issues);
      if (airtable.knowledgeLog.people !== undefined) {
        if (!isObject(airtable.knowledgeLog.people)) {
          issues.push({ level: "error", code: "invalid-airtable", message: "airtable.knowledgeLog.people must map emails to Airtable record ids." });
        } else {
          for (const [email, recordId] of Object.entries(airtable.knowledgeLog.people)) {
            if (!email.includes("@") || typeof recordId !== "string" || !AIRTABLE_ID_PATTERNS.recordId.test(recordId)) {
              issues.push({ level: "error", code: "invalid-airtable", message: `airtable.knowledgeLog.people["${email}"] must map an email to a rec… id.` });
            }
          }
        }
      }
    }
  }
  if (airtable.reconcileRepos !== undefined) {
    validateStringArray(airtable.reconcileRepos, "airtable.reconcileRepos", issues);
    if (Array.isArray(airtable.reconcileRepos)) {
      airtable.reconcileRepos.forEach((repo, index) => {
        if (typeof repo === "string" && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          issues.push({ level: "error", code: "invalid-airtable", message: `airtable.reconcileRepos[${index}] must look like owner/repo.` });
        }
      });
    }
  }
  if (airtable.lookbackDays !== undefined && (!Number.isInteger(airtable.lookbackDays) || airtable.lookbackDays < 1 || airtable.lookbackDays > 365)) {
    issues.push({ level: "error", code: "invalid-airtable", message: "airtable.lookbackDays must be an integer between 1 and 365." });
  }
}

function validateSlackIds(value, field, kind, issues) {
  validateStringArray(value, field, issues);
  if (!Array.isArray(value)) return;
  value.forEach((id, index) => {
    if (typeof id === "string" && !SLACK_ID_PATTERNS[kind].test(id)) {
      issues.push({ level: "error", code: "invalid-slack", message: `${field}[${index}] does not look like a Slack ${kind} id.` });
    }
  });
}

function validateSlack(slack, issues) {
  if (!isObject(slack)) {
    issues.push({ level: "error", code: "invalid-slack", message: "slack must be an object." });
    return;
  }
  validateAllowedKeys(
    slack,
    ["channels", "owner", "guests", "backend", "model", "sourceRef", "maxQuestionsPerHour", "maxAnswerChars", "followThreads", "onUnauthorized", "timeoutSeconds"],
    "slack",
    issues
  );
  validateSlackIds(slack.channels, "slack.channels", "channel", issues);
  if (Array.isArray(slack.channels) && slack.channels.length === 0) {
    issues.push({ level: "error", code: "invalid-slack", message: "slack.channels must list at least one channel id." });
  }
  if (typeof slack.owner !== "string" || !SLACK_ID_PATTERNS.user.test(slack.owner)) {
    issues.push({ level: "error", code: "invalid-slack", message: "slack.owner must be a Slack user id such as U01ABCDEF." });
  }
  if (slack.guests !== undefined) validateSlackIds(slack.guests, "slack.guests", "user", issues);
  if (slack.backend !== undefined && !["claude", "codex"].includes(slack.backend)) {
    issues.push({ level: "error", code: "invalid-slack", message: 'slack.backend must be "claude" or "codex".' });
  }
  if (slack.onUnauthorized !== undefined && !["silent", "ephemeral"].includes(slack.onUnauthorized)) {
    issues.push({ level: "error", code: "invalid-slack", message: 'slack.onUnauthorized must be "silent" or "ephemeral".' });
  }
  if (slack.followThreads !== undefined && typeof slack.followThreads !== "boolean") {
    issues.push({ level: "error", code: "invalid-slack", message: "slack.followThreads must be a boolean." });
  }
  for (const field of ["model", "sourceRef"]) {
    if (slack[field] !== undefined && (typeof slack[field] !== "string" || !slack[field].trim())) {
      issues.push({ level: "error", code: "invalid-slack", message: `slack.${field} must be a non-empty string.` });
    }
  }
  const ranges = { maxQuestionsPerHour: [1, 500], maxAnswerChars: [200, 8000], timeoutSeconds: [30, 900] };
  for (const [field, [min, max]] of Object.entries(ranges)) {
    const value = slack[field];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
      issues.push({ level: "error", code: "invalid-slack", message: `slack.${field} must be an integer between ${min} and ${max}.` });
    }
  }
}

export function validateConfig(config) {
  const issues = [];
  if (!isObject(config)) {
    return [{ level: "error", code: "invalid-root", message: "Configuration must be a JSON object." }];
  }
  validateAllowedKeys(config, ["schemaVersion", "project", "repository", "workspace", "context", "tools", "policies", "drive", "airtable", "slack"], "configuration", issues);
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    issues.push({
      level: "error",
      code: "unsupported-schema",
      message: `schemaVersion must be ${CONFIG_SCHEMA_VERSION}.`
    });
  }
  if (!isObject(config.project)) {
    issues.push({ level: "error", code: "missing-project", message: "project must be an object." });
  } else {
    validateAllowedKeys(config.project, ["id", "name"], "project", issues);
    if (typeof config.project.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(config.project.id)) {
      issues.push({ level: "error", code: "invalid-project-id", message: "project.id must use lower-case letters, numbers, and hyphens." });
    }
    if (typeof config.project.name !== "string" || !config.project.name.trim()) {
      issues.push({ level: "error", code: "invalid-project-name", message: "project.name must be a non-empty string." });
    }
  }
  const hasRepository = config.repository !== undefined;
  const hasWorkspace = config.workspace !== undefined;
  if (hasRepository === hasWorkspace) {
    issues.push({
      level: "error",
      code: "ambiguous-scope",
      message: "Configure exactly one of repository or workspace."
    });
  }
  if (hasRepository) validateRepository(config.repository, "repository", issues);
  if (hasWorkspace) {
    if (!isObject(config.workspace) || !Array.isArray(config.workspace.repositories)) {
      issues.push({ level: "error", code: "invalid-workspace", message: "workspace.repositories must be an array." });
    } else {
      validateAllowedKeys(config.workspace, ["repositories"], "workspace", issues);
      if (config.workspace.repositories.length === 0) {
        issues.push({ level: "error", code: "empty-workspace", message: "workspace.repositories must contain at least one repository." });
      }
      config.workspace.repositories.forEach((repository, index) => {
        validateRepository(repository, `workspace.repositories[${index}]`, issues, true);
        if (typeof repository?.path === "string" && (path.isAbsolute(repository.path) || repository.path.split(/[\\/]/).includes(".."))) {
          issues.push({ level: "error", code: "invalid-repository-path", message: `workspace.repositories[${index}].path must remain inside the workspace.` });
        }
      });
      for (const key of ["id", "path"]) {
        const values = config.workspace.repositories.map((repository) => repository?.[key]).filter(Boolean);
        if (new Set(values).size !== values.length) {
          issues.push({ level: "error", code: "duplicate-repository", message: `workspace repository ${key} values must be unique.` });
        }
      }
    }
  }
  if (config.drive !== undefined) validateDrive(config.drive, issues);
  if (config.airtable !== undefined) validateAirtable(config.airtable, issues);
  if (config.slack !== undefined) validateSlack(config.slack, issues);
  if (!isObject(config.context)) {
    issues.push({ level: "error", code: "missing-context", message: "context must be an object." });
  } else {
    validateAllowedKeys(config.context, ["instructions", "documents"], "context", issues);
    validateStringArray(config.context.instructions, "context.instructions", issues);
    validateContextPaths(config.context.instructions, "context.instructions", issues);
    if (config.context.documents !== undefined) {
      validateStringArray(config.context.documents, "context.documents", issues);
      validateContextPaths(config.context.documents, "context.documents", issues);
    }
  }
  if (!isObject(config.tools)) {
    issues.push({ level: "error", code: "missing-tools", message: "tools must be an object." });
  } else {
    validateAllowedKeys(config.tools, ["required", "optional"], "tools", issues);
    validateStringArray(config.tools.required, "tools.required", issues);
    validateStringArray(config.tools.optional, "tools.optional", issues);
  }
  if (!isObject(config.policies) || typeof config.policies.protectSecrets !== "boolean") {
    issues.push({ level: "error", code: "missing-policies", message: "policies.protectSecrets must be a boolean." });
  } else {
    validateAllowedKeys(config.policies, ["protectSecrets", "conversationLanguage", "artifactLanguage"], "policies", issues);
    for (const field of ["conversationLanguage", "artifactLanguage"]) {
      if (config.policies[field] !== undefined && (typeof config.policies[field] !== "string" || !config.policies[field].trim())) {
        issues.push({ level: "error", code: "invalid-policy", message: `policies.${field} must be a non-empty string.` });
      }
    }
  }
  return issues;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readInstruction(root, relativePath) {
  if (path.isAbsolute(relativePath) || SECRET_PATH_PATTERN.test(relativePath.replaceAll(path.sep, "/"))) {
    return { path: relativePath, error: "Instruction path is absolute or looks secret-bearing." };
  }
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate)) {
    return { path: relativePath, error: "Instruction path escapes the workspace root." };
  }
  if (!existsSync(candidate)) {
    return { path: relativePath, error: "Instruction file does not exist." };
  }
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    if (!isInside(realRoot, realCandidate)) {
      return { path: relativePath, error: "Instruction symlink resolves outside the workspace root." };
    }
    const stat = lstatSync(realCandidate);
    if (!stat.isFile()) return { path: relativePath, error: "Instruction path is not a regular file." };
    if (stat.size > MAX_INSTRUCTION_BYTES) {
      return { path: relativePath, error: `Instruction file exceeds ${MAX_INSTRUCTION_BYTES} bytes.` };
    }
    return { path: relativePath, content: readFileSync(realCandidate, "utf8") };
  } catch (error) {
    return { path: relativePath, error: error instanceof Error ? error.message : String(error) };
  }
}

function findLegacyInstructions(start) {
  for (const directory of parentDirectories(start)) {
    const candidates = ["AGENTS.md", "CLAUDE.md"].filter((name) => existsSync(path.join(directory, name)));
    if (candidates.length > 0) return { root: directory, candidates };
  }
  return null;
}

export function readWorkspaceContext(start = defaultWorkspaceDirectory()) {
  const workspace = findWorkspace(start);
  if (!workspace) {
    const legacy = findLegacyInstructions(start);
    if (!legacy) {
      return { mode: "unconfigured", root: null, configPath: null, config: null, issues: [], instructions: [] };
    }
    return {
      mode: "legacy",
      root: legacy.root,
      configPath: null,
      config: null,
      issues: [{ level: "warning", code: "legacy-mode", message: "No .nemeda/agent-kit.json found." }],
      instructions: legacy.candidates.map((candidate) => readInstruction(legacy.root, candidate))
    };
  }

  const parsed = readJsonFile(workspace.configPath);
  if (parsed.error) {
    return {
      mode: "configured",
      ...workspace,
      config: null,
      issues: [{ level: "error", code: "invalid-json", message: parsed.error }],
      instructions: []
    };
  }
  const issues = validateConfig(parsed.value);
  const instructionPaths = Array.isArray(parsed.value?.context?.instructions)
    ? parsed.value.context.instructions
    : [];
  const instructions = instructionPaths.map((instructionPath) => readInstruction(workspace.root, instructionPath));
  for (const instruction of instructions) {
    if (instruction.error) {
      issues.push({ level: "error", code: "invalid-instruction", message: `${instruction.path}: ${instruction.error}` });
    }
  }
  return { mode: "configured", ...workspace, config: parsed.value, issues, instructions };
}

function runGit(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function executableAvailable(name) {
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  return pathEntries.some((entry) => {
    const candidate = path.join(entry, process.platform === "win32" ? `${name}.exe` : name);
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function compatibilityFileIsThin(root) {
  const claudePath = path.join(root, "CLAUDE.md");
  if (!existsSync(claudePath)) return true;
  const text = readFileSync(claudePath, "utf8").trim();
  return /^@AGENTS\.md\s*$/i.test(text) || text.length < 80;
}

export function workspaceDoctor(start = defaultWorkspaceDirectory()) {
  const context = readWorkspaceContext(start);
  const checks = [];
  if (context.mode === "configured") {
    checks.push({ status: "pass", code: "configuration-found", message: `Configuration found at ${context.configPath}.` });
  } else if (context.mode === "legacy") {
    checks.push({ status: "warn", code: "legacy-mode", message: "Project instructions exist, but .nemeda/agent-kit.json is missing." });
  } else {
    checks.push({ status: "fail", code: "configuration-missing", message: "No Agent Kit configuration or project instructions found." });
  }
  for (const issue of context.issues) {
    checks.push({ status: issue.level === "error" ? "fail" : "warn", code: issue.code, message: issue.message });
  }
  if (context.root) {
    const gitRoot = runGit(context.root, ["rev-parse", "--show-toplevel"]);
    checks.push(
      gitRoot
        ? { status: "pass", code: "git-repository", message: `Git repository detected at ${gitRoot}.` }
        : { status: "warn", code: "git-repository", message: "Configured root is not inside a Git repository." }
    );
    const hasAgents = existsSync(path.join(context.root, "AGENTS.md"));
    const hasClaude = existsSync(path.join(context.root, "CLAUDE.md"));
    if (hasAgents && hasClaude && !compatibilityFileIsThin(context.root)) {
      checks.push({ status: "warn", code: "instruction-drift", message: "AGENTS.md and CLAUDE.md both contain substantial instructions and may drift." });
    }
    const declaredLinks = new Set(Object.keys(context.config?.drive?.links || {}));
    for (const skillPath of [path.join(context.root, ".agents", "skills"), path.join(context.root, ".claude", "skills")]) {
      const relative = path.relative(context.root, skillPath).replaceAll(path.sep, "/");
      if (declaredLinks.has(relative)) continue; // intentional Drive link, checked below
      if (existsSync(skillPath) && lstatSync(skillPath).isSymbolicLink()) {
        checks.push({ status: "warn", code: "symlinked-skills", message: `${relative} is symlinked; prefer plugin distribution.` });
      }
    }
    if (existsSync(path.join(context.root, ".mcp.json")) && existsSync(path.join(context.root, ".codex", "config.toml"))) {
      checks.push({ status: "warn", code: "duplicated-mcp", message: "MCP configuration exists in both .mcp.json and .codex/config.toml." });
    }
  }
  for (const host of ["node", "codex", "claude"]) {
    checks.push({
      status: executableAvailable(host) ? "pass" : "warn",
      code: `host-${host}`,
      message: executableAvailable(host) ? `${host} is available.` : `${host} is not available on PATH.`
    });
  }
  const toolExecutables = { git: "git", github: "gh", node: "node" };
  for (const tool of context.config?.tools?.required || []) {
    const executable = toolExecutables[tool];
    if (executable) {
      checks.push({
        status: executableAvailable(executable) ? "pass" : "fail",
        code: `tool-${tool}`,
        message: executableAvailable(executable) ? `Required tool ${tool} is available.` : `Required tool ${tool} is missing.`
      });
    } else {
      checks.push({ status: "warn", code: `tool-${tool}`, message: `Required connector ${tool} cannot be verified from the local shell.` });
    }
  }
  if (context.root && context.config) {
    if (context.config.drive) driveDoctorChecks(context.root, context.config.drive, checks);
    if (context.config.workspace?.repositories) repositoryDoctorChecks(context.root, context.config.workspace.repositories, checks);
    if (context.config.airtable) airtableDoctorChecks(context.root, context.config.airtable, checks);
  }
  return { root: context.root, mode: context.mode, checks };
}

function gitIgnores(root, target) {
  try {
    execFileSync("git", ["check-ignore", "-q", target], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function driveDoctorChecks(root, driveConfig, checks) {
  const plan = planDriveLinks(root, driveConfig);
  if (plan.error) {
    checks.push({ status: "fail", code: "drive-mount", message: plan.error });
    return;
  }
  checks.push({ status: "pass", code: "drive-mount", message: `Shared drive "${driveConfig.sharedDrive}" found at ${plan.drivePath}.` });
  for (const link of plan.links) {
    let stat = null;
    try {
      stat = lstatSync(link.linkPath);
    } catch {
      stat = null;
    }
    if (!stat) {
      checks.push({ status: "fail", code: "drive-link", message: `${link.relativeLinkPath} is missing; run \`nemeda-agent setup\`.` });
    } else if (!stat.isSymbolicLink()) {
      checks.push({ status: "warn", code: "drive-link", message: `${link.relativeLinkPath} exists but is not a symlink to Drive.` });
    } else if (!existsSync(link.linkPath)) {
      checks.push({ status: "fail", code: "drive-link", message: `${link.relativeLinkPath} is a broken symlink; is Google Drive for desktop running and streaming?` });
    } else if (readdirSync(link.linkPath).filter((name) => !name.startsWith(".")).length === 0) {
      checks.push({ status: "warn", code: "drive-link", message: `${link.relativeLinkPath} resolves but is empty; Drive may be mounted without content yet.` });
    } else {
      checks.push({ status: "pass", code: "drive-link", message: `${link.relativeLinkPath} resolves to Drive content.` });
    }
  }
}

function repositoryDoctorChecks(root, repositories, checks) {
  for (const repository of repositories) {
    const repoPath = path.join(root, repository.path);
    if (existsSync(path.join(repoPath, ".git"))) {
      checks.push({ status: "pass", code: "workspace-repository", message: `${repository.path}/ is cloned.` });
    } else {
      checks.push({
        status: "warn",
        code: "workspace-repository",
        message: `${repository.path}/ (${repository.id}) is not cloned yet; run \`nemeda-agent setup\`${repository.remote ? "" : " or clone it by hand (no remote configured)"}.`
      });
    }
  }
}

function airtableDoctorChecks(root, airtableConfig, checks) {
  const envPath = path.join(root, ENV_LOCAL_NAME);
  if (!existsSync(envPath)) {
    checks.push({ status: "warn", code: "airtable-env", message: `${ENV_LOCAL_NAME} is missing; run \`nemeda-agent setup\` and fill AIRTABLE_API_KEY.` });
  } else {
    const scratch = {};
    loadEnvLocal(root, scratch);
    checks.push(
      scratch.AIRTABLE_API_KEY
        ? { status: "pass", code: "airtable-env", message: `${ENV_LOCAL_NAME} provides AIRTABLE_API_KEY.` }
        : { status: "warn", code: "airtable-env", message: `${ENV_LOCAL_NAME} exists but AIRTABLE_API_KEY is empty; the Airtable hooks will skip silently.` }
    );
    if (!gitIgnores(root, envPath)) {
      checks.push({ status: "fail", code: "airtable-env-ignored", message: `${ENV_LOCAL_NAME} is NOT gitignored; add it to .gitignore before committing anything.` });
    }
  }
  // Probe with a file inside the directory: trailing-slash gitignore patterns
  // only match paths git can tell are directories, which fails before the
  // state directory first exists.
  if (!gitIgnores(root, path.join(root, ".nemeda", "state", "probe"))) {
    checks.push({ status: "warn", code: "state-ignored", message: ".nemeda/state/ is not gitignored; run `nemeda-agent setup` to add it." });
  }
  if (airtableConfig.reconcileRepos?.length) {
    if (!executableAvailable("gh")) {
      checks.push({
        status: "fail",
        code: "github-cli",
        message: "gh is not installed; without it, PR status sync (open -> in progress, merged -> done) never runs, no matter how PRs are opened. Install it (https://github.com/cli/cli/releases) and run `gh auth login`."
      });
    } else {
      let ghToken = "";
      try {
        ghToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        ghToken = "";
      }
      checks.push(
        ghToken
          ? { status: "pass", code: "github-auth", message: "gh is authenticated; PR status sync can read open and merged PRs." }
          : { status: "warn", code: "github-auth", message: "gh is installed but not authenticated; run `gh auth login` so PR status sync can run." }
      );
    }
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

export function detectProfiles(root) {
  const profiles = new Set();
  const packagePath = path.join(root, "package.json");
  if (existsSync(packagePath)) {
    profiles.add("javascript");
    const parsed = readJsonFile(packagePath).value || {};
    const dependencies = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
    if (dependencies.typescript) profiles.add("typescript");
    if (dependencies.next) profiles.add("nextjs");
    if (dependencies.expo) profiles.add("expo");
    if (dependencies["react-native"]) profiles.add("react-native");
    if (dependencies["@nestjs/core"]) profiles.add("nestjs");
  }
  if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "requirements.txt"))) profiles.add("python");
  if (existsSync(path.join(root, "project.yml")) || existsSync(path.join(root, "Package.swift"))) profiles.add("swift");
  if (existsSync(path.join(root, "build.gradle")) || existsSync(path.join(root, "build.gradle.kts"))) profiles.add("android");
  return [...profiles];
}

function resolveGitRoot(start) {
  const candidate = asStartDirectory(start);
  return runGit(candidate, ["rev-parse", "--show-toplevel"]) || candidate;
}

function scanWorkspaceRepositories(root) {
  const repositories = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = path.join(root, entry.name);
    if (!existsSync(path.join(candidate, ".git"))) continue;
    repositories.push({
      id: slugify(entry.name),
      path: entry.name,
      role: "repository",
      profiles: detectProfiles(candidate)
    });
  }
  return repositories;
}

export function initializeWorkspace(start = defaultWorkspaceDirectory(), options = {}) {
  const root = options.workspace ? asStartDirectory(start) : resolveGitRoot(start);
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  const agentsPath = path.join(root, "AGENTS.md");
  if (existsSync(configPath)) throw new Error(`${CONFIG_RELATIVE_PATH} already exists; no files were changed.`);

  const inferredId = slugify(path.basename(root));
  const projectId = slugify(options.projectId || inferredId);
  const projectName = options.projectName || path.basename(root).replaceAll(/[-_]+/g, " ");
  const profiles = options.profiles?.length ? options.profiles : detectProfiles(root);
  let scope;
  if (options.workspace) {
    const repositories = scanWorkspaceRepositories(root);
    if (repositories.length === 0) {
      throw new Error("No nested Git repositories found; run init without --workspace or clone the code repositories first.");
    }
    scope = { workspace: { repositories } };
  } else {
    scope = { repository: { id: projectId, role: options.role || "repository", profiles } };
  }
  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    project: { id: projectId, name: projectName },
    ...scope,
    context: { instructions: ["AGENTS.md"], documents: [] },
    tools: { required: ["git"], optional: ["github"] },
    policies: { protectSecrets: true }
  };

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  let agentsCreated = false;
  if (!existsSync(agentsPath)) {
    const instructions = `# Project instructions\n\n- Treat \`.nemeda/agent-kit.json\` as structured project configuration.\n- Inspect repository conventions and verification commands before making changes.\n- Never commit credentials, tokens, private keys, or customer data.\n- Preserve unrelated changes and publish only when explicitly requested.\n`;
    writeFileSync(agentsPath, instructions, { encoding: "utf8", flag: "wx" });
    agentsCreated = true;
  }
  return { root, configPath, agentsPath, agentsCreated, config };
}

export function formatContextForHook(context) {
  if (context.mode !== "configured" || !context.config) return "";
  const lines = [
    "Nemeda Agent Kit repository context",
    `Root: ${context.root}`,
    `Project: ${context.config.project.name} (${context.config.project.id})`,
    `Configuration: ${context.configPath}`,
    `Required tools: ${(context.config.tools?.required || []).join(", ") || "none"}`,
    `Optional tools: ${(context.config.tools?.optional || []).join(", ") || "none"}`
  ];
  if (context.config.repository) {
    lines.push(`Repository role: ${context.config.repository.role}`);
    lines.push(`Profiles: ${context.config.repository.profiles.join(", ") || "none"}`);
  } else if (context.config.workspace) {
    lines.push(`Workspace repositories: ${context.config.workspace.repositories.map((repo) => `${repo.path} (${repo.role})`).join(", ")}`);
  }
  if (context.config.drive) {
    const links = Object.entries(context.config.drive.links || {})
      .map(([linkPath, drivePath]) => `${linkPath} -> ${context.config.drive.sharedDrive}/${drivePath}`)
      .join(", ");
    lines.push(`Shared Drive links (run \`nemeda-agent setup\` if missing): ${links}`);
  }
  if (context.config.airtable?.tasks) {
    lines.push(`Airtable tasks: base ${context.config.airtable.baseId}, table ${context.config.airtable.tasks.tableId}.`);
    lines.push("Link every PR to its task by adding a line `Airtable: recXXXXXXXXXXXXXX` to the PR body; hooks move the task to " +
      `"${context.config.airtable.tasks.statusInProgress}" on PR creation and "${context.config.airtable.tasks.statusDone}" after merge. ` +
      "Never change task status directly, and ask the user before creating new records in client-visible tables.");
  }
  if (context.issues.length > 0) {
    lines.push("Configuration issues:");
    for (const issue of context.issues) lines.push(`- ${issue.level}: ${issue.message}`);
  }
  for (const instruction of context.instructions) {
    if (instruction.content) {
      lines.push(`\n--- ${instruction.path} ---\n${instruction.content.trim()}`);
    }
  }
  return lines.join("\n");
}

export function loadSchema() {
  return JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "schemas", "agent-kit.schema.json"), "utf8"));
}
