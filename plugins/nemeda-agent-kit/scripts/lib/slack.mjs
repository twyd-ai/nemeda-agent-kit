// Slack bridge logic. Everything here is pure or filesystem-only so it can be
// unit tested; the WebSocket transport and the Slack Web API live in
// scripts/slack/runner.mjs.
//
// Design rule, same as the rest of the kit: the plugin owns behaviour, each
// repository owns its routing (the `slack` section of .nemeda/agent-kit.json),
// and the machine owns the runner registry and the Slack tokens.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatContextForHook, readWorkspaceContext } from "./workspace.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const SLACK_DEFAULTS = {
  backend: "claude",
  model: "sonnet",
  guests: [],
  maxQuestionsPerHour: 20,
  maxAnswerChars: 1500,
  followThreads: true,
  onUnauthorized: "ephemeral",
  timeoutSeconds: 240
};

// Slack renders at most this much text per message; long answers are split.
const SLACK_MESSAGE_LIMIT = 3500;

export function homeDirectory(environment = process.env) {
  return environment.NEMEDA_HOME || path.join(os.homedir(), ".nemeda");
}

export function registryPath(environment = process.env) {
  return path.join(homeDirectory(environment), "runner.json");
}

export function stateDirectory(environment = process.env) {
  return path.join(homeDirectory(environment), "state");
}

export function voicePath() {
  return path.join(PLUGIN_ROOT, "slack", "voice.md");
}

export function manifestPath() {
  return path.join(PLUGIN_ROOT, "slack", "app-manifest.json");
}

export function expandHome(candidate, environment = process.env) {
  if (candidate === "~") return os.homedir();
  if (candidate.startsWith("~/")) return path.join(os.homedir(), candidate.slice(2));
  return path.resolve(homeDirectory(environment), candidate);
}

