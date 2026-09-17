// Client side of the central memory service (docs/memory-plan.md, "Central
// memory"; the service itself is designed in docs/central-memory-plan.md and
// lives in the nemeda-memory-service repository). Zero dependencies: plain
// `fetch` for the HTTP endpoints and a minimal Streamable HTTP MCP client for
// the service's read-only tools.
//
// This module deliberately imports nothing from memory.mjs so workspace.mjs
// (validator, offline doctor row) can use it without an import cycle; the
// promotion flow that needs the journals lives in memory-sync.mjs.
//
// The token is personal and secret: it only ever travels in the
// Authorization header, never in a URL, a log line, or an error message.
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENV_LOCAL_NAME, loadEnvLocal } from "./env.mjs";
import { evaluateCentralPins } from "./memory-pins.mjs";

export const CENTRAL_CONTRACT_MAJOR = 1;
export const DEFAULT_TOKEN_VARIABLE = "NEMEDA_MEMORY_TOKEN";
// Only variables with this prefix are ever read as a token or a connection
// string: a configuration naming AIRTABLE_API_KEY or SLACK_BOT_TOKEN must not
// make the kit send that secret anywhere (docs/drive-config-plan.md, guard 2).
export const MEMORY_VARIABLE_PATTERN = /^NEMEDA_MEMORY_[A-Z0-9_]+$/;
// The service's read-only MCP tools the kit's stdio server proxies for hosts
// that cannot connect to the service directly (Codex, Cursor). The write
// tool, memory_central_promote, is deliberately absent: promotion goes
// through `memory sync` / `memory close` only.
export const CENTRAL_PROXY_TOOLS = ["memory_central_search", "memory_central_digests", "memory_central_projects", "memory_central_whoami"];

const DEFAULT_TIMEOUT_MS = 15000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class CentralError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CentralError";
    this.code = code;
  }
}

// Null when `value` is an acceptable service URL, otherwise the reason (a
// sentence fragment the validator appends to "memory.central.mcpUrl ").
// Plain http is accepted only for loopback, so a token never crosses a
// network unencrypted.
export function serviceUrlProblem(value) {
  if (typeof value !== "string" || !value.trim()) return "must be a non-empty URL";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "is not a valid URL";
  }
  if (url.username || url.password) return "must not embed credentials";
  if (url.search || url.hash) return "must not carry a query string or fragment";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return "must use https:// (plain http is accepted only for localhost)";
}

// The HTTP endpoints (/health, /whoami, /promote) sit next to the MCP
// endpoint: strip a trailing /mcp so a service behind a path prefix works.
export function serviceBaseUrl(mcpUrl) {
  const url = new URL(mcpUrl);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "");
  return url.toString().replace(/\/$/, "");
}

// Normalized `memory.central`, or null when it is not configured.
// `configSource` ("repository", "drive", "drive-cache") comes from the
// workspace context and decides whether a first use may pin itself silently.
// A token variable without the NEMEDA_MEMORY_ prefix is dropped here too, so
// a configuration loaded despite a validation error still never reads it.
export function centralSettings(config, { configSource } = {}) {
  const central = config?.memory?.central;
  if (!central || typeof central !== "object") return null;
  let baseUrl = null;
  if (central.mcpUrl && !serviceUrlProblem(central.mcpUrl)) baseUrl = serviceBaseUrl(central.mcpUrl);
  const tokenVariable = central.tokenVariable || DEFAULT_TOKEN_VARIABLE;
  const tokenVariableAllowed = MEMORY_VARIABLE_PATTERN.test(tokenVariable);
  return {
    mcpUrl: baseUrl ? central.mcpUrl : null,
    baseUrl,
    tokenVariable: tokenVariableAllowed ? tokenVariable : null,
    invalidTokenVariable: tokenVariableAllowed ? null : String(tokenVariable),
    projectId: central.projectId || config.project?.id,
    promote: central.promote || "reviewed",
    urlVariable: central.urlVariable || null,
    schema: central.schema || "nemeda_memory",
    configSource: configSource || "repository"
  };
}

const PIN_CHECK_CODES = { "untrusted-origin": "central-origin", "untrusted-project": "central-project", "invalid-token-variable": "memory-central" };

// ~/.nemeda, the per-person home the Slack bridge already uses
// (NEMEDA_HOME overrides it, as there).
export function personalHome(environment = process.env) {
  return environment.NEMEDA_HOME || path.join(os.homedir(), ".nemeda");
}

