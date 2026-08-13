// Logic behind the three Airtable automation hooks. Everything here follows
// the same defensive contract as the workspace scripts it replaces: never
// throw out of the public functions, never block the calling tool, and never
// touch Airtable when the input is ambiguous.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createRecord,
  extractPrUrl,
  extractRecordIds,
  formatShortDate,
  getRecord,
  noteWithPr,
  patchRecord
} from "./airtable.mjs";
import { flagEnabled, loadEnvLocal } from "./env.mjs";
import { readWorkspaceContext, validateConfig } from "./workspace.mjs";

export const RECONCILE_INTERVAL_HOURS = 12;
const LOGGED_SESSIONS_LIMIT = 200;

export function stateDirectory(root) {
  return path.join(root, ".nemeda", "state");
}

// Loads workspace config + .env.local for a hook event; null means the hook
// has nothing to do here (no workspace, invalid config, or no airtable block).
export function resolveHookWorkspace(event = {}, environment = process.env) {
  const start = event.cwd || environment.CLAUDE_PROJECT_DIR || process.cwd();
  const context = readWorkspaceContext(start);
  if (context.mode !== "configured" || !context.config?.airtable) return null;
  if (validateConfig(context.config).some((issue) => issue.level === "error")) return null;
  loadEnvLocal(context.root, environment);
  return { root: context.root, config: context.config, airtable: context.config.airtable };
}

function syncDisabled(environment) {
  return flagEnabled("PR_AIRTABLE_SYNC_DISABLED", environment);
}

function syncDryRun(environment) {
  return flagEnabled("PR_AIRTABLE_SYNC_DRYRUN", environment);
}