export function readState(name, fallback, environment = process.env) {
  const file = path.join(stateDirectory(environment), name);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeState(name, value, environment = process.env) {
  const directory = stateDirectory(environment);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
}

// --- registry -------------------------------------------------------------

export function loadRegistry(environment = process.env) {
  const file = registryPath(environment);
  if (!existsSync(file)) {
    return { path: file, repos: [], owner: "", guests: [], channels: {}, error: `${file} does not exist. Run \`nemeda-agent slack init\`.` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { path: file, repos: [], owner: "", guests: [], channels: {}, error: `${file} is not valid JSON: ${error.message}` };
  }
  if (!Array.isArray(parsed?.repos)) {
    return { path: file, repos: [], owner: "", guests: [], channels: {}, error: `${file} must contain a "repos" array of repository paths.` };
  }
  return {
    path: file,
    repos: parsed.repos.map((repo) => expandHome(String(repo), environment)),
    // Machine-local defaults so a repository needs no slack section at all:
    // this is the person's own bot, so the person's own file may declare who
    // it belongs to and which channels map to which project.
    owner: typeof parsed.owner === "string" ? parsed.owner : "",
    guests: Array.isArray(parsed.guests) ? parsed.guests.map(String) : [],
    channels: isPlainObject(parsed.channels) ? parsed.channels : {},
    error: null
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function withSlackDefaults(slack) {
  return { ...SLACK_DEFAULTS, ...slack, guests: slack.guests || [] };
}

// Builds the channel -> repository index the runner answers from. A channel
// declared by two repositories is an error rather than a coin flip.
//
// The registry (the person's own ~/.nemeda/runner.json) can carry the owner,
// global guests, and a channel map, so a repository needs no slack section at
// all: listing it in the registry is enough for DMs, and one line in the
// registry's channel map is enough for a channel.
export function buildRoutes(repoPaths, registry = {}) {
  const routes = new Map();
  const issues = [];
  const projects = [];
  const registryGuests = registry.guests || [];
  for (const root of repoPaths) {
    if (!existsSync(root)) {
      issues.push({ level: "error", message: `Registry entry ${root} does not exist.` });
      continue;
    }
    const context = readWorkspaceContext(root);
    if (context.mode !== "configured" || !context.config) {
      issues.push({ level: "error", message: `${root} has no .nemeda/agent-kit.json.` });
      continue;
    }
    for (const issue of context.issues.filter((entry) => entry.level === "error")) {
      issues.push({ level: "error", message: `${root}: ${issue.message}` });
    }
    if (!context.config.slack && !registry.owner) {
      issues.push({ level: "warning", message: `${root} has no slack section and the registry declares no owner; it will not answer anything.` });
      continue;
    }
    const slack = withSlackDefaults(context.config.slack || { channels: [], owner: registry.owner });
    slack.guests = [...new Set([...slack.guests, ...registryGuests])];
    const route = {
      root: context.root,
      projectId: context.config.project.id,
      projectName: context.config.project.name,
      slack,
      context
    };
    projects.push(route);
    for (const channel of slack.channels) {
      const existing = routes.get(channel);
      if (existing) {
        issues.push({ level: "error", message: `Channel ${channel} is claimed by both ${existing.root} and ${context.root}.` });
        continue;
      }
      routes.set(channel, route);
    }
  }
  for (const [channel, projectId] of Object.entries(registry.channels || {})) {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (!project) {
      issues.push({ level: "error", message: `Registry maps ${channel} to unknown project "${projectId}".` });
      continue;
    }
    const existing = routes.get(channel);
    if (existing && existing !== project) {
      issues.push({ level: "error", message: `Channel ${channel} is claimed by both ${existing.root} and the registry map.` });
      continue;
    }
    routes.set(channel, project);
  }
  return { routes, projects, issues };
}

// Picks the project a direct message is about. Explicit beats sticky beats
// only-one: a "usa <proyecto>" or "<proyecto>: pregunta" always wins, then the
// DM's active project, then the single configured project.
export function resolveDmRoute({ text, projects, activeProjectId }) {
  const clean = stripMentions(text);
  const byToken = (token) => {
    const normalized = String(token || "").trim().toLowerCase().replace(/[.!?]+$/, "");
    return projects.find(
      (candidate) => candidate.projectId.toLowerCase() === normalized || candidate.projectName.toLowerCase() === normalized
    );
  };
  const switchMatch = clean.match(/^(?:usa|use|cambia a|switch to)\s+(.+)$/i);
  if (switchMatch) {
    const project = byToken(switchMatch[1]);
    return project ? { kind: "switch", route: project } : { kind: "unknown-project", token: switchMatch[1].trim() };
  }
  const prefixMatch = clean.match(/^([\w-]+)\s*:\s+([\s\S]+)$/);
  if (prefixMatch) {
    const project = byToken(prefixMatch[1]);
    if (project) return { kind: "ask", route: project, question: prefixMatch[2].trim() };
  }
  if (projects.length === 1) return { kind: "ask", route: projects[0], question: clean };
  const active = projects.find((candidate) => candidate.projectId === activeProjectId);
  if (active) return { kind: "ask", route: active, question: clean };
  return { kind: "choose" };
}

// --- event classification -------------------------------------------------

export function stripMentions(text) {
  return String(text || "")
    .replace(/<@[UWB][A-Z0-9]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Decides what to do with one Slack event. Returns an explicit action so the
// runner never has to re-derive intent, and so the rules are testable.
export function classifyEvent({ event, botUserId, route, knownThreads = new Set() }) {
  if (!event || typeof event !== "object") return { action: "ignore", reason: "not an event" };
  if (event.bot_id || event.user === botUserId) return { action: "ignore", reason: "own or bot message" };
  if (event.subtype) return { action: "ignore", reason: `subtype ${event.subtype}` };
  if (!event.user) return { action: "ignore", reason: "no author" };

  const threadTs = event.thread_ts || event.ts;
  const isDirectMessage = event.channel_type === "im";
  let addressed = false;
  if (event.type === "app_mention") addressed = true;
  else if (event.type === "message" && isDirectMessage) addressed = true;
  else if (event.type === "message" && event.thread_ts && knownThreads.has(`${event.channel}:${event.thread_ts}`)) {
    addressed = route?.slack?.followThreads !== false;
  }
  if (!addressed) return { action: "ignore", reason: "not addressed" };

  // DMs have no channel route; they fall back to the runner's single project
  // or, with several, to an explicit answer that the channel is ambiguous.
  if (!route) return { action: "unrouted", reason: "channel not routed", threadTs };

  const allowed = [route.slack.owner, ...route.slack.guests];
  if (!allowed.includes(event.user)) {
    return { action: "deny", reason: "not owner or guest", threadTs };
  }

  const question = stripMentions(event.text);
  if (!question) return { action: "ignore", reason: "empty question", threadTs };
  return { action: "answer", question, threadTs, isDirectMessage };
}

// A short imperative like "delete your messages" / "borra tus mensajes" asks the
// bot to delete its own messages here. Questions ("can I delete messages...?")
// and long sentences never match, so real questions still reach the backend.
export function isPurgeCommand(text) {
  const clean = String(text || "").trim();
  if (!clean || clean.length > 60 || clean.includes("?")) return false;
  return /^(?:borra|borrar|elimina|eliminar|limpia|limpiar|delete|clear|clean)\b[\s\S]*\b(?:mensajes|messages|chat|historial|history)\b/i.test(clean);
}

// --- rate limiting --------------------------------------------------------

export function rateLimit(state, key, max, now = Date.now()) {
  const windowStart = now - 60 * 60 * 1000;
  const recent = (state[key] || []).filter((stamp) => stamp > windowStart);
  if (recent.length >= max) {
    const retryAfterMinutes = Math.max(1, Math.ceil((recent[0] + 60 * 60 * 1000 - now) / 60000));
    return { allowed: false, retryAfterMinutes, state: { ...state, [key]: recent } };
  }
  return { allowed: true, state: { ...state, [key]: [...recent, now] } };
}

// --- Slack formatting -----------------------------------------------------

function convertOutsideCode(text, transform) {
  return String(text)
    .split(/(```[\s\S]*?```)/g)
    .map((part) => (part.startsWith("```") ? part : transform(part)))
    .join("");
}

// Slack uses mrkdwn, not Markdown. Models emit Markdown by habit, so the voice
// prompt asks for mrkdwn and this pass repairs whatever slips through.
export function toMrkdwn(text) {
  return convertOutsideCode(text, (part) =>
    part
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, "*$1*")
      .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
      .replace(/(^|[\s(])__([^_\n]+)__/g, "$1*$2*")
      .replace(/^[ \t]{0,3}[-*+][ \t]+/gm, "• ")
      .replace(/^[ \t]{0,3}(?:---|___|\*\*\*)[ \t]*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
  ).trim();
}

// Keeps the thread readable: one short message, and the remainder only if the
// answer genuinely needs it.
export function splitForSlack(text, maxChars = SLACK_DEFAULTS.maxAnswerChars) {
  const body = String(text || "").trim();
  if (!body) return [];
  const limit = Math.min(Math.max(maxChars, 200), SLACK_MESSAGE_LIMIT);
  if (body.length <= limit) return [body];
  const chunks = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
    const end = cut > limit * 0.4 ? cut + 1 : limit;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// --- backend invocation ---------------------------------------------------

// One deterministic session per Slack thread, so a thread is a conversation
// and follow-ups keep their context without anyone repeating themselves.
export function threadSessionId(teamId, channel, threadTs) {
  const digest = createHash("sha1").update(`nemeda-slack:${teamId}:${channel}:${threadTs}`).digest("hex");
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32)
  ].join("-");
}

export function systemPrompt(route, { channelLabel, askedBy } = {}) {
  const voice = existsSync(voicePath()) ? readFileSync(voicePath(), "utf8").trim() : "";
  const context = formatContextForHook(route.context);
  return [
    voice,
    "--- Current request ---",
    `Project: ${route.projectName} (${route.projectId}).`,
    `Repository root: ${route.root}.`,
    channelLabel ? `Slack channel: ${channelLabel}.` : "",
    askedBy ? `Asked by Slack user ${askedBy}.` : "",
    "",
    context ? `--- Repository context ---\n${context}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function mcpConfig(root) {
  return JSON.stringify({
    mcpServers: {
      "workspace-context": {
        type: "stdio",
        command: "node",
        args: [path.join(PLUGIN_ROOT, "scripts", "mcp-server.mjs")],
        env: { NEMEDA_WORKSPACE_CWD: root }
      }
    }
  });
}

// Read-only by construction: the built-in tool set is narrowed to Read/Grep/Glob
// and write-capable tools are denied explicitly, so a Slack message can never
// make the agent edit, run a command, or reach the network.
export function buildBackendCommand(route, { question, cwd, sessionId, resume, prompt }) {
  const backend = route.slack.backend;
  if (backend === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--cd",
        cwd,
        `${prompt}\n\n--- Question ---\n${question}`
      ]
    };
  }
  return {
    command: "claude",
    args: [
      "-p",
      question,
      "--output-format",
      "json",
      "--model",
      route.slack.model,
      "--tools",
      "Read,Grep,Glob",
      "--allowed-tools",
      "Read Grep Glob mcp__workspace-context",
      "--disallowed-tools",
      "Bash Write Edit NotebookEdit WebFetch WebSearch Task",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig(route.root),
      "--append-system-prompt",
      prompt,
      ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId])
    ]
  };
}

// Returns { text, error }. A failing backend usually explains itself in the
// payload (expired login, quota, model unavailable); dropping that message and
// reporting "no answer" would send people hunting for a bug that is not there.
// The runner's thread memory and claude's on-disk sessions can disagree (state
// wiped, machine swapped). Rather than trusting the memory, flip the mode once:
// "create" that hits an existing session becomes a resume, and a resume of a
// missing session becomes a create.
export function sessionRetryMode(error, resumed) {
  const message = String(error || "");
  if (!resumed && /already in use/i.test(message)) return "resume";
  if (resumed && /no conversation found|not found/i.test(message)) return "create";
  return null;
}

export function parseBackendOutput(backend, stdout) {
  const raw = String(stdout || "").trim();
  if (backend !== "claude") return { text: raw, error: raw ? null : "the backend returned nothing" };
  try {
    const payload = JSON.parse(raw);
    const text = String(payload?.result ?? payload?.text ?? "").trim();
    if (payload?.is_error) return { text: "", error: text || `backend error ${payload?.api_error_status || ""}`.trim() };
    return { text, error: text ? null : "the backend returned an empty answer" };
  } catch {
    return { text: raw, error: raw ? null : "the backend returned nothing" };
  }
}
