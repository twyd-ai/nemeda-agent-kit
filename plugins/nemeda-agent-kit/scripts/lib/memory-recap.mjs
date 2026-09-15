// `memory recap`, `memory close`, and `memory reopen` (docs/memory-plan.md,
// flows 6–7, phase 3b). A digest's body is either handed over on stdin (an
// agent already in a session wrote it) or written by the operator's own host
// CLI — claude or codex, exactly like the harvester, so there is no API key
// and the cost lands on the person who asked for it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { latestRevisions, readAllJournals, resolveAuthorEmail } from "./memory.mjs";
import { centralSettings } from "./memory-central.mjs";
import { createDigest, validateDigest, writeDigest } from "./memory-digest.mjs";
import { syncToCentral } from "./memory-sync.mjs";
import { parseBackendOutput } from "./slack.mjs";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_ENTRIES_IN_PROMPT = 400;
const MAX_SUMMARY_CHARS = 1500;

// A fresh, tool-less, non-interactive turn; the prompt goes in on stdin so a
// long period never hits a command-line length limit (Windows: 32 K).
const HOSTS = {
  claude: {
    label: "Claude Code",
    binary: (environment) => environment.NEMEDA_CLAUDE_BIN || "claude",
    args: ["-p", "--output-format", "json", "--tools", ""]
  },
  codex: {
    label: "Codex",
    binary: (environment) => environment.NEMEDA_CODEX_BIN || "codex",
    args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"]
  }
};

export function recapHostNames() {
  return Object.keys(HOSTS);
}

// Same NEMEDA_AI_TOOL convention as the harvester's ledger.
export function defaultRecapHost(environment = process.env) {
  return /codex/i.test(environment.NEMEDA_AI_TOOL || "") ? "codex" : "claude";
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

// YYYY, YYYY-Qn, or YYYY-MM as an inclusive { since, until } date range;
// null for anything else.
export function periodRange(period) {
  const text = String(period || "").trim();
  let match = /^(\d{4})$/.exec(text);
  if (match) return { since: `${match[1]}-01-01`, until: `${match[1]}-12-31` };
  match = /^(\d{4})-Q([1-4])$/i.exec(text);
  if (match) {
    const year = Number(match[1]);
    const first = (Number(match[2]) - 1) * 3 + 1;
    return { since: `${year}-${pad(first)}-01`, until: `${year}-${pad(first + 2)}-${lastDayOfMonth(year, first + 2)}` };
  }
  match = /^(\d{4})-(\d{2})$/.exec(text);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    return { since: `${year}-${pad(month)}-01`, until: `${year}-${pad(month)}-${lastDayOfMonth(year, month)}` };
  }
  return null;
}

// Latest revisions that are reviewed, optionally within a date range,
// oldest first — a digest is only ever built from confirmed memory.
export function recapEntries(entries, { since, until } = {}) {
  return latestRevisions(entries)
    .filter((entry) => entry.status === "reviewed")
    .filter((entry) => (!since || entry.date >= since) && (!until || entry.date <= until))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}

export function buildDigestPrompt({ projectName, projectId, period, kind, entries }) {
  const shown = entries.slice(-MAX_ENTRIES_IN_PROMPT);
  const closing = kind === "closure";
  const lines = shown.map((entry) => {
    const summary = entry.summary.length > MAX_SUMMARY_CHARS ? `${entry.summary.slice(0, MAX_SUMMARY_CHARS)}…` : entry.summary;
    const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
    return `- [${entry.date}] ${entry.type} — ${entry.title} (${entry.author})${tags}\n  ${summary.replace(/\n+/g, "\n  ")}`;
  });
  return [
    `You are writing ${closing ? "the closing document" : `a recap for ${period}`} of the project "${projectName}" (${projectId}), from its reviewed project-memory entries below. Do not do any other work.`,
    `Write Markdown with exactly these sections: ## Decided, ## Learned, ## Still open${closing ? ", ## Where things stand" : ""}. Merge related entries, keep the reasons behind decisions, name people only when it matters, and say so plainly when a section has nothing. Write in the language most of the entries use.`,
    "Reply with ONLY the Markdown document: no preamble, no code fences.",
    ...(entries.length > shown.length ? [`(Only the latest ${shown.length} of ${entries.length} entries are listed.)`] : []),
    "",
    "Entries:",
    ...lines
  ].join("\n");
}

