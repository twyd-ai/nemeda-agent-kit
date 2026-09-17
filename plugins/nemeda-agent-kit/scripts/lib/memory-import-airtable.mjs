// `nemeda-agent memory import-airtable` (docs/memory-plan.md, flow 8, phase
// 1b-iv): a one-off migration of an Airtable Knowledge Log — the table the
// kit's own `airtable init` provisions, plus its Team table — into project
// memory, so a project's existing knowledge reaches central memory instead of
// starting empty.
//
// Where the entries go: one import journal per base,
// <memory>/journal/import-airtable-<baseId>.jsonl, written only by the person
// running the import. Each entry keeps its real author (Person → Team.Email);
// writing into every teammate's own journal from one machine would break the
// single-writer rule, and filing everything under the importer would lose who
// did the work. A teammate who later reviews an imported entry appends the
// revision to their own journal, and revisions merge by id as usual.
//
// Re-runnable: records whose id is already in any journal (source.recordId,
// same base) are skipped. The API key is read-only data here and never
// appears in a message.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createEntry, readAllJournals, validateEntry } from "./memory.mjs";

export const DEFAULT_AIRTABLE_API_URL = "https://api.airtable.com";
const PAGE_SIZE = 100;
const MAX_RETRIES = 3;
// Airtable asks clients to wait 30 seconds after a 429.
const DEFAULT_RETRY_DELAY_MS = 30_000;

// Knowledge Log "Type" → entry type. "Code / PR" is an AI session when an AI
// tool is recorded and a human finding otherwise; Document, Email / Comm,
// Other, and anything unknown become findings. The original value is kept in
// source.airtableType.
const TYPE_MAP = { "AI Interaction": "ai-interaction", Meeting: "meeting", Decision: "decision" };
const REVIEWED_STATUSES = new Set(["Reviewed", "Incorporated"]);
const BASE_ID_PATTERN = /^app[a-zA-Z0-9]{14}$/;

export function importJournalPath(memoryRoot, baseId) {
  return path.join(memoryRoot, "journal", `import-airtable-${baseId}.jsonl`);
}

function meaningful(value) {
  return typeof value === "string" && value.trim() !== "" && !/^N\/A\b/i.test(value.trim());
}

// One Knowledge Log record as an entry, or { skipped: reason }.
export function mapKnowledgeLogRecord(record, { baseId, table, project, repository, emailsByPersonId = new Map(), fallbackAuthor }) {
  const fields = record?.fields || {};
  const summary = typeof fields.Summary === "string" ? fields.Summary.trim() : "";
  if (!summary) return { skipped: "no Summary" };
  const personIds = Array.isArray(fields.Person) ? fields.Person : [];
  const resolvedAuthor = personIds.map((id) => emailsByPersonId.get(id)).find(Boolean);
  const author = resolvedAuthor || fallbackAuthor;
  if (!author) return { skipped: "no Person with an Email in the Team table, and no importer identity to fall back to" };

  const airtableType = typeof fields.Type === "string" ? fields.Type : null;
  const tool = meaningful(fields["AI Tool"]) ? fields["AI Tool"].trim() : null;
  const model = meaningful(fields["AI Model"]) ? fields["AI Model"].trim() : null;
  const type = TYPE_MAP[airtableType] || (airtableType === "Code / PR" && tool ? "ai-interaction" : "finding");
  const createdAt = typeof record.createdTime === "string" && !Number.isNaN(Date.parse(record.createdTime)) ? record.createdTime : new Date().toISOString();
  const date = typeof fields.Date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fields.Date) ? fields.Date : createdAt.slice(0, 10);
  const visibility = Object.entries(fields).find(([name, value]) => name.startsWith("Visible to ") && typeof value === "boolean");

  const entry = createEntry({
    project,
    repository,
    type,
    title: typeof fields.Entry === "string" && fields.Entry.trim() ? fields.Entry.trim() : `Knowledge Log — ${date}`,
    date,
    author,
    ai: tool || model ? { ...(tool ? { tool } : {}), ...(model ? { model } : {}) } : undefined,
    tags: Array.isArray(fields.Tags) ? fields.Tags.filter((tag) => typeof tag === "string") : [],
    summary,
    clientSummary: meaningful(fields["Client Summary"]) ? fields["Client Summary"].trim() : null,
    status: REVIEWED_STATUSES.has(fields.Status) ? "reviewed" : "pending",
    source: {
      kind: "airtable",
      baseId,
      table,
      recordId: record.id,
      ...(airtableType ? { airtableType } : {}),
      ...(typeof fields.Status === "string" ? { airtableStatus: fields.Status } : {}),
      ...(meaningful(fields["GitHub Link"]) ? { prUrl: fields["GitHub Link"].trim() } : {}),
      ...(meaningful(fields["Drive Link"]) ? { driveUrl: fields["Drive Link"].trim() } : {}),
      ...(visibility ? { clientVisible: visibility[1] } : {}),
      ...(resolvedAuthor ? {} : { personUnresolved: true })
    },
    createdAt
  });
  const errors = validateEntry(entry);
  return errors.length ? { skipped: errors.join("; ") } : { entry, resolvedAuthor: Boolean(resolvedAuthor) };
}

