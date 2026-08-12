import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_RELATIVE_PATH = path.join(".nemeda", "agent-kit.json");
export const CONFIG_SCHEMA_VERSION = 1;

const MAX_INSTRUCTION_BYTES = 64 * 1024;
const SECRET_PATH_PATTERN = /(^|\/)(\.env(?:\.|$)|.*(?:secret|credential|token|private[-_]?key).*)/i;
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
  validateAllowedKeys(repository, requirePath ? ["id", "path", "role", "profiles"] : ["id", "role", "profiles"], field, issues);
  for (const key of ["id", "role"]) {
    if (typeof repository[key] !== "string" || !repository[key].trim()) {
      issues.push({ level: "error", code: "invalid-repository", message: `${field}.${key} must be a non-empty string.` });
    }
  }
  if (requirePath && (typeof repository.path !== "string" || !repository.path.trim())) {
    issues.push({ level: "error", code: "invalid-repository", message: `${field}.path must be a non-empty string.` });
  }
  validateStringArray(repository.profiles, `${field}.profiles`, issues);
}

export function validateConfig(config) {
  const issues = [];
  if (!isObject(config)) {
    return [{ level: "error", code: "invalid-root", message: "Configuration must be a JSON object." }];
  }
  validateAllowedKeys(config, ["schemaVersion", "project", "repository", "workspace", "context", "tools", "policies"], "configuration", issues);
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
    for (const skillPath of [path.join(context.root, ".agents", "skills"), path.join(context.root, ".claude", "skills")]) {
      if (existsSync(skillPath) && lstatSync(skillPath).isSymbolicLink()) {
        checks.push({ status: "warn", code: "symlinked-skills", message: `${path.relative(context.root, skillPath)} is symlinked; prefer plugin distribution.` });
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
  return { root: context.root, mode: context.mode, checks };
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

export function initializeWorkspace(start = defaultWorkspaceDirectory(), options = {}) {
  const root = resolveGitRoot(start);
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  const agentsPath = path.join(root, "AGENTS.md");
  if (existsSync(configPath)) throw new Error(`${CONFIG_RELATIVE_PATH} already exists; no files were changed.`);

  const inferredId = slugify(path.basename(root));
  const projectId = slugify(options.projectId || inferredId);
  const projectName = options.projectName || path.basename(root).replaceAll(/[-_]+/g, " ");
  const profiles = options.profiles?.length ? options.profiles : detectProfiles(root);
  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    project: { id: projectId, name: projectName },
    repository: { id: inferredId, role: options.role || "repository", profiles },
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
