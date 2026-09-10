// Project memory: append-only, per-author JSONL journals plus the pure
// functions that turn them into a queryable, deduplicated set of entries.
// See docs/memory-plan.md for the design and the central-database contract
// this entry shape is meant to travel unchanged into.
//
// The storage primitives below are kept decoupled from workspace.mjs config
// parsing on purpose: they take an explicit memory root (a resolved
// directory), never read `.nemeda/agent-kit.json` themselves. recordEntry,
// at the bottom, is the one deliberate exception — a self-contained
// integration point other features call without needing to know this
// module's internals; see its own comment.
//
// The source of truth is the journals, read fresh every time by
// readAllJournals/latestRevisions. filterEntries/searchEntries are the
// dependency-free "in-memory fallback" engine described in the plan: always
// correct, used directly when no SQLite engine is available, and the
// reference behaviour any accelerated index must match.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readWorkspaceContext } from "./workspace.mjs";

export const ENTRY_TYPES = ["ai-interaction", "decision", "finding", "meeting"];
export const ENTRY_STATUSES = ["pending", "reviewed"];
export const SOURCE_KINDS = ["session", "meeting", "pr", "manual", "airtable"];

// Crockford base32: no I, L, O, U, so a transcribed id is never ambiguous.
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value, length) {
  let output = "";
  let remaining = BigInt(value);
  for (let index = 0; index < length; index += 1) {
    output = CROCKFORD_ALPHABET[Number(remaining % 32n)] + output;
    remaining /= 32n;
  }
  return output;
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

// A ULID: a 48-bit millisecond timestamp followed by 80 bits of randomness,
// both Crockford base32 encoded (26 characters total). Entries therefore
// sort lexicographically by creation time with no separate sequence number,
// which is convenient for journals today and for the central database's
// primary key later (docs/memory-plan.md's central contract expects ULIDs).
export function generateEntryId(now = Date.now()) {
  return encodeBase32(now, 10) + encodeBase32(bytesToBigInt(randomBytes(10)), 16);
}

export function journalPath(memoryRoot, authorEmail) {
  return path.join(memoryRoot, "journal", `${authorEmail}.jsonl`);
}

export function digestsPath(memoryRoot) {
  return path.join(memoryRoot, "digests");
}

// Builds a complete, valid entry from the fields a caller actually decides;
// everything else gets a sensible default. Pass `id`/`revision`/`createdAt`
// only when appending a later revision of an existing entry (see
// reviseEntry, which does this for you).
export function createEntry({
  id,
  revision,
  project,
  repository,
  type,
  title,
  date,
  author,
  ai,
  tags,
  summary,
  clientSummary,
  status,
  source,
  language,
  createdAt
} = {}) {
  const now = new Date();
  return {
    id: id || generateEntryId(),
    revision: revision || 1,
    project,
    ...(repository ? { repository } : {}),
    type,
    title,
    date: date || now.toISOString().slice(0, 10),
    author,
    ...(ai ? { ai } : {}),
    tags: tags || [],
    summary,
    clientSummary: clientSummary === undefined ? null : clientSummary,
    status: status || "pending",
    source: source || { kind: "manual" },
    ...(language ? { language } : {}),
    createdAt: createdAt || now.toISOString()
  };
}

// A later revision of an existing entry: same id, revision + 1, a fresh
// createdAt (when *this* revision was written — matches the central
// contract's `entries.created_at`). Never mutates the entry passed in.
export function reviseEntry(entry, changes = {}) {
  return { ...entry, ...changes, id: entry.id, revision: entry.revision + 1, createdAt: new Date().toISOString() };
}

export function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return ["entry must be an object"];
  if (typeof entry.id !== "string" || !entry.id.trim()) errors.push("id is required");
  if (!Number.isInteger(entry.revision) || entry.revision < 1) errors.push("revision must be a positive integer");
  if (typeof entry.project !== "string" || !entry.project.trim()) errors.push("project is required");
  if (entry.repository !== undefined && (typeof entry.repository !== "string" || !entry.repository.trim())) {
    errors.push("repository must be a non-empty string when present");
  }
  if (!ENTRY_TYPES.includes(entry.type)) errors.push(`type must be one of: ${ENTRY_TYPES.join(", ")}`);
  if (typeof entry.title !== "string" || !entry.title.trim()) errors.push("title is required");
  if (typeof entry.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) errors.push("date must be YYYY-MM-DD");
  if (typeof entry.author !== "string" || !entry.author.includes("@")) errors.push("author must be an email");
  if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string")) errors.push("tags must be an array of strings");
  if (typeof entry.summary !== "string" || !entry.summary.trim()) errors.push("summary is required");
  if (entry.clientSummary !== undefined && entry.clientSummary !== null && typeof entry.clientSummary !== "string") {
    errors.push("clientSummary must be a string or null");
  }
  if (!ENTRY_STATUSES.includes(entry.status)) errors.push(`status must be one of: ${ENTRY_STATUSES.join(", ")}`);
  if (!entry.source || typeof entry.source !== "object" || !SOURCE_KINDS.includes(entry.source.kind)) {
    errors.push(`source.kind must be one of: ${SOURCE_KINDS.join(", ")}`);
  }
  if (typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt))) errors.push("createdAt must be an ISO date-time");
  return errors;
}