// Runs one tool-less turn on the host CLI with the prompt on stdin.
// NEMEDA_MEMORY_HARVESTER=1 keeps that turn's own hooks from recording it in
// the session ledger or starting a harvest or a sync (see memory-ledger.mjs).
export function generateDigestBody(prompt, { host = "claude", environment = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const spec = HOSTS[host];
  if (!spec) return { error: `Unknown host "${host}"; use ${recapHostNames().join(" or ")}.` };
  const result = spawnSync(spec.binary(environment), spec.args, {
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...environment, NEMEDA_MEMORY_HARVESTER: "1" }
  });
  if (result.error) return { error: `${spec.label} could not be started (${result.error.message}); is it on PATH?` };
  if (result.signal === "SIGTERM" && result.status === null) return { error: `${spec.label} timed out after ${timeoutMs}ms.` };
  if (result.status !== 0) return { error: `${spec.label} exited with status ${result.status}: ${String(result.stderr || "").slice(0, 500).trim()}` };
  const { text, error } = parseBackendOutput(host, result.stdout);
  if (error) return { error: `${spec.label}: ${error}` };
  return { text: text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim() };
}

function centralProjectId(config) {
  return config.memory?.central?.projectId || config.project.id;
}

function today(now) {
  return now().toISOString().slice(0, 10);
}

// Builds (does not write) a digest: the body from stdin when given,
// otherwise generated from `entries` by the host CLI.
function prepareDigest(root, config, { kind, period, body, host, environment, entries }) {
  const author = resolveAuthorEmail(root);
  if (!author) throw new Error("git config user.email is not set; the kit needs it to sign the digest.");
  let text = typeof body === "string" ? body.trim() : "";
  let generatedWith = null;
  if (!text) {
    if (!entries.length) {
      throw new Error(`No reviewed entries ${kind === "closure" ? "in this project" : `in ${period}`} to ${kind === "closure" ? "close with" : "recap"}; review some first (\`nemeda-agent memory review\`), or pass the digest on stdin.`);
    }
    const answer = generateDigestBody(
      buildDigestPrompt({ projectName: config.project.name || config.project.id, projectId: config.project.id, period, kind, entries }),
      { host, environment }
    );
    if (answer.error) throw new Error(answer.error);
    text = answer.text;
    generatedWith = host;
  }
  const digest = createDigest({ project: centralProjectId(config), period, kind, body: text, generatedBy: author });
  const errors = validateDigest(digest);
  if (errors.length) throw new Error(`Invalid digest: ${errors.join("; ")}`);
  return { digest, generatedWith };
}

// A recap of one period's reviewed entries, written under <memory>/digests/.
// Works without central memory; the next `memory sync` promotes it when
// memory.central is configured.
export function recapProject(root, config, { period, body, host = "claude", dryRun = false, environment = process.env } = {}) {
  const range = periodRange(period);
  if (!range) throw new Error(`Unknown period "${period}"; use YYYY, YYYY-Qn, or YYYY-MM.`);
  const memoryRoot = path.join(root, config.memory.project.path);
  const entries = recapEntries(readAllJournals(memoryRoot).entries, range);
  const { digest, generatedWith } = prepareDigest(root, config, { kind: "recap", period: String(period).toUpperCase().replace(/-Q/, "-Q"), body, host, environment, entries });
  const file = dryRun ? null : writeDigest(memoryRoot, digest);
  return { digest, file, entries: entries.length, generatedWith, dryRun };
}

function requireService(config, command) {
  const settings = centralSettings(config);
  if (!settings?.baseUrl) throw new Error(`memory ${command} changes the project's status in central memory, so it needs memory.central.mcpUrl.`);
  return settings;
}

// The last step of a project: a closure digest covering its whole reviewed
// history, then one sync of every author's entries and digests, so central
// memory holds everything and projects_status turns the project inactive.
export async function closeProject(root, config, { body, host = "claude", dryRun = false, environment = process.env, fetchImpl, now = () => new Date() } = {}) {
  requireService(config, "close");
  const memoryRoot = path.join(root, config.memory.project.path);
  const entries = recapEntries(readAllJournals(memoryRoot).entries);
  const { digest, generatedWith } = prepareDigest(root, config, { kind: "closure", period: today(now), body, host, environment, entries });
  if (dryRun) return { digest, file: null, entries: entries.length, generatedWith, dryRun, sync: null };
  const file = writeDigest(memoryRoot, digest);
  const sync = await syncToCentral(root, config, { environment, fetchImpl, all: true, now });
  return { digest, file, entries: entries.length, generatedWith, dryRun, sync };
}

// Undoes a close: one more digest (kind reopen), never an update.
export async function reopenProject(root, config, { body, dryRun = false, environment = process.env, fetchImpl, now = () => new Date() } = {}) {
  requireService(config, "reopen");
  const author = resolveAuthorEmail(root);
  const date = today(now);
  const text = typeof body === "string" && body.trim() ? body : `Reopened by ${author || "unknown"} on ${date}.`;
  const { digest } = prepareDigest(root, config, { kind: "reopen", period: date, body: text, environment, entries: [] });
  if (dryRun) return { digest, file: null, dryRun, sync: null };
  const memoryRoot = path.join(root, config.memory.project.path);
  const file = writeDigest(memoryRoot, digest);
  const sync = await syncToCentral(root, config, { environment, fetchImpl, all: true, now });
  return { digest, file, dryRun, sync };
}