async function airtableGet(url, apiKey, { fetchImpl, retryDelayMs, sleep }) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new Error(`Cannot reach Airtable (${error?.cause?.code || error?.message || String(error)}).`);
    }
    if (response.status === 429 && attempt < MAX_RETRIES) {
      await response.text().catch(() => "");
      await sleep(retryDelayMs);
      continue;
    }
    const text = await response.text();
    if (response.status === 401) throw new Error("Airtable rejected AIRTABLE_API_KEY (HTTP 401).");
    if (response.status === 403 || response.status === 404) {
      throw new Error(`Airtable refused this base or table (HTTP ${response.status}): check the id or name, and that AIRTABLE_API_KEY has data.records:read on the base.`);
    }
    if (!response.ok) throw new Error(`Airtable answered HTTP ${response.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Airtable answered with something that is not JSON.");
    }
  }
}

// Every record of one table, following Airtable's offset pagination.
export async function fetchAllRecords(apiKey, baseId, table, options) {
  const records = [];
  let offset;
  do {
    const url = new URL(`${options.apiUrl}/v0/${baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (offset) url.searchParams.set("offset", offset);
    const page = await airtableGet(url.toString(), apiKey, options);
    records.push(...(Array.isArray(page.records) ? page.records : []));
    offset = page.offset;
  } while (offset);
  return records;
}

function countBy(items, key) {
  return items.reduce((counts, item) => ({ ...counts, [item[key]]: (counts[item[key]] || 0) + 1 }), {});
}

// "from=to" strings (the CLI's repeatable --alias) as a Map of lower-cased
// emails. Throws on anything that is not two email addresses.
export function parseAuthorAliases(values = []) {
  const aliases = new Map();
  for (const value of values) {
    const [from, to, extra] = String(value).split("=").map((part) => part.trim().toLowerCase());
    if (extra !== undefined || !/^[^\s@]+@[^\s@]+$/.test(from || "") || !/^[^\s@]+@[^\s@]+$/.test(to || "")) {
      throw new Error(`--alias expects from@example.com=to@example.com, got "${value}".`);
    }
    aliases.set(from, to);
  }
  return aliases;
}

// Imports one base's Knowledge Log. The base and table come from the options,
// else from airtable.knowledgeLog / airtable.baseId in the workspace config;
// the table defaults to "Knowledge Log" and the people table to "Team".
// `authorAliases` (Map from → to) turns a Team email into the person's memory
// identity when they differ (a client-side address in Airtable, the company
// one in memory), so each person is one author and can review their own
// imported entries. `fallbackAuthor` (the importer's memory identity) signs
// records whose Person has no Email in the Team table; the report lists them.
export async function importAirtableKnowledgeLog(root, config, {
  baseId,
  table,
  teamTable = "Team",
  apiKey,
  authorAliases = new Map(),
  fallbackAuthor,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  apiUrl = DEFAULT_AIRTABLE_API_URL,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!config?.memory?.project?.path) throw new Error("No `memory` section in .nemeda/agent-kit.json; see docs/memory-plan.md.");
  const knowledgeLog = config.airtable?.knowledgeLog;
  const base = baseId || knowledgeLog?.baseId || config.airtable?.baseId;
  const logTable = table || knowledgeLog?.tableId || "Knowledge Log";
  if (!base || !BASE_ID_PATTERN.test(base)) throw new Error("Which Airtable base? Pass --base appXXXXXXXXXXXXXX (or set airtable.baseId).");
  if (!apiKey) throw new Error("AIRTABLE_API_KEY is not set (environment or this workspace's .env.local); it needs data.records:read on the base.");

  const options = { fetchImpl, apiUrl: apiUrl.replace(/\/+$/, ""), retryDelayMs, sleep };
  const memoryRoot = path.join(root, config.memory.project.path);
  const records = await fetchAllRecords(apiKey, base, logTable, options);
  let emailsByPersonId = new Map();
  let teamWarning = null;
  try {
    const team = await fetchAllRecords(apiKey, base, teamTable, options);
    emailsByPersonId = new Map(
      team
        .filter((person) => typeof person.fields?.Email === "string" && person.fields.Email.includes("@"))
        .map((person) => {
          const email = person.fields.Email.trim().toLowerCase();
          return [person.id, authorAliases.get(email) || email];
        })
    );
  } catch (error) {
    teamWarning = `Could not read the ${teamTable} table (${error.message}); every record is attributed to ${fallbackAuthor || "nobody"}.`;
  }

  const imported = new Set(
    readAllJournals(memoryRoot).entries
      .filter((entry) => entry.source?.kind === "airtable" && entry.source.baseId === base)
      .map((entry) => entry.source.recordId)
  );
  const journal = importJournalPath(memoryRoot, base);
  const entries = [];
  const report = { baseId: base, table: logTable, journal, dryRun, fetched: records.length, alreadyImported: 0, skipped: [], unresolvedAuthors: [], teamWarning };
  const oldestFirst = [...records].sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
  for (const record of oldestFirst) {
    if (imported.has(record.id)) {
      report.alreadyImported += 1;
      continue;
    }
    const mapped = mapKnowledgeLogRecord(record, { baseId: base, table: logTable, project: config.project.id, repository: config.repository?.id, emailsByPersonId, fallbackAuthor });
    if (mapped.skipped) {
      report.skipped.push({ recordId: record.id, reason: mapped.skipped });
      continue;
    }
    if (!mapped.resolvedAuthor) report.unresolvedAuthors.push(record.id);
    entries.push(mapped.entry);
  }

  if (!dryRun && entries.length) {
    mkdirSync(path.dirname(journal), { recursive: true });
    // One write for the whole batch: a sync client never sees half an import.
    appendFileSync(journal, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }
  report.imported = entries.map((entry) => ({ id: entry.id, recordId: entry.source.recordId, date: entry.date, type: entry.type, status: entry.status, author: entry.author, title: entry.title }));
  report.counts = {
    reviewed: entries.filter((entry) => entry.status === "reviewed").length,
    pending: entries.filter((entry) => entry.status === "pending").length,
    byAuthor: countBy(entries, "author")
  };
  return report;
}
