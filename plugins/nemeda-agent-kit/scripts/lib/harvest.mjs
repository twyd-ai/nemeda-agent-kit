// Unattended capture: a session ledger written by cheap, no-model hooks, and
// a harvester that resumes each closed session through its own host CLI to
// produce project-memory entries. See docs/memory-plan.md, "Unattended
// capture". This module never runs inside a hook's time budget itself — the
// ledger functions are the only part hooks call directly; harvesting is a
// separate, deliberately slower step (`nemeda-agent memory harvest`).
//
// This slice ships the ledger and the harvester core (resume one session,
// parse its output, file the entries, mark it harvested). Not yet
// implemented, and explicitly deferred (docs/memory-plan.md phase 1b-iii):
// the opportunistic detached spawn from SessionStart, `memory install`'s
// local scheduler, doctor checks, and the SessionStart context line. Also
// deferred: the "read the raw transcript" fallback for a session that can
// no longer be resumed — today a failed resume is recorded as a harvest
// error, never fabricated.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendEntry, createEntry, journalPath, resolveAuthorEmail, validateEntry } from "./memory.mjs";
import { parseBackendOutput } from "./slack.mjs";
import { loadEnvLocal } from "./env.mjs";
import { readWorkspaceContext, validateConfig } from "./workspace.mjs";

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_MAX_SESSIONS_PER_RUN = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

export function ledgerPath(root) {
  return path.join(root, ".nemeda", "state", "sessions.json");
}

export function readLedger(root) {
  try {
    return JSON.parse(readFileSync(ledgerPath(root), "utf8"));
  } catch {
    return {};
  }
}

function writeLedger(root, ledger) {
  const file = ledgerPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

// Same NEMEDA_AI_TOOL convention the (now superseded) Airtable session
// logger used (scripts/lib/hooks.mjs), so existing per-host .env.local
// settings keep meaning the same thing.
function detectTool(environment) {
  return /codex/i.test(environment.NEMEDA_AI_TOOL || "") ? "codex" : "claude";
}

// Called from the SessionStart and Stop ledger hooks: cheap, no model, just
// an upsert. `cwd` is recorded so a later harvest run can attribute the
// entry to the right repository even if it runs from elsewhere.
export function recordSessionActivity(root, { sessionId, cwd, environment = process.env } = {}) {
  if (!sessionId) return null;
  const ledger = readLedger(root);
  const now = new Date().toISOString();
  const existing = ledger[sessionId];
  ledger[sessionId] = {
    tool: detectTool(environment),
    model: environment.CLAUDE_MODEL || environment.NEMEDA_AI_MODEL || existing?.model || "unknown",
    cwd: cwd || existing?.cwd || root,
    startedAt: existing?.startedAt || now,
    lastActivity: now,
    harvestedAt: existing?.harvestedAt || null,
    harvestedEntryIds: existing?.harvestedEntryIds || [],
    harvestError: existing?.harvestError || null
  };
  writeLedger(root, ledger);
  return ledger[sessionId];
}

// Idle for long enough and not yet harvested. Sorted oldest-idle-first so a
// bounded `maxSessionsPerRun` makes forward progress instead of repeatedly
// picking the same handful.
export function closedSessions(root, { idleMinutes = DEFAULT_IDLE_MINUTES } = {}) {
  const ledger = readLedger(root);
  const cutoff = Date.now() - idleMinutes * 60 * 1000;
  return Object.entries(ledger)
    .filter(([, entry]) => !entry.harvestedAt && new Date(entry.lastActivity).getTime() <= cutoff)
    .map(([sessionId, entry]) => ({ sessionId, ...entry }))
    .sort((a, b) => new Date(a.lastActivity) - new Date(b.lastActivity));
}

export function markHarvested(root, sessionId, { entryIds = [], error = null } = {}) {
  const ledger = readLedger(root);
  if (!ledger[sessionId]) return null;
  ledger[sessionId] = { ...ledger[sessionId], harvestedAt: new Date().toISOString(), harvestedEntryIds: entryIds, harvestError: error };
  writeLedger(root, ledger);
  return ledger[sessionId];
}

// Mirrors resolveHookWorkspace in hooks.mjs (the Airtable equivalent):
// null means the hook has nothing to do (no workspace, invalid config, or no
// `memory` section) — never throws.
export function resolveMemoryHookWorkspace(event = {}, environment = process.env) {
  const start = event.cwd || environment.CLAUDE_PROJECT_DIR || process.cwd();
  const context = readWorkspaceContext(start);
  if (context.mode !== "configured" || !context.config?.memory) return null;
  if (validateConfig(context.config).some((issue) => issue.level === "error")) return null;
  loadEnvLocal(context.root, environment);
  return { root: context.root, config: context.config };
}

// One entry per host CLI capable of resuming a past session non-interactively.
// Both flags disable the tools a summarising pass never needs (see
// docs/memory-plan.md): the resumed session only has to read its own prior
// context and answer with JSON, never touch files or the network again.
const HOSTS = {
  claude: {
    label: "Claude Code",
    binary: (environment) => environment.NEMEDA_CLAUDE_BIN || "claude",
    resumeArgs: (sessionId, prompt) => ["-p", prompt, "--resume", sessionId, "--output-format", "json", "--tools", ""]
  },
  codex: {
    label: "Codex",
    binary: (environment) => environment.NEMEDA_CODEX_BIN || "codex",
    resumeArgs: (sessionId, prompt) => ["exec", "resume", sessionId, "--sandbox", "read-only", "--skip-git-repo-check", prompt]
  }
};

export function harvestHostNames() {
  return Object.keys(HOSTS);
}

const HARVEST_PROMPT = `You are producing project-memory entries for a session that already happened, not doing new work.
Segment the session by AI model if more than one model answered during it; one segment if only one did.
For each segment, produce one entry with: type (one of "ai-interaction", "decision", "finding", "meeting" — pick the one that best fits what the segment produced, "ai-interaction" for a typical coding session), title (one short line), summary (3-6 lines, internal audience, include context a teammate would need), and optionally clientSummary (sanitised, no internal references) and tags (a short array of free-text tags).
Reply with ONLY a JSON array of these objects. No prose before or after, no markdown code fences.`;

// Resumes one session through its host CLI and returns its raw answer text.
// NEMEDA_MEMORY_HARVESTER=1 on the child's environment is load-bearing, not
// decorative: it is what stops the resumed session's own SessionStart/Stop
// hooks from recording itself in the ledger or recursively harvesting.
function resumeSession(hostName, sessionId, environment, timeoutMs) {
  const host = HOSTS[hostName] || HOSTS.claude;
  const binary = host.binary(environment);
  const result = spawnSync(binary, host.resumeArgs(sessionId, HARVEST_PROMPT), {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...environment, NEMEDA_MEMORY_HARVESTER: "1" }
  });
  if (result.error) return { error: `${host.label} could not be started (${result.error.message}); is it on PATH?` };
  if (result.signal === "SIGTERM" && result.status === null) return { error: `${host.label} timed out after ${timeoutMs}ms.` };
  if (result.status !== 0) return { error: `${host.label} exited with status ${result.status}: ${String(result.stderr || "").slice(0, 500).trim()}` };
  const { text, error } = parseBackendOutput(hostName, result.stdout);
  if (error) return { error: `${host.label}: ${error}` };
  return { text };
}

