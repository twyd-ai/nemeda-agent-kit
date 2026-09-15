// Promotion of project memory to central memory (docs/memory-plan.md, flow 6):
// `nemeda-agent memory sync` sends the latest revision of every entry that
// matches memory.central.promote, and that this machine has not seen
// acknowledged yet, to the service's POST /promote. The service inserts with
// ON CONFLICT (id, revision) DO NOTHING, so re-sending is always safe; the
// acknowledgement file only avoids re-sending what already went through.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latestRevisions, readAllJournals, resolveAuthorEmail } from "./memory.mjs";
import { CentralError, centralSettings, promoteBatch, requireCentralToken, resolveCentralToken } from "./memory-central.mjs";
import { readDigests } from "./memory-digest.mjs";
import { checkSchemaVersion, promoteViaPsql, psqlConnection } from "./memory-psql.mjs";

// Matches the service's per-request limit.
export const PROMOTE_BATCH_SIZE = 200;

export function syncStatePath(root) {
  return path.join(root, ".nemeda", "state", "memory-sync.json");
}

// { promoted: { [entryId]: highest acknowledged revision }, digests:
// { [digestId]: true }, lastSyncAt, lastAttemptAt, lastError }.
// Machine-local, disposable: losing it only means the next sync re-sends
// rows the service then reports as already existing.
export function readSyncState(root) {
  const file = syncStatePath(root);
  const empty = { promoted: {}, digests: {}, lastSyncAt: null, lastAttemptAt: null, lastError: null };
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const objectOrEmpty = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
    return { ...empty, ...parsed, promoted: objectOrEmpty(parsed.promoted), digests: objectOrEmpty(parsed.digests) };
  } catch {
    return empty;
  }
}

export function writeSyncState(root, state) {
  const file = syncStatePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, file);
}

// A journal entry as a row of the central `entries` table (the contract in
// docs/memory-plan.md). project_id comes from memory.central.projectId, not
// the entry, so one workspace always promotes into one central project.
export function entryToContractRow(entry, projectId) {
  return {
    id: entry.id,
    revision: entry.revision,
    project_id: projectId,
    repository_id: entry.repository ?? null,
    type: entry.type,
    title: entry.title,
    entry_date: entry.date,
    author_email: entry.author,
    ai_tool: entry.ai?.tool ?? null,
    ai_model: entry.ai?.model ?? null,
    tags: entry.tags || [],
    summary: entry.summary,
    client_summary: entry.clientSummary ?? null,
    status: entry.status,
    source: entry.source || {},
    language: entry.language ?? null,
    created_at: entry.createdAt
  };
}

// A digest file as a row of the central `digests` table.
export function digestToContractRow(digest, projectId) {
  return {
    id: digest.id,
    scope: digest.scope || "project",
    project_id: projectId,
    period: digest.period,
    body: digest.body,
    generated_by: digest.generatedBy,
    kind: digest.kind,
    created_at: digest.createdAt
  };
}