// The personal token, looked up in order: the process environment,
// ~/.nemeda/.env.local (where it belongs: it is per person, not per project),
// then the workspace .env.local. Returns where it came from so doctor can
// say so, never the value in any message.
//
// This is the step every consumer takes before sending the token (sync,
// search --central, the MCP proxy, doctor, the automatic sync), so the pins
// are checked here: an origin or project this workspace was not trusted with
// yields no token and a `reason` ("untrusted-origin", "untrusted-project",
// "invalid-token-variable") with a message naming both values and the command
// that resolves it. `recordFirstUse: false` (doctor) never records a pin.
export function resolveCentralToken(root, settings, environment = process.env, { recordFirstUse = true } = {}) {
  if (settings?.invalidTokenVariable) {
    return {
      token: null,
      source: null,
      variable: settings.invalidTokenVariable,
      reason: "invalid-token-variable",
      message: `memory.central.tokenVariable is ${settings.invalidTokenVariable}; the kit only reads variables named NEMEDA_MEMORY_*, so no token is sent.`
    };
  }
  if (root && settings?.mcpUrl) {
    const pins = evaluateCentralPins(root, { mcpUrl: settings.mcpUrl, projectId: settings.projectId, configSource: settings.configSource }, environment, { recordFirstUse });
    if (!pins.trusted) return { token: null, source: null, variable: settings.tokenVariable, reason: pins.reason, message: pins.message };
  }
  const name = settings?.tokenVariable || DEFAULT_TOKEN_VARIABLE;
  const { value, source } = resolvePersonalVariable(root, name, environment);
  return { token: value, source, variable: name };
}

// One personal secret by variable name, in the same order as the token:
// the process environment, ~/.nemeda/.env.local, the workspace .env.local.
// Also used for the administrators' connection string (memory-psql.mjs).
export function resolvePersonalVariable(root, name, environment = process.env) {
  if (environment[name]) return { value: environment[name], source: "environment" };
  const home = personalHome(environment);
  const personal = {};
  loadEnvLocal(home, personal);
  if (personal[name]) return { value: personal[name], source: path.join(home, ENV_LOCAL_NAME) };
  if (root) {
    const workspace = {};
    loadEnvLocal(root, workspace);
    if (workspace[name]) return { value: workspace[name], source: path.join(root, ENV_LOCAL_NAME) };
  }
  return { value: null, source: null };
}

// Whether the kit's MCP server should list the central proxy tools without
// --central-proxy: NEMEDA_MEMORY_CENTRAL_PROXY=true in the environment or in
// ~/.nemeda/.env.local. That is how Claude Code uses the proxy (its
// .mcp.json does not pass the flag) until it connects to the service
// directly with Entra sign-in; opt-in per machine, never per project.
export function centralProxyEnabled(environment = process.env) {
  const { value } = resolvePersonalVariable(null, "NEMEDA_MEMORY_CENTRAL_PROXY", environment);
  return ["true", "1", "yes"].includes(String(value || "").trim().toLowerCase());
}