// Parses one journal file, tolerating malformed or invalid lines by skipping
// and reporting them instead of throwing — a partially corrupted journal
// (a bad sync-client merge, a half-written line) must never take down every
// other author's memory.
export function readJournal(filePath) {
  const entries = [];
  const malformed = [];
  if (!existsSync(filePath)) return { entries, malformed };
  const lines = readFileSync(filePath, "utf8").split("\n");
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      malformed.push({ line: index + 1, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const errors = validateEntry(parsed);
    if (errors.length) {
      malformed.push({ line: index + 1, reason: errors.join("; ") });
      return;
    }
    entries.push(parsed);
  });
  return { entries, malformed };
}

// Reads every author's journal under <memoryRoot>/journal/. `authors` lists
// every journal file found (even ones that turned out fully malformed),
// which is what the doctor's per-author checks and `memory review --all`
// need to enumerate.
export function readAllJournals(memoryRoot) {
  const journalDir = path.join(memoryRoot, "journal");
  const result = { entries: [], malformed: [], authors: [] };
  if (!existsSync(journalDir)) return result;
  for (const name of readdirSync(journalDir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const author = name.slice(0, -".jsonl".length);
    result.authors.push(author);
    const { entries, malformed } = readJournal(path.join(journalDir, name));
    result.entries.push(...entries);
    for (const item of malformed) result.malformed.push({ author, ...item });
  }
  return result;
}

// Appends one entry (a new one, or a later revision from reviseEntry) to its
// author's journal. Throws on an invalid entry rather than writing garbage
// that readJournal would then have to skip; callers building entries through
// createEntry/reviseEntry only see this for a genuine caller bug.
export function appendEntry(memoryRoot, entry) {
  const errors = validateEntry(entry);
  if (errors.length) throw new Error(`Invalid memory entry: ${errors.join("; ")}`);
  const file = journalPath(memoryRoot, entry.author);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

// The newest revision per id wins; ties (should not happen — revisions are
// strictly increasing per id) keep whichever was read last.
export function latestRevisions(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const current = byId.get(entry.id);
    if (!current || entry.revision >= current.revision) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export function filterEntries(entries, { type, author, status, since, tag } = {}) {
  return entries.filter((entry) => {
    if (type && entry.type !== type) return false;
    if (author && entry.author !== author) return false;
    if (status && entry.status !== status) return false;
    if (since && entry.date < since) return false;
    if (tag && !(entry.tags || []).includes(tag)) return false;
    return true;
  });
}

// Dependency-free full-text scoring: the fraction of query words found in
// the title, summary, or tags, case-insensitively — no stemming, no
// ranking beyond that and recency. This is intentionally simple: it is the
// fallback engine when no SQLite is available, and the reference behaviour
// an accelerated FTS5 index is checked against, not the final word in
// relevance.
export function searchEntries(entries, query, filters = {}) {
  const candidates = filterEntries(entries, filters);
  const trimmed = (query || "").trim();
  if (!trimmed) return candidates;
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  return candidates
    .map((entry) => {
      const haystack = `${entry.title} ${entry.summary} ${(entry.tags || []).join(" ")}`.toLowerCase();
      const hits = words.filter((word) => haystack.includes(word)).length;
      return { entry, score: hits / words.length };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.date < b.entry.date ? 1 : -1))
    .map((result) => result.entry);
}

// Every entry is attributed to `git config user.email`, the same source the
// Airtable Knowledge Log hooks used. Empty string (never throws) when git is
// missing, unconfigured, or `root` is not a repository.
export function resolveAuthorEmail(root) {
  try {
    return execFileSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// A recordEntry(...) union of the entry types other kit features log
// against; "session" has no matching ENTRY_TYPES value, so it is filed as
// "ai-interaction" with source.kind "session" (an AI session is the most
// common thing that produces one).
const RECORD_ENTRY_TYPE_ALIASES = { session: "ai-interaction" };

// The one integration point other kit features (the meeting pipeline today,
// the unattended-capture harvester later) use to log a memory entry without
// knowing anything about journals, config shape, or author resolution.
// Reads the workspace config itself (the one deliberate exception to this
// module's usual "explicit memory root" rule) so a caller only needs a
// repository root.
//
// Never throws: returns null whenever memory is not configured, this
// machine has no git user.email, or anything else goes wrong — the same
// "never block the caller" contract the Airtable hooks already follow. A
// meeting or PR pipeline calling this is always allowed to keep going
// whether or not it returned an id.
//
// `source` may be a string naming the source kind ("meeting"), or an object
// `{ kind, ...anything else worth keeping, e.g. transcript, prUrl }`;
// `links` (e.g. `{ transcript: "docs/transcripts/2026-09-10-standup" }`) is
// merged onto the final source object as a convenience for callers who
// prefer to keep that separate from the kind.
export function recordEntry(root, { type, title, summary, date, source, links, tags, author, clientSummary } = {}) {
  try {
    const context = readWorkspaceContext(root);
    if (context.mode !== "configured" || !context.config?.memory) return null;
    const memoryRoot = path.join(context.root, context.config.memory.project.path);
    const authorEmail = author || resolveAuthorEmail(context.root);
    if (!authorEmail) return null;
    const sourceIsString = typeof source === "string";
    const sourceKind = sourceIsString ? source : source?.kind || (type === "session" ? "session" : "manual");
    const sourceExtra = !sourceIsString && source && typeof source === "object" ? source : {};
    const entry = createEntry({
      project: context.config.project.id,
      repository: context.config.repository?.id,
      type: RECORD_ENTRY_TYPE_ALIASES[type] || type,
      title,
      date,
      author: authorEmail,
      tags: tags || [],
      summary,
      clientSummary,
      source: { ...sourceExtra, kind: sourceKind, ...links }
    });
    appendEntry(memoryRoot, entry);
    return { id: entry.id, path: journalPath(memoryRoot, authorEmail) };
  } catch {
    return null;
  }
}
