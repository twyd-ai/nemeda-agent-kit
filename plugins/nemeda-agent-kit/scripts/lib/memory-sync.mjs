// Promotion of project memory to central memory (docs/memory-plan.md, flow 6):
// `nemeda-agent memory sync` sends the latest revision of every entry that
// matches memory.central.promote, and that this machine has not seen
// acknowledged yet, to the service's POST /promote. The service inserts with
// ON CONFLICT (id, revision) DO NOTHING, so re-sending is always safe; the
// acknowledgement file only avoids re-sending what already went through.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { latestRevisions, readAllJournals, resolveAuthorEmail } from "./memory.mjs";
import { CentralError, centralSettings, promoteBatch, requireCentralToken } from "./memory-central.mjs";

// Matches the service's per-request limit.
export const PROMOTE_BATCH_SIZE = 200;

export function syncStatePath(root) {
  return path.join(root, ".nemeda", "state", "memory-sync.json");
}

// { promoted: { [entryId]: highest acknowledged revision }, lastSyncAt,
// lastError }. Machine-local, disposable: losing it only means the next
// sync re-sends rows the service then reports as already existing.
export function readSyncState(root) {
  const file = syncStatePath(root);
  const empty = { promoted: {}, lastSyncAt: null, lastError: null };
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { ...empty, ...parsed, promoted: parsed.promoted && typeof parsed.promoted === "object" ? parsed.promoted : {} };
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

// Runs one sync. By default only this machine's author's entries are sent
// (the person promoting vouches for them and appears as promoted_by);
// `all` sends every author's, which is what `memory close` needs. Throws a
// CentralError for problems that stop the whole run (no service, no token,
// unreachable, 401/403); per-row refusals come back in `errors` and those
// rows are retried by the next sync.
export async function syncToCentral(root, config, { environment = process.env, fetchImpl, dryRun = false, all = false, now = () => new Date() } = {}) {
  const settings = centralSettings(config);
  if (!settings) throw new Error("No memory.central section in .nemeda/agent-kit.json; see docs/memory-plan.md, \"Configuration\".");
  if (!settings.baseUrl) {
    throw new CentralError("no-service", "memory.central.mcpUrl is not set; promotion goes through the memory service (`--via psql` for administrators is not implemented yet).");
  }
  const author = all ? undefined : resolveAuthorEmail(root);
  if (!all && !author) throw new Error("git config user.email is not set; the kit promotes your own entries by default (or pass --all).");

  const memoryRoot = path.join(root, config.memory.project.path);
  const state = readSyncState(root);
  const { entries } = readAllJournals(memoryRoot);
  const candidates = promotableEntries(entries, { promote: settings.promote, author, state });
  const report = {
    endpoint: `${settings.baseUrl}/promote`,
    projectId: settings.projectId,
    scope: all ? "all authors" : author,
    promote: settings.promote,
    dryRun,
    candidates: candidates.map((entry) => ({ id: entry.id, revision: entry.revision, title: entry.title, author: entry.author })),
    inserted: [],
    existing: [],
    errors: []
  };
  if (dryRun || candidates.length === 0) return report;

  const token = requireCentralToken(root, settings, environment);
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
      const answer = await promoteBatch(settings, token, { entries: batch.map((entry) => entryToContractRow(entry, settings.projectId)) }, fetchImpl ? { fetchImpl } : {});
      for (const item of answer.entries.inserted) if (acknowledge(item)) report.inserted.push({ id: item.id, revision: item.revision });
      for (const item of answer.entries.existing) if (acknowledge(item)) report.existing.push({ id: item.id, revision: item.revision });
      report.errors.push(...answer.errors);
      state.lastSyncAt = now().toISOString();
      writeSyncState(root, state);
    }
    state.lastError = report.errors.length ? `${report.errors.length} row(s) refused by the service` : null;
    writeSyncState(root, state);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    writeSyncState(root, state);
    throw error;
  }
  return report;
}

// What an unknown-project refusal means in practice, for CLI output.
export function describeSyncError(error, projectId) {
  if (error?.code === "unknown-project") {
    return `${error.id}: project ${projectId} is not registered in central memory; ask an administrator to run scripts/register-projects.sh ${projectId} in nemeda-memory-service.`;
  }
  return `${error?.id || "?"}${error?.revision ? ` r${error.revision}` : ""}: ${error?.code || "error"} — ${error?.message || "refused"}`;
}