// Digests not yet acknowledged, optionally only the ones this author wrote,
// oldest first so a closure never overtakes the recaps before it.
export function promotableDigests(digests, { author, state } = {}) {
  return digests
    .filter((digest) => !author || digest.generatedBy === author)
    .filter((digest) => !state?.digests?.[digest.id])
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

// Latest revision per entry, filtered by the promote policy ("reviewed":
// only reviewed entries leave the project; "all": everything), optionally by
// author, minus what `state` already acknowledges. Oldest first, so a
// partial run promotes history in order.
export function promotableEntries(entries, { promote = "reviewed", author, state } = {}) {
  return latestRevisions(entries)
    .filter((entry) => promote === "all" || entry.status === "reviewed")
    .filter((entry) => !author || entry.author === author)
    .filter((entry) => (state?.promoted?.[entry.id] || 0) < entry.revision)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

// The two ways to promote, with one interface: `endpoint` for reports, and
// `open()`, which checks credentials (only when something is actually sent)
// and returns an async function taking { entries, digests } and answering in
// the POST /promote shape.
function serviceTransport(root, settings, environment, fetchImpl) {
  if (!settings.baseUrl) {
    throw new CentralError("no-service", "memory.central.mcpUrl is not set; promotion goes through the memory service (administrators can use `--via psql`).");
  }
  return {
    endpoint: `${settings.baseUrl}/promote`,
    open() {
      const token = requireCentralToken(root, settings, environment);
      return (payload) => promoteBatch(settings, token, payload, fetchImpl ? { fetchImpl } : {});
    }
  };
}

// Administrators only: the contract tables directly, as the person's own
// writer role, with promoted_by from their git email.
function psqlTransport(root, settings, environment) {
  if (!settings.urlVariable) {
    throw new CentralError("psql-config", "memory.central.urlVariable is not set; `--via psql` needs the name of the variable holding an administrator's connection string.");
  }
  return {
    endpoint: `psql (${settings.urlVariable})`,
    open() {
      const connection = psqlConnection(root, settings, environment);
      const promotedBy = resolveAuthorEmail(root);
      if (!promotedBy) throw new Error("git config user.email is not set; `--via psql` records it as promoted_by.");
      checkSchemaVersion(connection, { environment });
      return async (payload) => promoteViaPsql(connection, { ...payload, promotedBy }, { environment });
    }
  };
}

// Runs one sync. By default only this machine's author's entries are sent
// (the person promoting vouches for them and appears as promoted_by);
// `all` sends every author's, which is what `memory close` needs. `via` is
// "service" (default) or "psql" (administrators). Throws a CentralError for
// problems that stop the whole run (no service, no token, unreachable,
// 401/403, psql failure); per-row refusals come back in `errors` and those
// rows are retried by the next sync.
export async function syncToCentral(root, config, { environment = process.env, fetchImpl, dryRun = false, all = false, via = "service", now = () => new Date() } = {}) {
  const settings = centralSettings(config);
  if (!settings) throw new Error("No memory.central section in .nemeda/agent-kit.json; see docs/memory-plan.md, \"Configuration\".");
  const transport = via === "psql" ? psqlTransport(root, settings, environment) : serviceTransport(root, settings, environment, fetchImpl);
  const author = all ? undefined : resolveAuthorEmail(root);
  if (!all && !author) throw new Error("git config user.email is not set; the kit promotes your own entries by default (or pass --all).");

  const memoryRoot = path.join(root, config.memory.project.path);
  const state = readSyncState(root);
  const { entries } = readAllJournals(memoryRoot);
  const candidates = promotableEntries(entries, { promote: settings.promote, author, state });
  const digestCandidates = promotableDigests(readDigests(memoryRoot).digests, { author, state });
  const report = {
    endpoint: transport.endpoint,
    via,
    projectId: settings.projectId,
    scope: all ? "all authors" : author,
    promote: settings.promote,
    dryRun,
    candidates: candidates.map((entry) => ({ id: entry.id, revision: entry.revision, title: entry.title, author: entry.author })),
    inserted: [],
    existing: [],
    digests: {
      candidates: digestCandidates.map((digest) => ({ id: digest.id, kind: digest.kind, period: digest.period, generatedBy: digest.generatedBy })),
      inserted: [],
      existing: []
    },
    errors: []
  };
  if (dryRun || (candidates.length === 0 && digestCandidates.length === 0)) return report;

  const promote = transport.open();
  state.lastAttemptAt = now().toISOString();
  const sent = new Map(candidates.map((entry) => [entry.id, entry.revision]));
  const acknowledge = (item) => {
    if (!item || !sent.has(item.id)) return false;
    const revision = Number.isInteger(item.revision) ? item.revision : sent.get(item.id);
    state.promoted[item.id] = Math.max(state.promoted[item.id] || 0, revision);
    return true;
  };
  try {
    for (let start = 0; start < candidates.length; start += PROMOTE_BATCH_SIZE) {
      const batch = candidates.slice(start, start + PROMOTE_BATCH_SIZE);
      const answer = await promote({ entries: batch.map((entry) => entryToContractRow(entry, settings.projectId)) });
      for (const item of answer.entries.inserted) if (acknowledge(item)) report.inserted.push({ id: item.id, revision: item.revision });
      for (const item of answer.entries.existing) if (acknowledge(item)) report.existing.push({ id: item.id, revision: item.revision });
      report.errors.push(...answer.errors);
      state.lastSyncAt = now().toISOString();
      writeSyncState(root, state);
    }
    // Digests after entries, so a closure never lands before the entries it
    // closes over. The service answers digest ids as strings or { id }.
    const sentDigests = new Set(digestCandidates.map((digest) => digest.id));
    const acknowledgeDigest = (item) => {
      const id = typeof item === "string" ? item : item?.id;
      if (!sentDigests.has(id)) return null;
      state.digests[id] = true;
      return id;
    };
    for (let start = 0; start < digestCandidates.length; start += PROMOTE_BATCH_SIZE) {
      const batch = digestCandidates.slice(start, start + PROMOTE_BATCH_SIZE);
      const answer = await promote({ digests: batch.map((digest) => digestToContractRow(digest, settings.projectId)) });
      for (const item of answer.digests.inserted) {
        const id = acknowledgeDigest(item);
        if (id) report.digests.inserted.push(id);
      }
      for (const item of answer.digests.existing) {
        const id = acknowledgeDigest(item);
        if (id) report.digests.existing.push(id);
      }
      report.errors.push(...answer.errors);
      state.lastSyncAt = now().toISOString();
      writeSyncState(root, state);
    }
    state.lastError = report.errors.length ? `${report.errors.length} row(s) refused (${via})` : null;
    writeSyncState(root, state);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    writeSyncState(root, state);
    throw error;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Automatic sync from SessionStart, at most every AUTO_SYNC_INTERVAL_MS, so
// reviewed memory reaches central without anyone remembering to run it.
// ---------------------------------------------------------------------------

export const AUTO_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LOG_ROTATE_BYTES = 512 * 1024;
const DEFAULT_CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));

export function syncLogPath(root) {
  return path.join(root, ".nemeda", "state", "memory-sync.log");
}

// Cheap enough for a hook: config, one token lookup, one state read. On by
// default once memory.central.mcpUrl and a token exist (the committed config
// is the project's opt-in, the personal token the person's);
// MEMORY_SYNC_AUTO=false in .env.local turns it off on one machine.
export function shouldTriggerSync(root, config, environment = process.env, { now = Date.now() } = {}) {
  const settings = centralSettings(config);
  if (!settings?.baseUrl) return { trigger: false, reason: "memory.central.mcpUrl is not set" };
  if (["false", "0", "no", "off"].includes(String(environment.MEMORY_SYNC_AUTO || "").trim().toLowerCase())) {
    return { trigger: false, reason: "MEMORY_SYNC_AUTO is off" };
  }
  if (!resolveCentralToken(root, settings, environment).token) return { trigger: false, reason: "no token for the memory service" };
  const last = Date.parse(readSyncState(root).lastAttemptAt || "");
  if (Number.isFinite(last) && now - last < AUTO_SYNC_INTERVAL_MS) return { trigger: false, reason: "a sync ran less than 12 h ago" };
  return { trigger: true };
}

// Records the attempt first (so sessions opened in quick succession do not
// each start one), then starts `nemeda-agent memory sync` fully detached,
// logging to .nemeda/state/memory-sync.log (rotated past 512 KB). Returns
// the child's pid.
export function spawnDetachedSync(root, { environment = process.env, cliPath = DEFAULT_CLI_PATH, now = Date.now() } = {}) {
  const state = readSyncState(root);
  state.lastAttemptAt = new Date(now).toISOString();
  writeSyncState(root, state);
  const logPath = syncLogPath(root);
  try {
    if (statSync(logPath).size > LOG_ROTATE_BYTES) renameSync(logPath, `${logPath}.1`);
  } catch {
    // No log yet: nothing to rotate.
  }
  appendFileSync(logPath, `\n[${new Date(now).toISOString()}] background sync started from SessionStart\n`);
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [cliPath, "memory", "sync", "--cwd", root], {
      cwd: root,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: environment
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

// What an unknown-project refusal means in practice, for CLI output.
export function describeSyncError(error, projectId) {
  if (error?.code === "unknown-project") {
    return `${error.id}: project ${projectId} is not registered in central memory; ask an administrator to run scripts/register-projects.sh ${projectId} in nemeda-memory-service.`;
  }
  return `${error?.id || "?"}${error?.revision ? ` r${error.revision}` : ""}: ${error?.code || "error"} — ${error?.message || "refused"}`;
}
