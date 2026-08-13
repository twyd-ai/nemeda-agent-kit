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

function listMergedPrs(repo, lookbackDays, environment) {
  let parsed;
  try {
    const output = execFileSync(
      "gh",
      ["pr", "list", "--repo", repo, "--state", "merged", "--limit", "60", "--json", "number,url,body,mergedAt"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: environment }
    );
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const cutoff = Date.now() - lookbackDays * 86_400_000;
  return parsed.filter((pr) => pr.mergedAt && new Date(pr.mergedAt).getTime() >= cutoff);
}

export async function reconcileMergedPrs(event, environment = process.env, options = {}) {
  const workspace = resolveHookWorkspace(event, environment);
  if (!workspace?.airtable?.tasks) return { skipped: "no-airtable-tasks" };
  if (syncDisabled(environment)) return { skipped: "disabled" };
  if (!options.force && reconcileThrottled(workspace.root)) return { skipped: "throttled" };

  const { baseId, tasks } = workspace.airtable;
  const repoOverride = (environment.PR_RECONCILE_REPO || "").split(",").map((repo) => repo.trim()).filter(Boolean);
  const repos = repoOverride.length ? repoOverride : workspace.airtable.reconcileRepos || [];
  if (repos.length === 0) return { skipped: "no-reconcile-repos" };
  const lookbackDays = Number.parseInt(environment.PR_RECONCILE_LOOKBACK_DAYS || "", 10) || workspace.airtable.lookbackDays || 21;

  // recordId -> merged PR url (last one wins if a task has several PRs).
  const targets = {};
  for (const repo of repos) {
    for (const pr of listMergedPrs(repo, lookbackDays, environment)) {
      for (const recordId of extractRecordIds(pr.body, tasks.tableId)) {
        targets[recordId] = pr.url || "";
      }
    }
  }

  if (syncDryRun(environment)) {
    stampReconcile(workspace.root);
    return { dryRun: true, repos, targets, status: tasks.statusDone };
  }
  const apiKey = environment.AIRTABLE_API_KEY || "";
  if (!apiKey) return { skipped: "no-api-key" };

  const moved = [];
  const errors = [];
  for (const [recordId, prUrl] of Object.entries(targets)) {
    try {
      const record = await getRecord(apiKey, baseId, tasks.tableId, recordId);
      if (record.fields?.[tasks.statusField] === tasks.statusDone) continue; // idempotent
      const fields = { [tasks.statusField]: tasks.statusDone };
      if (prUrl) {
        Object.assign(fields, noteWithPr(tasks.notesField, record.fields?.[tasks.notesField], `Merged (${formatShortDate()}): ${prUrl}`));
      }
      await patchRecord(apiKey, baseId, tasks.tableId, recordId, fields);
      moved.push(recordId);
    } catch (error) {
      errors.push(`${recordId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  stampReconcile(workspace.root);
  const systemMessage = moved.length ? `Airtable: ${moved.length} merged task(s) -> "${tasks.statusDone}"` : undefined;
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