// Warns when the file holding the token is readable by other users (POSIX
// only; Windows ACLs are not inspected).
export function tokenFileTooOpen(source, platform = process.platform) {
  if (!source || source === "environment" || platform === "win32") return false;
  try {
    return (statSync(source).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

function missingTokenMessage(settings, environment = process.env) {
  return `No token for the memory service: set ${settings.tokenVariable} in ${path.join(personalHome(environment), ENV_LOCAL_NAME)} (personal, never committed; ask whoever runs the service for one).`;
}

export function requireCentralToken(root, settings, environment = process.env) {
  const resolved = resolveCentralToken(root, settings, environment);
  if (resolved.reason) throw new CentralError(resolved.reason, resolved.message);
  if (!resolved.token) throw new CentralError("no-token", missingTokenMessage(settings, environment));
  return resolved.token;
}

function errorDetail(text) {
  if (!text) return "no body";
  try {
    const parsed = JSON.parse(text);
    const detail = parsed.detail ?? parsed.error ?? parsed.message;
    if (detail !== undefined) return typeof detail === "string" ? detail : JSON.stringify(detail);
  } catch {
    // not JSON; fall through to the raw text
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

async function centralFetch(settings, url, { method = "GET", token, body, headers = {}, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // The service never redirects API calls, and a redirect is how a
      // bearer token could be carried to another host: refuse it outright.
      redirect: "error"
    });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : error?.cause?.code || error?.cause?.message || error?.message || String(error);
    throw new CentralError("unreachable", `Cannot reach the memory service at ${settings.baseUrl} (${reason}). Is this machine on the tailnet?`);
  }
  if (response.status === 401) {
    await response.text().catch(() => "");
    throw new CentralError("unauthenticated", `The memory service rejected the token in ${settings.tokenVariable} (HTTP 401); it is missing, expired, or not valid for this service.`);
  }
  if (response.status === 403) {
    const text = await response.text().catch(() => "");
    throw new CentralError("forbidden", `The memory service refused this request (HTTP 403): ${errorDetail(text)}.`);
  }
  return response;
}

async function readJson(response, what) {
  const text = await response.text();
  if (!response.ok) throw new CentralError("http", `${what} failed with HTTP ${response.status}: ${errorDetail(text)}.`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new CentralError("protocol", `${what} answered with something that is not JSON.`);
  }
}

function requireService(settings) {
  if (!settings?.baseUrl) {
    throw new CentralError("no-service", "memory.central.mcpUrl is not set (or not a valid https URL); the memory service is how the kit reaches central memory.");
  }
}

// Unauthenticated: { service, version, contractVersion, embeddings }.
export async function centralHealth(settings, options = {}) {
  requireService(settings);
  return readJson(await centralFetch(settings, `${settings.baseUrl}/health`, options), "GET /health");
}

// Authenticated: { email, projects, canPromote }.
export async function centralWhoami(settings, token, options = {}) {
  requireService(settings);
  return readJson(await centralFetch(settings, `${settings.baseUrl}/whoami`, { ...options, token }), "GET /whoami");
}

// One POST /promote batch. Rows are the contract columns in snake_case,
// without promoted_at/promoted_by (the service sets those from the token).
// Always returns the full answer shape, even if the service omits parts.
export async function promoteBatch(settings, token, { entries = [], digests = [] } = {}, options = {}) {
  requireService(settings);
  const answer = await readJson(
    await centralFetch(settings, `${settings.baseUrl}/promote`, { ...options, method: "POST", token, body: { entries, digests } }),
    "POST /promote"
  );
  return {
    entries: { inserted: answer.entries?.inserted || [], existing: answer.entries?.existing || [] },
    digests: { inserted: answer.digests?.inserted || [], existing: answer.digests?.existing || [] },
    errors: answer.errors || []
  };
}

// Streamable HTTP responses are either one JSON body or an SSE stream whose
// `data:` events carry JSON-RPC messages; find the one answering `id`.
async function readRpc(response, id, what) {
  const text = await response.text();
  if (!response.ok) throw new CentralError("http", `${what} failed with HTTP ${response.status}: ${errorDetail(text)}.`);
  const messages = [];
  if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // keep-alive or non-JSON event; ignore
      }
    }
  } else {
    try {
      const parsed = JSON.parse(text);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      throw new CentralError("protocol", `${what} answered with something that is not JSON-RPC.`);
    }
  }
  const reply = messages.find((message) => message && message.id === id);
  if (!reply) throw new CentralError("protocol", `${what} got no JSON-RPC answer.`);
  if (reply.error) throw new CentralError("protocol", `${what}: ${reply.error.message || JSON.stringify(reply.error)}`);
  return reply;
}

// Calls one tool on the service's MCP endpoint: initialize, the initialized
// notification, then tools/call, carrying Mcp-Session-Id when the server
// assigns one. Returns the MCP CallToolResult ({ content, isError? }).
export async function callCentralTool(settings, token, name, args = {}, options = {}) {
  requireService(settings);
  const post = (message, extraHeaders = {}) =>
    centralFetch(settings, settings.mcpUrl, {
      ...options,
      method: "POST",
      token,
      body: message,
      headers: { accept: "application/json, text/event-stream", ...extraHeaders }
    });
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "nemeda-agent-kit", version: "1" } }
  });
  const sessionId = init.headers.get("mcp-session-id");
  const initReply = await readRpc(init, 1, "MCP initialize");
  const session = {
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    "mcp-protocol-version": initReply.result?.protocolVersion || MCP_PROTOCOL_VERSION
  };
  const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  await initialized.text().catch(() => "");
  const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, session);
  const reply = await readRpc(call, 2, name);
  if (sessionId) {
    // Best effort: let the server drop the session now instead of on timeout.
    centralFetch(settings, settings.mcpUrl, { ...options, method: "DELETE", token, headers: session })
      .then((response) => response.text())
      .catch(() => {});
  }
  return reply.result || { content: [] };
}

// The JSON a tool returned in its first text block, or null. The service's
// tools answer with JSON text, like this kit's own tools.
export function toolResultJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function noServiceCheck(settings) {
  return {
    status: settings.urlVariable ? "warn" : "fail",
    code: "memory-central",
    message: settings.urlVariable
      ? "memory.central has only urlVariable: administrators can `memory sync --via psql`, but search, the normal sync, and the agents' central tools need memory.central.mcpUrl."
      : "memory.central.mcpUrl is missing or invalid."
  };
}