// Fast-path only: gives immediate feedback when the agent itself runs
// `gh pr create` from Bash. It does NOT cover PRs opened from the GitHub web
// UI, another machine, or without `gh` installed — reconcilePrs (SessionStart)
// is what makes the sync authoritative by reading GitHub's PR list directly.
export async function prSyncFromEvent(event, environment = process.env) {
  if (event?.tool_name !== "Bash") return { skipped: "not-bash" };
  const command = event?.tool_input?.command || "";
  if (!command.includes("gh pr create")) return { skipped: "not-pr-create" };

  const workspace = resolveHookWorkspace(event, environment);
  if (!workspace?.airtable?.tasks) return { skipped: "no-airtable-tasks" };
  if (syncDisabled(environment)) return { skipped: "disabled" };

  const { baseId, tasks } = workspace.airtable;
  const recordIds = extractRecordIds(command, tasks.tableId);
  if (recordIds.length === 0) return { skipped: "no-record-ids" };

  const prUrl = extractPrUrl(JSON.stringify(event.tool_response || ""), command);
  if (!prUrl) return { skipped: "no-pr-url" }; // creation likely failed; leave Airtable alone.

  const noteLine = `PR (${formatShortDate()}): ${prUrl}`;
  if (syncDryRun(environment)) {
    return { dryRun: true, recordIds, prUrl, status: tasks.statusInProgress, noteLine };
  }
  const apiKey = environment.AIRTABLE_API_KEY || "";
  if (!apiKey) return { skipped: "no-api-key", warning: `${workspace.root}/.env.local has no AIRTABLE_API_KEY.` };

  const updated = [];
  const errors = [];
  for (const recordId of recordIds) {
    try {
      const record = await getRecord(apiKey, baseId, tasks.tableId, recordId);
      const fields = {
        [tasks.statusField]: tasks.statusInProgress,
        ...noteWithPr(tasks.notesField, record.fields?.[tasks.notesField], noteLine)
      };
      await patchRecord(apiKey, baseId, tasks.tableId, recordId, fields);
      updated.push(recordId);
    } catch (error) {
      errors.push(`${recordId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const systemMessage = updated.length
    ? `Airtable: ${updated.length} task(s) -> "${tasks.statusInProgress}", linked ${prUrl}`
    : undefined;
  return { updated, errors, prUrl, systemMessage };
}

function reconcileStampPath(root) {
  return path.join(stateDirectory(root), "pr-reconcile-stamp");
}

function reconcileThrottled(root, now = new Date()) {
  const stampPath = reconcileStampPath(root);
  if (!existsSync(stampPath)) return false;
  const stamp = new Date(readFileSync(stampPath, "utf8").trim());
  if (Number.isNaN(stamp.getTime())) return false;
  return now.getTime() - stamp.getTime() < RECONCILE_INTERVAL_HOURS * 3_600_000;
}

function stampReconcile(root, now = new Date()) {
  try {
    mkdirSync(stateDirectory(root), { recursive: true });
    writeFileSync(reconcileStampPath(root), now.toISOString());
  } catch {
    // Best effort; a missing stamp only means an extra reconcile run later.
  }
}

// Lists PRs for a repo in the given state via `gh` (works no matter how the
// PR was opened — web UI, another machine, VS Code — because it reads GitHub
// itself rather than observing a local command).
function listPrs(repo, state, environment) {
  try {
    const output = execFileSync(
      "gh",
      ["pr", "list", "--repo", repo, "--state", state, "--limit", "60", "--json", "number,url,body,mergedAt,createdAt"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: environment }
    );
    return JSON.parse(output);
  } catch {
    return []; // gh missing/unauthenticated, or repo unreachable: skip quietly.
  }
}

function withinLookback(pr, dateField, lookbackDays) {
  const value = pr[dateField];
  if (!value) return false;
  return Date.now() - new Date(value).getTime() <= lookbackDays * 86_400_000;
}

// Authoritative status sync: derives Airtable task status from GitHub's own
// PR list (open -> in progress, merged -> done) instead of relying on the
// agent having run `gh pr create` from a local Bash tool. That local-command
// hook (prSyncFromEvent) is only a fast-path for immediate feedback; this
// reconcile also catches PRs opened from the GitHub web UI or another
// machine, which never fire a PostToolUse event here.
export async function reconcilePrs(event, environment = process.env, options = {}) {
  const workspace = resolveHookWorkspace(event, environment);
  if (!workspace?.airtable?.tasks) return { skipped: "no-airtable-tasks" };
  if (syncDisabled(environment)) return { skipped: "disabled" };
  if (!options.force && reconcileThrottled(workspace.root)) return { skipped: "throttled" };

  const { baseId, tasks } = workspace.airtable;
  const repoOverride = (environment.PR_RECONCILE_REPO || "").split(",").map((repo) => repo.trim()).filter(Boolean);
  const repos = repoOverride.length ? repoOverride : workspace.airtable.reconcileRepos || [];
  if (repos.length === 0) return { skipped: "no-reconcile-repos" };
  const lookbackDays = Number.parseInt(environment.PR_RECONCILE_LOOKBACK_DAYS || "", 10) || workspace.airtable.lookbackDays || 21;

  // recordId -> PR url. Merged wins over open when a task has PRs in both
  // states (Done is scanned second and overwrites the in-progress target).
  const inProgressTargets = {};
  const doneTargets = {};
  for (const repo of repos) {
    // Open PRs stay relevant regardless of age; --limit already bounds the scan.
    for (const pr of listPrs(repo, "open", environment)) {
      for (const recordId of extractRecordIds(pr.body, tasks.tableId)) inProgressTargets[recordId] = pr.url || "";
    }
    // Merges are bounded by lookbackDays so old, already-reconciled merges
    // aren't re-fetched from Airtable on every session.
    for (const pr of listPrs(repo, "merged", environment)) {
      if (!withinLookback(pr, "mergedAt", lookbackDays)) continue;
      for (const recordId of extractRecordIds(pr.body, tasks.tableId)) doneTargets[recordId] = pr.url || "";
    }
  }
  for (const recordId of Object.keys(doneTargets)) delete inProgressTargets[recordId];

  if (syncDryRun(environment)) {
    stampReconcile(workspace.root);
    return { dryRun: true, repos, inProgressTargets, doneTargets, statusInProgress: tasks.statusInProgress, statusDone: tasks.statusDone };
  }
  const apiKey = environment.AIRTABLE_API_KEY || "";
  if (!apiKey) return { skipped: "no-api-key" };

  const moved = [];
  const errors = [];
  const applyTransition = async (recordId, prUrl, status, notePrefix) => {
    try {
      const record = await getRecord(apiKey, baseId, tasks.tableId, recordId);
      const currentStatus = record.fields?.[tasks.statusField];
      // Never move a completed task backwards, and skip no-op transitions.
      if (currentStatus === tasks.statusDone || currentStatus === status) return;
      const fields = { [tasks.statusField]: status };
      if (prUrl) {
        Object.assign(fields, noteWithPr(tasks.notesField, record.fields?.[tasks.notesField], `${notePrefix} (${formatShortDate()}): ${prUrl}`));
      }
      await patchRecord(apiKey, baseId, tasks.tableId, recordId, fields);
      moved.push({ recordId, status });
    } catch (error) {
      errors.push(`${recordId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const [recordId, prUrl] of Object.entries(inProgressTargets)) {
    await applyTransition(recordId, prUrl, tasks.statusInProgress, "PR");
  }
  for (const [recordId, prUrl] of Object.entries(doneTargets)) {
    await applyTransition(recordId, prUrl, tasks.statusDone, "Merged");
  }

  stampReconcile(workspace.root);
  const systemMessage = moved.length
    ? `Airtable: ${moved.length} task(s) updated (${moved.map((entry) => entry.status).join(", ")}).`
    : undefined;
  return { moved, errors, systemMessage };
}

function loggedSessionsPath(root) {
  return path.join(stateDirectory(root), "logged-sessions");
}

function sessionAlreadyLogged(root, sessionId) {
  if (!sessionId) return false;
  const filePath = loggedSessionsPath(root);
  return existsSync(filePath) && readFileSync(filePath, "utf8").split("\n").includes(sessionId);
}

function markSessionLogged(root, sessionId) {
  if (!sessionId) return;
  try {
    mkdirSync(stateDirectory(root), { recursive: true });
    appendFileSync(loggedSessionsPath(root), `${sessionId}\n`);
    const lines = readFileSync(loggedSessionsPath(root), "utf8").split("\n").filter(Boolean);
    if (lines.length > LOGGED_SESSIONS_LIMIT) {
      writeFileSync(loggedSessionsPath(root), `${lines.slice(-LOGGED_SESSIONS_LIMIT).join("\n")}\n`);
    }
  } catch {
    // Best effort; duplicates are visible and harmless in the Pending view.
  }
}

function runGit(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export async function logSessionFromEvent(event, environment = process.env) {
  const workspace = resolveHookWorkspace(event, environment);
  const knowledgeLog = workspace?.airtable?.knowledgeLog;
  if (!knowledgeLog) return { skipped: "no-knowledge-log" };
  // Opt-in: the recommended flow is the reviewed /klog path, not auto-logging.
  if (!flagEnabled("KNOWLEDGE_LOG_AUTO", environment)) return { skipped: "not-opted-in" };
  const apiKey = environment.AIRTABLE_API_KEY || "";
  if (!apiKey) return { skipped: "no-api-key" };

  const sessionId = event?.session_id || "";
  if (sessionAlreadyLogged(workspace.root, sessionId)) return { skipped: "already-logged" };

  const personId = environment.AIRTABLE_PERSON_ID
    || knowledgeLog.people?.[runGit(workspace.root, ["config", "user.email"])]
    || "";
  const branch = runGit(workspace.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const lastCommit = runGit(workspace.root, ["log", "--oneline", "-1"]);
  const gitContext = [branch && `branch: ${branch}`, lastCommit].filter(Boolean).join(" | ");

  const now = new Date();
  const fields = {
    Entry: `${environment.NEMEDA_AI_TOOL || "Claude Code"} — ${formatShortDate(now)}`,
    Date: now.toISOString().slice(0, 10),
    Type: "AI Interaction",
    "AI Tool": environment.NEMEDA_AI_TOOL || "Claude Code",
    "AI Model": environment.CLAUDE_MODEL || environment.NEMEDA_AI_MODEL || "unknown",
    Status: "Pending",
    Summary: gitContext ? `[Pendiente de completar]\n\nContexto git: ${gitContext}` : "[Pendiente de completar]"
  };
  if (personId) fields.Person = [{ id: personId }];

  try {
    const record = await createRecord(apiKey, knowledgeLog.baseId || workspace.airtable.baseId, knowledgeLog.tableId, fields);
    markSessionLogged(workspace.root, sessionId);
    return { created: record.id, systemMessage: `Knowledge Log: created ${record.id} (complete the Summary in Airtable).` };
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)] };
  }
}
