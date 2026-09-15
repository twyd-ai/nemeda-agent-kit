// Digests (docs/memory-plan.md, flows 6–7): recaps, closures, and reopenings
// stored as Markdown files under <memory>/digests/, one file per digest,
// written once and never edited. Like journal lines, that keeps the shared
// drive safe: every file has exactly one writer, ever. A small front matter
// block carries the fields the central `digests` table needs.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { digestsPath, generateEntryId } from "./memory.mjs";

export const DIGEST_KINDS = ["recap", "closure", "reopen"];
const FRONT_MATTER_KEYS = ["id", "scope", "project", "period", "kind", "generatedBy", "createdAt"];

export function createDigest({ id, project, period, kind = "recap", body, generatedBy, createdAt } = {}) {
  return {
    id: id || generateEntryId(),
    scope: "project",
    project,
    period,
    kind,
    generatedBy,
    createdAt: createdAt || new Date().toISOString(),
    body: typeof body === "string" ? body.trim() : body
  };
}

function oneLine(value) {
  return typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value);
}

export function validateDigest(digest) {
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) return ["digest must be an object"];
  const errors = [];
  if (typeof digest.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(digest.id)) errors.push("id must be a plain identifier");
  if (digest.scope !== "project") errors.push('scope must be "project"');
  if (!oneLine(digest.project)) errors.push("project is required");
  if (!oneLine(digest.period)) errors.push("period is required (one line)");
  if (!DIGEST_KINDS.includes(digest.kind)) errors.push(`kind must be one of: ${DIGEST_KINDS.join(", ")}`);
  if (!oneLine(digest.generatedBy)) errors.push("generatedBy is required");
  if (typeof digest.createdAt !== "string" || Number.isNaN(Date.parse(digest.createdAt))) errors.push("createdAt must be an ISO date-time");
  if (typeof digest.body !== "string" || !digest.body.trim()) errors.push("body is required");
  return errors;
}

export function formatDigest(digest) {
  const header = FRONT_MATTER_KEYS.map((key) => `${key}: ${digest[key]}`).join("\n");
  return `---\n${header}\n---\n\n${digest.body.trim()}\n`;
}

export function parseDigest(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { error: "no front matter" };
  const digest = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (FRONT_MATTER_KEYS.includes(key)) digest[key] = line.slice(separator + 1).trim();
  }
  digest.body = match[2].trim();
  const errors = validateDigest(digest);
  return errors.length ? { error: errors.join("; ") } : { digest };
}

function fileSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "digest";
}

// <period>-<kind>-<id>.md: sorts by period in a file browser, and the id
// keeps two people's recaps of the same period from colliding.
export function digestFilePath(memoryRoot, digest) {
  return path.join(digestsPath(memoryRoot), `${fileSegment(digest.period)}-${digest.kind}-${digest.id}.md`);
}

// Never overwrites: a digest is written once, like a journal line.
export function writeDigest(memoryRoot, digest) {
  const errors = validateDigest(digest);
  if (errors.length) throw new Error(`Invalid digest: ${errors.join("; ")}`);
  const file = digestFilePath(memoryRoot, digest);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, formatDigest(digest), { flag: "wx" });
  return file;
}

// Every digest under <memory>/digests/, skipping (and reporting) files that
// do not parse — a hand-edited or half-synced file must never hide the
// others. README.md, if someone adds one, is not a digest.
export function readDigests(memoryRoot) {
  const directory = digestsPath(memoryRoot);
  const result = { digests: [], malformed: [] };
  if (!existsSync(directory)) return result;
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".md") || name.toLowerCase() === "readme.md") continue;
    let parsed;
    try {
      parsed = parseDigest(readFileSync(path.join(directory, name), "utf8"));
    } catch (error) {
      parsed = { error: error instanceof Error ? error.message : String(error) };
    }
    if (parsed.digest) result.digests.push({ ...parsed.digest, file: name });
    else result.malformed.push({ file: name, reason: parsed.error });
  }
  return result;
}