// The offline part of the central checks, for `nemeda-agent doctor` and the
// workspace_doctor MCP tool, which never touch the network: configuration
// and token presence only (never the token itself). `nemeda-agent memory
// doctor` runs the online ones.
export function centralOfflineChecks(root, config, environment = process.env, { configSource } = {}) {
  const settings = centralSettings(config, { configSource });
  if (!settings) return [];
  if (!settings.baseUrl) return [noServiceCheck(settings)];
  const { source, reason, message } = resolveCentralToken(root, settings, environment, { recordFirstUse: false });
  if (reason) return [{ status: "fail", code: PIN_CHECK_CODES[reason], message }];
  if (!source) return [{ status: "warn", code: "memory-central", message: missingTokenMessage(settings, environment) }];
  const where = source === "environment" ? `the ${settings.tokenVariable} environment variable` : source;
  return [{ status: "pass", code: "memory-central", message: `Central memory through ${settings.baseUrl}, token from ${where}; \`nemeda-agent memory doctor\` checks the service itself.` }];
}

function projectListed(listing, projectId) {
  const projects = Array.isArray(listing) ? listing : listing?.projects;
  if (!Array.isArray(projects)) return null;
  return projects.some((project) => project === projectId || project?.id === projectId);
}

// Online checks for `nemeda-agent memory doctor`. Never throws: every
// failure becomes a check row.
export async function centralDoctorChecks(root, config, { environment = process.env, fetchImpl, platform = process.platform, configSource } = {}) {
  const settings = centralSettings(config, { configSource });
  const checks = [];
  if (!settings) return checks;
  if (!settings.baseUrl) return [noServiceCheck(settings)];
  const options = fetchImpl ? { fetchImpl } : {};
  let reachable = false;
  try {
    const health = await centralHealth(settings, options);
    reachable = true;
    const major = Number.parseInt(String(health.contractVersion ?? ""), 10);
    if (!Number.isInteger(major)) {
      checks.push({ status: "warn", code: "memory-central", message: `${settings.baseUrl} answers, but /health reports no contractVersion; cannot confirm compatibility.` });
    } else if (major !== CENTRAL_CONTRACT_MAJOR) {
      checks.push({ status: "fail", code: "memory-central", message: `${settings.baseUrl} speaks contract version ${major}; this kit knows ${CENTRAL_CONTRACT_MAJOR}. Update the plugin (or the service) before syncing.` });
    } else {
      checks.push({ status: "pass", code: "memory-central", message: `${settings.baseUrl} is reachable (${health.service || "service"} ${health.version || "?"}, contract ${major}).` });
    }
    const embeddings = health.embeddings;
    if (embeddings && embeddings.status && embeddings.status !== "ok") {
      checks.push({ status: "warn", code: "memory-central-embeddings", message: `Embeddings are ${embeddings.status}${Number.isInteger(embeddings.pending) ? ` (${embeddings.pending} rows waiting for a vector)` : ""}; central search falls back to full text until they recover.` });
    }
  } catch (error) {
    checks.push({ status: "fail", code: "memory-central", message: error instanceof Error ? error.message : String(error) });
  }

  const { token, source, reason, message } = resolveCentralToken(root, settings, environment, { recordFirstUse: false });
  if (reason) {
    checks.push({ status: "fail", code: PIN_CHECK_CODES[reason], message });
    return checks;
  }
  if (!token) {
    checks.push({ status: "warn", code: "memory-central-token", message: missingTokenMessage(settings, environment) });
    return checks;
  }
  if (tokenFileTooOpen(source, platform)) {
    checks.push({ status: "warn", code: "memory-central-token", message: `${source} is readable by other users; run \`chmod 600 ${source}\`.` });
  }
  if (!reachable) return checks;
  try {
    const identity = await centralWhoami(settings, token, options);
    checks.push({
      status: identity.canPromote === false ? "warn" : "pass",
      code: "memory-central-token",
      message: identity.canPromote === false
        ? `Authenticated as ${identity.email || "?"} (token from ${source}), but this account may not promote; \`memory sync\` will be refused.`
        : `Authenticated as ${identity.email || "?"} (token from ${source}).`
    });
  } catch (error) {
    checks.push({ status: "fail", code: "memory-central-token", message: error instanceof Error ? error.message : String(error) });
    return checks;
  }
  try {
    const listed = projectListed(toolResultJson(await callCentralTool(settings, token, "memory_central_projects", {}, options)), settings.projectId);
    if (listed === true) {
      checks.push({ status: "pass", code: "memory-central-project", message: `Project ${settings.projectId} is registered in central memory.` });
    } else if (listed === false) {
      checks.push({ status: "warn", code: "memory-central-project", message: `Project ${settings.projectId} is not registered in central memory, so \`memory sync\` will be refused; ask an administrator to run scripts/register-projects.sh ${settings.projectId} in nemeda-memory-service.` });
    } else {
      checks.push({ status: "warn", code: "memory-central-project", message: "memory_central_projects answered in an unexpected shape; cannot confirm the project is registered." });
    }
  } catch (error) {
    checks.push({ status: "warn", code: "memory-central-project", message: `Could not list central projects: ${error instanceof Error ? error.message : String(error)}` });
  }
  return checks;
}