function parseHarvestDrafts(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { error: `harvested output is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { drafts: Array.isArray(parsed) ? parsed : [parsed] };
}

// Resumes one session, files whatever valid entries it produces, and marks
// the session harvested either way (so a permanently-broken session does
// not get retried forever). A draft that fails entry validation is skipped
// and reported, not silently dropped and not fabricated into something
// valid.
export function harvestSession(root, config, session, { environment = process.env, dryRun = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resumed = resumeSession(session.tool, session.sessionId, environment, timeoutMs);
  if (resumed.error) {
    if (!dryRun) markHarvested(root, session.sessionId, { error: resumed.error });
    return { sessionId: session.sessionId, ok: false, created: [], errors: [resumed.error] };
  }
  const { drafts, error: parseError } = parseHarvestDrafts(resumed.text);
  if (parseError) {
    if (!dryRun) markHarvested(root, session.sessionId, { error: parseError });
    return { sessionId: session.sessionId, ok: false, created: [], errors: [parseError] };
  }
  const author = resolveAuthorEmail(root);
  if (!author) {
    const error = "git config user.email is not set; cannot attribute harvested entries.";
    if (!dryRun) markHarvested(root, session.sessionId, { error });
    return { sessionId: session.sessionId, ok: false, created: [], errors: [error] };
  }
  const memoryRoot = path.join(root, config.memory.project.path);
  const created = [];
  const errors = [];
  for (const draft of drafts) {
    const entry = createEntry({
      project: config.project.id,
      repository: config.repository?.id,
      type: draft?.type,
      title: draft?.title,
      summary: draft?.summary,
      clientSummary: draft?.clientSummary,
      tags: Array.isArray(draft?.tags) ? draft.tags : [],
      author,
      source: { kind: "session", sessionId: session.sessionId, tool: session.tool }
    });
    const validationErrors = validateEntry(entry);
    if (validationErrors.length) {
      errors.push(`draft rejected (${validationErrors.join("; ")}): ${JSON.stringify(draft).slice(0, 200)}`);
      continue;
    }
    if (!dryRun) appendEntry(memoryRoot, entry);
    created.push(entry);
  }
  if (!dryRun) markHarvested(root, session.sessionId, { entryIds: created.map((entry) => entry.id), error: errors.length ? errors.join(" | ") : null });
  return { sessionId: session.sessionId, ok: created.length > 0, created, errors, journalPath: created.length ? journalPath(memoryRoot, author) : null };
}

// Every closed, unharvested session in the ledger, oldest first, bounded by
// maxSessionsPerRun (config or the default) so one run makes progress
// without an unbounded number of model calls.
export function harvestClosedSessions(root, config, options = {}) {
  const harvestConfig = config.memory.harvest || {};
  const idleMinutes = options.idleMinutes ?? harvestConfig.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  const maxSessionsPerRun = options.maxSessionsPerRun ?? harvestConfig.maxSessionsPerRun ?? DEFAULT_MAX_SESSIONS_PER_RUN;
  const sessions = closedSessions(root, { idleMinutes }).slice(0, maxSessionsPerRun);
  return sessions.map((session) => harvestSession(root, config, session, options));
}

// Harvests one session by id regardless of ledger idle state — for manual
// use (`memory harvest --session ID`) and tests. Falls back to "claude" when
// the session is not (yet) in the ledger.
export function harvestSessionById(root, config, sessionId, options = {}) {
  const ledger = readLedger(root);
  const session = ledger[sessionId] ? { sessionId, ...ledger[sessionId] } : { sessionId, tool: "claude" };
  return harvestSession(root, config, session, options);
}
