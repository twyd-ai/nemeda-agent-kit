#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { setupWorkspace } from "./lib/setup.mjs";
import { askLocally, forgetServer, initSlack, installLaunchAgent, joinRelay, leaveRelay, listServers, slackDoctor, useServer } from "./lib/slack-ops.mjs";
import { manifestPath } from "./lib/slack.mjs";
import {
  defaultWorkspaceDirectory,
  formatContextForHook,
  initializeWorkspace,
  readWorkspaceContext,
  workspaceDoctor
} from "./lib/workspace.mjs";

function parseArguments(argv) {
  const [command = "help", ...rest] = argv;
  const options = { profiles: [] };
  if (["slack", "airtable", "cursor", "meeting", "memory"].includes(command) && rest[0] && !rest[0].startsWith("-")) options.subcommand = rest.shift();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--json") options.json = true;
    else if (value === "--cwd") options.cwd = rest[++index];
    else if (value === "--project-id") options.projectId = rest[++index];
    else if (value === "--project-name") options.projectName = rest[++index];
    else if (value === "--role") options.role = rest[++index];
    else if (value === "--profile") options.profiles.push(rest[++index]);
    else if (value === "--workspace") options.workspace = true;
    else if (value === "--workspace-id") options.workspaceId = rest[++index];
    else if (value === "--name") options.projectName = rest[++index];
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--as") options.as = rest[++index];
    else if (value === "--server") options.server = rest[++index];
    else if (value === "--forget") options.forget = rest[++index];
    else if (value === "--title") options.title = rest[++index];
    else if (value === "--engine") options.engine = rest[++index];
    else if (value === "--type") options.type = rest[++index];
    else if (value === "--tags") options.tags = rest[++index].split(",").map((tag) => tag.trim()).filter(Boolean);
    else if (value === "--author") options.author = rest[++index];
    else if (value === "--since") options.since = rest[++index];
    else if (value === "--pending") options.pending = true;
    else if (value === "--all") options.all = true;
    else if (value === "--session") options.sessionId = rest[++index];
    else if (value === "--previous") options.previous = true;
    else if (value === "--rebuild") options.rebuild = true;
    else if (value === "--interval") options.interval = rest[++index];
    else if (value === "--model") options.model = rest[++index];
    else if (value === "--obs") options.obs = true;
    else if (value === "--yes" || value === "-y") options.yes = true;
    else if (value === "--no-notes") options.skipNotes = true;
    else if (value === "--interval") options.interval = Number(rest[++index]);
    else if (value === "--once") options.once = true;
    else if (value === "--force") options.force = true;
    else if (value === "--via") options.via = rest[++index];
    else if (value === "--central") options.central = true;
    else if (value === "--period") options.period = rest[++index];
    else if (value === "--host") options.host = rest[++index];
    else if (value === "--base") options.base = rest[++index];
    else if (value === "--table") options.table = rest[++index];
    else if (value === "--team-table") options.teamTable = rest[++index];
    else if (value === "--alias") (options.aliases ||= []).push(rest[++index]);
    else if (value === "--unattended") options.unattended = true;
    else if (command === "meeting" && options.subcommand === "notes" && !options.folder && !value.startsWith("-")) options.folder = value;
    else if (command === "meeting" && options.subcommand === "process" && !options.file && !value.startsWith("-")) options.file = value;
    else if (command === "memory" && options.subcommand === "search" && !options.query && !value.startsWith("-")) options.query = value;
    else if (command === "memory" && options.subcommand === "review" && !options.reviewId && !value.startsWith("-")) options.reviewId = value;
    else if (command === "memory" && options.subcommand === "trust" && !options.trustUrl && !value.startsWith("-")) options.trustUrl = value;
    else if (command === "slack" && ["ask", "join", "server"].includes(options.subcommand) && !options.question) options.question = value;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return { command, options };
}

function print(value, asJson = false) {
  if (asJson || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function help() {
  return `Nemeda Agent Kit

Usage:
  nemeda-agent init [--cwd PATH] [--project-id ID] [--project-name NAME]
                    [--role ROLE] [--profile PROFILE ...] [--workspace]
  nemeda-agent setup [--cwd PATH] [--json] [--dry-run]
  nemeda-agent context [--cwd PATH] [--json]
  nemeda-agent doctor [--cwd PATH] [--json]
  nemeda-agent airtable init --name NAME --workspace-id wspXXX [--json]
  nemeda-agent cursor init [--cwd PATH] [--dry-run] [--json]
  nemeda-agent slack <init|doctor|run|install|manifest> [--json]
  nemeda-agent slack ask "question" [--cwd PATH]
  nemeda-agent slack join <https://relay-url> [--as NAME] | leave | relay
  nemeda-agent slack server [NAME] [--forget NAME]
  nemeda-agent slack run [--server NAME]      # one runner per relay, side by side
  nemeda-agent meeting process [FILE] [--title TITLE] [--engine NAME] [--no-notes] [--dry-run] [--json]
  nemeda-agent meeting notes FOLDER [--force] [--dry-run] [--json]
  nemeda-agent meeting watch [--interval SECONDS] [--once] [--engine NAME] [--no-notes]
  nemeda-agent meeting install | uninstall [--interval SECONDS] [--dry-run] [--json]
  nemeda-agent meeting list [--json]
  nemeda-agent meeting doctor [--engine NAME] [--json]
  nemeda-agent meeting setup [--obs] [--model TIER] [--engine NAME] [--yes] [--dry-run] [--json]
  nemeda-agent memory add [--type TYPE] [--title TITLE] [--tags a,b] [--json]
  nemeda-agent memory list [--pending] [--type TYPE] [--author EMAIL] [--since DATE] [--json]
  nemeda-agent memory search "query" [--central] [--pending] [--type TYPE] [--json]
  nemeda-agent memory review [ID] [--all] [--json]
  nemeda-agent memory harvest [--session ID] [--dry-run] [--json]
  nemeda-agent memory index [--rebuild] [--json]
  nemeda-agent memory install [--interval MINUTES] [--dry-run] [--json]
  nemeda-agent memory uninstall [--dry-run] [--json]
  nemeda-agent memory sync [--all] [--via service|psql] [--dry-run] [--json]
  nemeda-agent memory doctor [--json]
  nemeda-agent memory recap --period PERIOD [--host claude|codex] [--dry-run] [--json]
  nemeda-agent memory close [--host claude|codex] [--dry-run | --yes] [--json]
  nemeda-agent memory reopen [--dry-run | --yes] [--json]
  nemeda-agent memory trust [URL]
  nemeda-agent memory import-airtable [--base appXXX] [--table NAME] [--team-table NAME] [--alias FROM=TO ...] [--dry-run] [--json]

Commands:
  init     Create missing .nemeda/agent-kit.json and AGENTS.md safely.
           --workspace scans nested Git repositories into a workspace config.
  setup    Assemble machine-local pieces: Drive symlinks, declared repository
           clones, the .env.local template, and .gitignore entries. Idempotent;
           never overwrites existing files.
  context  Show the normalized repository context.
  doctor   Run read-only configuration, Drive, Airtable, and host diagnostics.
  cursor   Generate the machine-local Cursor adapter for this workspace:
           .cursor/mcp.json (workspace-context MCP), an always-on rule, and a
           slash command per kit skill. Also runs automatically inside
           \`setup\` when Cursor is installed. Generated paths are gitignored.
  airtable Provision the canonical project base (Backlog, Team, Knowledge Log)
           through the Airtable API and print the config snippet to paste into
           .nemeda/agent-kit.json. Reads AIRTABLE_API_KEY from the environment
           or the workspace .env.local.
  slack    Run the personal Slack bridge on this machine.
             init      create ~/.nemeda/runner.json and the token file
             doctor    check registry, routing, tokens, and channel membership
             run       start the Socket Mode runner in the foreground
             install   install a macOS LaunchAgent so it starts at login
             manifest  print the Slack app manifest to create your own app
             ask       answer one question locally, exactly as Slack would
             join      pair this machine with the team relay (one Slack app)
             leave     forget the relay pairing on this machine
             relay     run the team relay server (needs the Slack tokens)
             server    list relays, or switch which one this runner uses
  meeting  Turn finished meeting recordings into filed transcripts (needs a
           \`meetings\` section in .nemeda/agent-kit.json; see
           docs/meeting-capture-plan.md). NEMEDA_MEETINGS_ROLE in .env.local
           splits the work across machines: recorder (hands recordings to
           meetings.inbox), transcriber (drains the inbox), full (default).
             process   transcribe every ready recording in the watched folder
                       (OBS's recording folder, or NEMEDA_MEETINGS_WATCH), or
                       one FILE; files <date>-<slug>/ under meetings.transcripts
             list      show ready, in-progress, and already transcribed recordings
             notes     write the notes (Summary, Decisions, Action items, Open
                       questions) for an existing transcript folder with your local
                       claude or codex, and log the meeting to the project memory
             doctor    machine capability, engine selection (apple-speech on
                       macOS 26 + Apple Silicon, whisper.cpp elsewhere), model,
                       ffmpeg, recordings folder, Drive folders, backlog
             setup     install the missing tools (brew/winget, on confirmation),
                       download the recommended whisper model, and record the
                       choices in .env.local; --obs also installs OBS Studio
             watch     run \`process\` for this machine's role every 30 s in the
                       foreground (--once for a single pass)
             install   register the watch loop as a user service that starts at
                       login (launchd on macOS, systemd --user on Linux, a Task
                       Scheduler command on Windows); uninstall removes it
  memory   Read and write project memory (needs a \`memory\` section in
           .nemeda/agent-kit.json; see docs/memory-plan.md).
             add       append one entry; the summary is read from stdin (or,
                       with --json, the whole entry as JSON on stdin), the
                       author is NEMEDA_MEMORY_AUTHOR (environment or
                       ~/.nemeda/.env.local) or else \`git config user.email\`
             list      list entries, newest first
             search    full-text search across every author's journal;
                       --central searches central memory through the
                       memory service instead
             review    no ID: list your own pending entries (--all for
                       everyone's, browsing only); with ID: complete one of
                       your own pending entries, optionally with changes as
                       JSON on stdin. Only the original author can review an
                       entry — a journal has exactly one writer by design.
             harvest   resume every closed, un-summarised session recorded by
                       the SessionStart/Stop hooks (or one --session ID) and
                       log what it produced. Needs MEMORY_HARVEST=true in
                       .env.local (it invokes claude/codex and costs
                       tokens); NEMEDA_CLAUDE_BIN / NEMEDA_CODEX_BIN override
                       the binary used.
             index     show the machine-local query index (.nemeda/state/
                       memory.sqlite: engine, entry count, up to date or
                       not); --rebuild forces a rebuild. Never on the shared
                       drive — list/search rebuild it automatically when the
                       journals change.
             install   schedule \`memory harvest\` every --interval minutes
                       (default 30) and at login with this machine's own
                       scheduler: a LaunchAgent on macOS, a systemd user
                       timer on Linux, a Task Scheduler task on Windows.
                       Needs MEMORY_HARVEST=true. Re-run it after updating
                       the plugin so the job follows the new path.
             uninstall remove this workspace's scheduled harvest
             sync      promote your latest reviewed entries to central
                       memory through the memory service (POST /promote);
                       --all includes every author's, --dry-run only lists
                       them. Idempotent. Needs memory.central.mcpUrl and
                       your token (memory.central.tokenVariable, default
                       NEMEDA_MEMORY_TOKEN) in ~/.nemeda/.env.local.
                       --via psql (administrators) writes the database
                       directly with the connection string named by
                       memory.central.urlVariable, as your own writer role
             doctor    the memory checks, plus the online central ones:
                       service reachable, contract version, token accepted,
                       project registered, entries waiting for sync
             recap     write a digest of PERIOD's reviewed entries (YYYY,
                       YYYY-Qn, YYYY-MM) under <memory>/digests/: the
                       Markdown on stdin if given, otherwise written by
                       your local claude or codex (--host; costs tokens).
                       The next sync promotes it
             close     the last step of a project: a closure digest of its
                       whole reviewed history, then a sync of every
                       author's entries and digests, which marks the
                       project closed in central memory. --dry-run
                       previews the digest; --yes does it
             reopen    undo a close with a reopen digest (--yes)
             trust     confirm the central memory service and project this
                       workspace sends your token and entries to, after a
                       change (or a drive-hosted configuration's first use).
                       Needs a person at an interactive terminal typing the
                       service host; agents and scripts cannot confirm it
             import-airtable
                       migrate an Airtable Knowledge Log (--base, else
                       airtable.baseId; --table, default "Knowledge Log")
                       into journal/import-airtable-<base>.jsonl, each
                       entry under its Person's Team email, Reviewed and
                       Incorporated as reviewed. Needs AIRTABLE_API_KEY with
                       data.records:read. Re-runnable: imported records are
                       skipped. --alias airtable@client.com=you@company
                       (repeatable) files a Team email under the person's
                       memory identity. Then \`memory sync --all\` promotes them
`;
}

function printReport(report, options, title) {
  if (options.json) {
    print(report, true);
    return;
  }
  console.log(title);
  for (const entry of report.actions || []) console.log(`[${entry.status.toUpperCase()}] ${entry.kind}: ${entry.message}`);
  for (const check of report.checks || []) {
    const symbol = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${symbol}] ${check.message}`);
  }
  if (report.nextSteps?.length) {
    console.log("\nNext steps:");
    for (const step of report.nextSteps) console.log(`  - ${step}`);
  }
}

// Interactive picker for `slack server` with no argument. Falls back to a plain
// listing when stdin is not a terminal, so scripts get output instead of a hang.
async function promptForServer(state) {
  for (const [index, server] of state.servers.entries()) {
    const mark = server.active ? "*" : " ";
    console.log(` ${mark} ${index + 1}) ${server.name.padEnd(14)} ${server.url}`);
  }
  if (!process.stdin.isTTY) {
    console.log("\nPick one with: nemeda-agent slack server <name>");
    return null;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("\nConnect to which one? (number or name, Enter to keep current) ")).trim();
    if (!answer) return null;
    const byIndex = state.servers[Number(answer) - 1];
    return byIndex ? byIndex.name : answer;
  } finally {
    rl.close();
  }
}

async function runCursor(options) {
  if (options.subcommand && options.subcommand !== "init") throw new Error("Unknown cursor subcommand; use: nemeda-agent cursor init");
  const { setupCursor } = await import("./lib/cursor.mjs");
  const context = readWorkspaceContext(options.cwd || defaultWorkspaceDirectory());
  if (context.mode !== "configured") throw new Error("No .nemeda/agent-kit.json found; run `nemeda-agent init` first.");
  const result = setupCursor(context.root, context.config, { dryRun: Boolean(options.dryRun) });
  if (options.json) {
    print(result, true);
    return 0;
  }
  console.log(`Cursor adapter${options.dryRun ? " (dry run)" : ""} at ${context.root}`);
  for (const entry of result.actions) console.log(`[${entry.status.toUpperCase()}] ${entry.kind}: ${entry.message}`);
  console.log("Run `nemeda-agent setup` to add the generated paths to .gitignore, and restart Cursor.");
  return 0;
}

async function runAirtable(options) {
  if (options.subcommand !== "init") throw new Error("Unknown airtable subcommand; use: nemeda-agent airtable init");
  const { createCanonicalBase, airtableConfigSnippet } = await import("./lib/airtable-provision.mjs");
  const { loadEnvLocal } = await import("./lib/env.mjs");
  loadEnvLocal(options.cwd || defaultWorkspaceDirectory(), process.env);
  if (!options.projectName) throw new Error("Pass --name for the new base (usually the project name).");
  const result = await createCanonicalBase({
    apiKey: process.env.AIRTABLE_API_KEY,
    workspaceId: options.workspaceId,
    projectName: options.projectName
  });
  const snippet = airtableConfigSnippet(result);
  if (options.json) {
    print({ ...result, raw: undefined, snippet }, true);
    return 0;
  }
  console.log(`Created base "${options.projectName}" (${result.baseId}) with tables: ${Object.keys(result.tables).join(", ")}.`);
  for (const warning of result.warnings || []) console.log(`WARN: ${warning}`);
  console.log("\nAdd this to .nemeda/agent-kit.json:");
  console.log(JSON.stringify(snippet, null, 2));
  return 0;
}

// Yes/no question for commands that install software. Without a terminal the
// answer is "no": scripts must pass --yes explicitly.
async function confirm(question) {
  if (!process.stdin.isTTY) {
    console.log(`${question}(no terminal; pass --yes to confirm)`);
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function runMeeting(options) {
  const subcommand = options.subcommand || "list";
  const { listRecordings, processRecordings } = await import("./lib/meetings.mjs");
  const cwd = options.cwd || defaultWorkspaceDirectory();
  if (subcommand === "list") {
    const listing = listRecordings(cwd, { engine: options.engine });
    if (options.json) {
      print(listing, true);
      return 0;
    }
    console.log(`Nemeda Agent Kit meetings at ${listing.root}`);
    console.log(`Role: ${listing.role}`);
    if (listing.role !== "transcriber") console.log(`Recordings folder: ${listing.watch || "not configured (set NEMEDA_MEETINGS_WATCH in .env.local)"}`);
    if (listing.inbox) console.log(`Shared inbox: ${listing.inbox}${listing.inboxExists ? "" : " (missing)"}`);
    console.log(`Engine: ${listing.engine} (${listing.engineReason})${listing.engine === "apple-speech" ? "" : listing.model ? `, model ${listing.model}` : ", no model found: run `nemeda-agent meeting setup`"}`);
    const describe = (entry) => `${entry.path} (${(entry.size / 1024 / 1024).toFixed(0)} MB)`;
    console.log(`\nReady (${listing.ready.length}):`);
    for (const entry of listing.ready) console.log(`  ${describe(entry)}`);
    if (listing.pending.length) {
      console.log(`\nStill being written (${listing.pending.length}):`);
      for (const entry of listing.pending) console.log(`  ${describe(entry)}`);
    }
    console.log(`\n${listing.role === "recorder" ? "Handed off" : "Transcribed"} (${listing.processed.length}):`);
    for (const entry of listing.processed.slice(-10)) console.log(`  ${path.basename(entry.path)} -> ${entry.transcript ? `${entry.transcript}/` : "inbox"}`);
    if (listing.inbox && listing.inboxExists) {
      console.log(`\nShared inbox: ${listing.inboxReady.length} waiting, ${listing.inboxPending.length} still syncing, ${listing.claims.length} claimed, ${listing.inboxProcessed.length} transcribed`);
      for (const entry of listing.inboxReady) console.log(`  waiting  ${describe(entry)}`);
      for (const claim of listing.claims) console.log(`  claimed  ${path.basename(claim.original)} by ${claim.host}`);
    }
    const pendingWork = listing.ready.length + (listing.role === "recorder" ? 0 : listing.inboxReady.length);
    if (pendingWork) console.log(`\nRun \`nemeda-agent meeting process\` to ${listing.role === "recorder" ? "hand the ready recordings to the inbox" : "transcribe the waiting recordings"}.`);
    return 0;
  }
  if (subcommand === "process") {
    const report = processRecordings(cwd, { file: options.file, title: options.title, engine: options.engine, skipNotes: Boolean(options.skipNotes), dryRun: Boolean(options.dryRun) });
    printReport(report, options, `Nemeda Agent Kit meeting process${report.dryRun ? " (dry run)" : ""} at ${report.root}`);
    return report.actions.some((entry) => entry.status === "error") ? 1 : 0;
  }
  if (subcommand === "notes") {
    if (!options.folder) throw new Error("meeting notes needs a transcript folder: nemeda-agent meeting notes docs/transcripts/<date>-<slug>");
    const { notesForTranscript } = await import("./lib/meetings.mjs");
    const report = notesForTranscript(cwd, options.folder, { force: Boolean(options.force), dryRun: Boolean(options.dryRun), engine: options.engine });
    printReport(report, options, `Nemeda Agent Kit meeting notes${report.dryRun ? " (dry run)" : ""} at ${report.root}`);
    return report.actions.some((entry) => entry.status === "error") ? 1 : 0;
  }
  if (subcommand === "watch") {
    const { runMeetingWatch } = await import("./lib/meetings-watch.mjs");
    await runMeetingWatch(cwd, { intervalSeconds: options.interval, once: Boolean(options.once), engine: options.engine, skipNotes: Boolean(options.skipNotes) });
    return 0;
  }
  if (subcommand === "install" || subcommand === "uninstall") {
    const { installMeetingService, uninstallMeetingService } = await import("./lib/meetings-watch.mjs");
    const report = subcommand === "install"
      ? installMeetingService(cwd, { intervalSeconds: options.interval || undefined, dryRun: Boolean(options.dryRun) })
      : uninstallMeetingService(cwd, { dryRun: Boolean(options.dryRun) });
    printReport(report, options, `Nemeda Agent Kit meeting ${subcommand}${report.dryRun ? " (dry run)" : ""} at ${report.root}`);
    return report.actions.some((entry) => entry.status === "error") ? 1 : 0;
  }
  if (subcommand === "doctor") {
    const { meetingDoctorChecks } = await import("./lib/meetings-doctor.mjs");
    const context = readWorkspaceContext(cwd);
    if (context.mode !== "configured") throw new Error("No .nemeda/agent-kit.json found; run `nemeda-agent init` first.");
    if (!context.config?.meetings) throw new Error("This workspace has no `meetings` section in .nemeda/agent-kit.json; add one to enable meeting capture.");
    const checks = meetingDoctorChecks(context.root, context.config.meetings, context.config.drive, process.env, { explicitEngine: options.engine || null, memoryConfigured: Boolean(context.config.memory), projectId: context.config.project.id });
    printReport({ checks }, options, `Nemeda Agent Kit meeting doctor at ${context.root}`);
    return checks.some((check) => check.status === "fail") ? 1 : 0;
  }
  if (subcommand === "setup") {
    const { describePlan, planMeetingSetup, runMeetingSetup } = await import("./lib/meetings-setup.mjs");
    const context = readWorkspaceContext(cwd);
    if (context.mode !== "configured") throw new Error("No .nemeda/agent-kit.json found; run `nemeda-agent init` first.");
    if (!context.config?.meetings) throw new Error("This workspace has no `meetings` section in .nemeda/agent-kit.json; add one to enable meeting capture.");
    const plan = planMeetingSetup(context.root, process.env, { obs: options.obs, model: options.model, engine: options.engine });
    const dryRun = Boolean(options.dryRun);
    if (!options.json) {
      console.log(`Nemeda Agent Kit meeting setup${dryRun ? " (dry run)" : ""} at ${context.root}`);
      for (const line of describePlan(plan)) console.log(line);
    }
    const willRun = plan.steps.some((step) => step.run) || Boolean(plan.download);
    if (willRun && !dryRun && !options.yes) {
      const confirmed = await confirm("Run the commands and downloads above now? [y/N] ");
      if (!confirmed) {
        console.log("Nothing changed. Re-run with --yes to skip the question, or --dry-run to only see the plan.");
        return 1;
      }
    }
    const report = runMeetingSetup(plan, { dryRun });
    printReport(report, options, dryRun ? "Planned:" : "Done:");
    return report.actions.some((entry) => entry.status === "error") ? 1 : 0;
  }
  throw new Error(`Unknown meeting subcommand: ${subcommand}; use process, list, notes, doctor, setup, watch, install, or uninstall.`);
}

async function promptLine(question) {
  const { createInterface } = await import("node:readline/promises");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await reader.question(question);
  } finally {
    reader.close();
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function printSyncReport(report, describeSyncError) {
  const digestCandidates = report.digests?.candidates || [];
  if (report.candidates.length === 0 && digestCandidates.length === 0) {
    console.log(`Nothing to promote to ${report.projectId} (${report.scope}, policy "${report.promote}").`);
    return;
  }
  if (report.dryRun) {
    console.log(`Would promote to ${report.projectId} via ${report.endpoint}:`);
    for (const candidate of report.candidates) console.log(`  entry  ${candidate.id} r${candidate.revision} ${candidate.title} (${candidate.author})`);
    for (const digest of digestCandidates) console.log(`  digest ${digest.id} ${digest.kind} ${digest.period} (${digest.generatedBy})`);
    return;
  }
  const digests = report.digests || { inserted: [], existing: [] };
  console.log(`Promoted to ${report.projectId}: entries ${report.inserted.length} new, ${report.existing.length} already there; digests ${digests.inserted.length} new, ${digests.existing.length} already there${report.errors.length ? `; ${report.errors.length} refused` : ""}.`);
  for (const error of report.errors) console.log(`  refused ${describeSyncError(error, report.projectId)}`);
}

function summarizeMemoryEntry(entry) {
  return `[${entry.status}] ${entry.date} ${entry.type} — ${entry.title} (${entry.author}) ${entry.id}`;
}

async function runMemory(options) {
  const subcommand = options.subcommand || "list";
  const cwd = options.cwd || defaultWorkspaceDirectory();
  const context = readWorkspaceContext(cwd);
  // A configuration that exists but could not be read (invalid JSON, or a
  // drive pointer with the drive unavailable and no cached copy) is not the
  // same as a missing memory section: say what went wrong.
  if (context.mode === "configured" && !context.config) {
    const reasons = (context.issues || []).filter((issue) => issue.level === "error").map((issue) => issue.message);
    throw new Error(`The workspace configuration could not be read${reasons.length ? `: ${reasons.join(" ")}` : ""}.`);
  }
  if (context.mode !== "configured" || !context.config?.memory) {
    throw new Error("No `memory` section in .nemeda/agent-kit.json; see docs/memory-plan.md.");
  }
  const memoryLib = await import("./lib/memory.mjs");
  const memoryRoot = path.join(context.root, context.config.memory.project.path);

  // Every command that writes memory asks the destination guard first
  // (docs/drive-config-plan.md, guards 4 and 5). Harvest and the sync the
  // SessionStart hook starts (--unattended) are unattended: a moved memory
  // folder stops them. The rest are a person at a terminal: only a warning.
  const unattendedWriter = subcommand === "harvest" || (subcommand === "sync" && options.unattended);
  const interactiveWriter = ["add", "recap", "close", "reopen", "import-airtable"].includes(subcommand) || (subcommand === "review" && options.reviewId);
  if ((unattendedWriter || interactiveWriter) && !options.dryRun) {
    const { checkMemoryWrite } = await import("./lib/memory-pins.mjs");
    const guard = checkMemoryWrite(context.root, context.config, { unattended: unattendedWriter });
    if (!guard.allowed) throw new Error(guard.message);
    if (guard.warning) console.error(`nemeda-agent: ${guard.warning}`);
  }

  if (subcommand === "add") {
    const stdin = (await readStdin()).trim();
    let fields = {};
    if (options.json) {
      if (!stdin) throw new Error("memory add --json reads the entry as JSON on stdin.");
      try {
        fields = JSON.parse(stdin);
      } catch (error) {
        throw new Error(`memory add --json: stdin is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
      }
    } else if (stdin) {
      fields.summary = stdin;
    }
    const author = memoryLib.resolveAuthorEmail(context.root);
    if (!author) throw new Error("git config user.email is not set; the kit needs it to attribute this entry.");
    const entry = memoryLib.createEntry({
      project: context.config.project.id,
      repository: context.config.repository?.id,
      type: options.type || fields.type || "finding",
      title: options.title || fields.title,
      date: fields.date,
      author,
      tags: options.tags || fields.tags || [],
      summary: fields.summary,
      clientSummary: fields.clientSummary,
      // "reviewed" when a person confirmed the entry before it was written
      // (the memory-log skill); validateEntry rejects anything else invalid.
      status: fields.status,
      source: fields.source || { kind: "manual" }
    });
    const errors = memoryLib.validateEntry(entry);
    if (errors.length) throw new Error(`Invalid memory entry: ${errors.join("; ")}`);
    memoryLib.appendEntry(memoryRoot, entry);
    if (options.json) {
      print(entry, true);
      return 0;
    }
    console.log(`Logged ${summarizeMemoryEntry(entry)}\n-> ${memoryLib.journalPath(memoryRoot, author)}`);
    return 0;
  }

  const filters = { type: options.type, author: options.author, status: options.pending ? "pending" : undefined, since: options.since };

  if (subcommand === "search" && options.central) {
    if (!options.query) throw new Error('memory search needs a query: nemeda-agent memory search "..." --central');
    const central = await import("./lib/memory-central.mjs");
    const settings = central.centralSettings(context.config, { configSource: context.configSource });
    if (!settings) throw new Error("No memory.central section in .nemeda/agent-kit.json; see docs/memory-plan.md, \"Configuration\".");
    const token = central.requireCentralToken(context.root, settings);
    const result = await central.callCentralTool(settings, token, "memory_central_search", {
      query: options.query,
      ...(options.type ? { types: [options.type] } : {}),
      ...(options.since ? { since: options.since } : {})
    });
    const parsed = central.toolResultJson(result);
    const text = (result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (result.isError) throw new Error(`memory_central_search: ${parsed?.error || text || "failed"}`);
    print(options.json ? (parsed ?? result.content) : text || "No results.", options.json);
    return 0;
  }

  if (subcommand === "list" || subcommand === "search") {
    if (subcommand === "search" && !options.query) throw new Error('memory search needs a query: nemeda-agent memory search "..."');
    const { queryEntries } = await import("./lib/memory-index.mjs");
    const answer = queryEntries(context.root, context.config, { query: subcommand === "search" ? options.query : "", filters });
    if (answer.fallback) console.error(`nemeda-agent: ${answer.fallback}`);
    if (options.json) {
      print(answer.entries, true);
      return 0;
    }
    if (subcommand === "list") {
      console.log(`Nemeda Agent Kit memory at ${memoryRoot} (${answer.entries.length} entries, ${answer.engine} engine)`);
      for (const entry of answer.entries) console.log(summarizeMemoryEntry(entry));
      return 0;
    }
    console.log(`${answer.entries.length} result(s) for "${options.query}":`);
    for (const entry of answer.entries) {
      const preview = entry.summary.length > 200 ? `${entry.summary.slice(0, 200)}…` : entry.summary;
      console.log(`${summarizeMemoryEntry(entry)}\n  ${preview}`);
    }
    return 0;
  }

  if (subcommand === "index") {
    const { indexStatus, rebuildIndex } = await import("./lib/memory-index.mjs");
    const report = options.rebuild ? rebuildIndex(context.root, context.config, { force: true }) : indexStatus(context.root, context.config);
    if (options.json) {
      print(report, true);
      return 0;
    }
    console.log(`Engine: ${report.engine} (${report.reason})`);
    if (report.engine === "memory") {
      console.log("No index file: every query scans the journals directly.");
      return 0;
    }
    if (options.rebuild) console.log(`Rebuilt ${report.path} with ${report.count} entries.`);
    else console.log(`Index: ${report.path} — ${report.exists ? `${report.count ?? "?"} entries, ${report.fresh ? "up to date" : "stale (rebuilt automatically on the next query)"}` : "not built yet (built automatically on the first query)"}.`);
    return 0;
  }

  if (subcommand === "install" || subcommand === "uninstall") {
    const { flagEnabled, loadEnvLocal } = await import("./lib/env.mjs");
    loadEnvLocal(context.root, process.env);
    if (subcommand === "install" && !flagEnabled("MEMORY_HARVEST", process.env)) {
      throw new Error("MEMORY_HARVEST is not enabled; set MEMORY_HARVEST=true in .env.local first (a scheduled harvest resumes sessions through the host CLI, and that costs tokens).");
    }
    const { installHarvestScheduler, uninstallHarvestScheduler } = await import("./lib/harvest-scheduler.mjs");
    const report = subcommand === "install"
      ? installHarvestScheduler(context.root, context.config, { intervalMinutes: options.interval, dryRun: Boolean(options.dryRun) })
      : uninstallHarvestScheduler(context.root, context.config, { dryRun: Boolean(options.dryRun) });
    printReport(report, options, `Nemeda Agent Kit memory ${subcommand}${report.dryRun ? " (dry run)" : ""} — ${report.platform}, job ${report.identity.name}`);
    return report.actions.some((entry) => entry.status === "error") ? 1 : 0;
  }

  if (subcommand === "sync") {
    if (options.via && !["service", "psql"].includes(options.via)) throw new Error(`Unknown --via ${options.via}; use service (default) or psql.`);
    const { describeSyncError, syncToCentral } = await import("./lib/memory-sync.mjs");
    const report = await syncToCentral(context.root, context.config, { dryRun: Boolean(options.dryRun), all: Boolean(options.all), via: options.via || "service", configSource: context.configSource });
    if (options.json) {
      print(report, true);
      return report.errors.length ? 1 : 0;
    }
    printSyncReport(report, describeSyncError);
    return report.errors.length ? 1 : 0;
  }

  if (subcommand === "trust") {
    const central = await import("./lib/memory-central.mjs");
    const pins = await import("./lib/memory-pins.mjs");
    const settings = central.centralSettings(context.config, { configSource: context.configSource });
    // Without a central section only folder moves can need confirming.
    const plan = settings
      ? pins.describeCentralTrust(context.root, settings)
      : { origin: null, projectId: context.config.project.id, configSource: context.configSource || "repository", changes: pins.pendingFolderChanges(context.root) };
    if (options.trustUrl && pins.serviceOrigin(options.trustUrl) !== plan.origin) {
      throw new Error(`This workspace uses ${plan.origin || "no service URL"}, not ${pins.serviceOrigin(options.trustUrl) || options.trustUrl}; trust the URL its configuration names, or change the configuration first.`);
    }
    console.log(`Workspace ${context.root} (${plan.configSource} configuration):`);
    console.log(`  central memory service: ${plan.origin || "(none; --via psql only)"}`);
    console.log(`  promotes to project:    ${plan.projectId}`);
    if (!plan.changes.length) {
      console.log("Already trusted; nothing to confirm.");
      return 0;
    }
    for (const change of plan.changes) console.log(`  ${change.kind}: ${change.from || "(not trusted yet)"} -> ${change.to}`);
    // Trusting decides where a person's token and a project's memory go, so
    // it needs a person: an agent or a script has no interactive terminal.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("memory trust needs a person at an interactive terminal: it decides where your token and this project's memory go, so an agent or a script cannot confirm it. Run it yourself in a terminal.");
    }
    const expected = plan.origin ? new URL(plan.origin).host : plan.projectId;
    const answer = await promptLine(`Type ${expected} to trust it: `);
    if (answer.trim() !== expected) throw new Error("Not confirmed; nothing changed.");
    if (settings) pins.trustCentralPins(context.root, { mcpUrl: settings.mcpUrl, projectId: settings.projectId });
    pins.trustPendingFolders(context.root);
    console.log(`Trusted ${plan.changes.map((change) => change.kind).join(", ")} for this workspace; paused writers resume.`);
    return 0;
  }

  if (subcommand === "import-airtable") {
    const { loadEnvLocal } = await import("./lib/env.mjs");
    loadEnvLocal(context.root, process.env);
    const { DEFAULT_AIRTABLE_API_URL, importAirtableKnowledgeLog, parseAuthorAliases } = await import("./lib/memory-import-airtable.mjs");
    const fallbackAuthor = memoryLib.resolveAuthorEmail(context.root);
    const report = await importAirtableKnowledgeLog(context.root, context.config, {
      baseId: options.base,
      table: options.table,
      teamTable: options.teamTable,
      apiKey: process.env.AIRTABLE_API_KEY,
      authorAliases: parseAuthorAliases(options.aliases),
      fallbackAuthor,
      dryRun: Boolean(options.dryRun),
      apiUrl: process.env.NEMEDA_AIRTABLE_API_URL || DEFAULT_AIRTABLE_API_URL
    });
    if (options.json) {
      print(report, true);
      return 0;
    }
    console.log(`${report.dryRun ? "Would import" : "Imported"} ${report.imported.length} of ${report.fetched} records from ${report.baseId} / ${report.table} (${report.counts.reviewed} reviewed, ${report.counts.pending} pending) ${report.dryRun ? "into" : "->"} ${report.journal}`);
    for (const [author, count] of Object.entries(report.counts.byAuthor)) console.log(`  ${count} by ${author}`);
    if (report.alreadyImported) console.log(`  ${report.alreadyImported} already imported earlier, skipped.`);
    for (const skipped of report.skipped) console.log(`  skipped ${skipped.recordId}: ${skipped.reason}`);
    if (report.unresolvedAuthors.length) {
      console.log(`  ${report.unresolvedAuthors.length} record(s) had no Person with an Email in the Team table and are attributed to ${fallbackAuthor}: ${report.unresolvedAuthors.join(", ")}`);
    }
    if (report.teamWarning) console.log(`  ${report.teamWarning}`);
    if (!report.dryRun && report.counts.reviewed) console.log("Next: `nemeda-agent memory sync --all --dry-run`, then `memory sync --all`, promotes the reviewed ones (every author's) to central memory.");
    return 0;
  }

  if (subcommand === "recap" || subcommand === "close" || subcommand === "reopen") {
    const recap = await import("./lib/memory-recap.mjs");
    const host = options.host || recap.defaultRecapHost(process.env);
    const dryRun = Boolean(options.dryRun);
    if (subcommand !== "recap" && !options.yes && !dryRun) {
      throw new Error(subcommand === "close"
        ? "memory close promotes every author's reviewed entries and marks the project closed in central memory. Preview it with --dry-run, then run it again with --yes."
        : "memory reopen marks the project active again in central memory. Run it again with --yes.");
    }
    const body = (await readStdin()).trim();
    let result;
    if (subcommand === "recap") {
      if (!options.period) throw new Error("memory recap needs --period (YYYY, YYYY-Qn, or YYYY-MM).");
      result = recap.recapProject(context.root, context.config, { period: options.period, body, host, dryRun });
    } else {
      result = await (subcommand === "close" ? recap.closeProject : recap.reopenProject)(context.root, context.config, { body, host, dryRun, configSource: context.configSource });
    }
    if (options.json) {
      print(result, true);
      return result.sync?.errors?.length ? 1 : 0;
    }
    const label = { recap: `${result.digest.period} recap`, closure: "closure digest", reopen: "reopen digest" }[result.digest.kind];
    if (result.dryRun) {
      console.log(`The ${label} (dry run, nothing written${result.entries !== undefined ? `; from ${result.entries} reviewed entries` : ""}):\n`);
      console.log(result.digest.body);
      return 0;
    }
    console.log(`Wrote the ${label}${result.generatedWith ? ` (written by ${result.generatedWith} from ${result.entries} reviewed entries)` : ""} -> ${result.file}`);
    if (!result.sync) {
      console.log("It reaches central memory with the next `nemeda-agent memory sync`.");
      return 0;
    }
    const { describeSyncError } = await import("./lib/memory-sync.mjs");
    printSyncReport(result.sync, describeSyncError);
    return result.sync.errors.length ? 1 : 0;
  }

  if (subcommand === "doctor") {
    const central = await import("./lib/memory-central.mjs");
    let checks = workspaceDoctor(context.root).checks.filter((check) => check.code.startsWith("memory-") || check.code === "invalid-memory" || check.code === "deprecated-knowledge-log");
    if (context.config.memory.central) {
      // The online rows supersede the offline memory-central row.
      checks = [...checks.filter((check) => check.code !== "memory-central"), ...(await central.centralDoctorChecks(context.root, context.config, { configSource: context.configSource }))];
      const { psqlDoctorChecks } = await import("./lib/memory-psql.mjs");
      checks.push(...psqlDoctorChecks(context.root, context.config));
      const settings = central.centralSettings(context.config);
      const { promotableEntries, readSyncState } = await import("./lib/memory-sync.mjs");
      const state = readSyncState(context.root);
      const waiting = promotableEntries(memoryLib.readAllJournals(memoryRoot).entries, { promote: settings.promote, author: memoryLib.resolveAuthorEmail(context.root) || undefined, state }).length;
      checks.push({
        status: state.lastError ? "warn" : "pass",
        code: "memory-sync",
        message: `${waiting} of your entries waiting for \`memory sync\`; last successful batch: ${state.lastSyncAt || "never"}${state.lastError ? `; last error: ${state.lastError}` : ""}.`
      });
    }
    if (options.json) {
      print({ root: context.root, checks }, true);
    } else {
      console.log(`Nemeda Agent Kit memory doctor at ${context.root}`);
      for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.code}: ${check.message}`);
    }
    return checks.some((check) => check.status === "fail") ? 1 : 0;
  }

  // Review writes a revision, so it reads the journals — the source of
  // truth — directly, never the local index cache.
  const { entries: rawEntries } = memoryLib.readAllJournals(memoryRoot);
  const entries = memoryLib.latestRevisions(rawEntries).sort(memoryLib.compareEntriesNewestFirst);

  if (subcommand === "review") {
    const author = memoryLib.resolveAuthorEmail(context.root);
    if (!options.reviewId) {
      // No id: list the pending inbox. Author-scoped by default — reviewing
      // is always self-service (see below) — --all is for visibility only,
      // e.g. a lead checking the whole team's backlog.
      const pending = memoryLib.filterEntries(entries, { status: "pending", author: options.all ? undefined : author });
      if (options.json) {
        print(pending, true);
        return 0;
      }
      console.log(`Pending entries${options.all ? "" : ` for ${author || "(no git email set)"}`}: ${pending.length}`);
      for (const entry of pending) console.log(summarizeMemoryEntry(entry));
      return 0;
    }
    const entry = entries.find((candidate) => candidate.id === options.reviewId);
    if (!entry) throw new Error(`No memory entry with id ${options.reviewId}.`);
    if (entry.status !== "pending") throw new Error(`Entry ${entry.id} is already "${entry.status}"; nothing to review.`);
    if (!author) throw new Error("git config user.email is not set; the kit needs it to attribute the review.");
    if (entry.author !== author) {
      // A journal has exactly one writer by design (see memory.mjs): letting
      // a different machine append a revision to someone else's journal
      // file is exactly the concurrent-write pattern that breaks under
      // Google Drive / OneDrive sync. Only the original author reviews.
      throw new Error(`Entry ${entry.id} belongs to ${entry.author}; only they can review it (ask them to run this, or pass --all just to look, not to review).`);
    }
    const stdin = (await readStdin()).trim();
    let changes = { status: "reviewed" };
    if (stdin) {
      try {
        changes = { ...JSON.parse(stdin), status: "reviewed" };
      } catch (error) {
        throw new Error(`memory review: stdin is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
      }
    }
    const revised = memoryLib.reviseEntry(entry, changes);
    const errors = memoryLib.validateEntry(revised);
    if (errors.length) throw new Error(`Invalid review: ${errors.join("; ")}`);
    memoryLib.appendEntry(memoryRoot, revised);
    if (options.json) {
      print(revised, true);
      return 0;
    }
    console.log(`Reviewed ${summarizeMemoryEntry(revised)}`);
    return 0;
  }

  if (subcommand === "harvest") {
    const { flagEnabled, loadEnvLocal } = await import("./lib/env.mjs");
    loadEnvLocal(context.root, process.env);
    if (!flagEnabled("MEMORY_HARVEST", process.env)) {
      throw new Error("MEMORY_HARVEST is not enabled; set MEMORY_HARVEST=true in .env.local to allow harvesting to resume sessions (it invokes the host CLI, and that costs tokens).");
    }
    const { acquireHarvestLock, harvestClosedSessions, harvestSessionById } = await import("./lib/harvest.mjs");
    const dryRun = Boolean(options.dryRun);
    // One harvest per machine at a time: the SessionStart trigger and a manual
    // run must never resume the same session twice.
    const release = acquireHarvestLock(context.root);
    if (!release) {
      console.error("nemeda-agent: another harvest is already running on this machine; skipping this run.");
      if (options.json) print([], true);
      return 0;
    }
    let results;
    try {
      results = options.sessionId
        ? [harvestSessionById(context.root, context.config, options.sessionId, { dryRun })]
        : harvestClosedSessions(context.root, context.config, { dryRun });
    } finally {
      release();
    }
    if (options.json) {
      print(results, true);
      return results.some((result) => !result.ok) ? 1 : 0;
    }
    if (results.length === 0) {
      console.log("No closed, unharvested sessions to summarise.");
      return 0;
    }
    for (const result of results) {
      if (result.ok) {
        console.log(`Harvested ${result.sessionId}: ${result.created.length} entr${result.created.length === 1 ? "y" : "ies"}${dryRun ? " (dry run, nothing written)" : ` -> ${result.journalPath}`}`);
        for (const error of result.errors) console.log(`  skipped a draft: ${error}`);
      } else {
        console.log(`Failed to harvest ${result.sessionId}: ${result.errors.join("; ")}`);
      }
    }
    return results.some((result) => !result.ok) ? 1 : 0;
  }

  throw new Error(`Unknown memory subcommand: ${subcommand}; use add, list, search, review, harvest, index, install, uninstall, sync, doctor, recap, close, reopen, or import-airtable.`);
}

async function runSlack(options) {
  const subcommand = options.subcommand || "doctor";
  if (subcommand === "manifest") {
    console.log(readFileSync(manifestPath(), "utf8"));
    return 0;
  }
  if (subcommand === "init") {
    printReport(initSlack(), options, "Nemeda Agent Kit Slack bridge");
    return 0;
  }
  if (subcommand === "install") {
    const report = installLaunchAgent();
    printReport(report, options, "Nemeda Agent Kit Slack LaunchAgent");
    return report.actions.some((entry) => entry.status === "error") ? 1 : 0;
  }
  if (subcommand === "doctor") {
    const report = await slackDoctor();
    printReport(report, options, "Nemeda Agent Kit Slack doctor");
    return report.checks.some((check) => check.status === "fail") ? 1 : 0;
  }
  if (subcommand === "ask") {
    if (!options.question) throw new Error('slack ask needs a question: nemeda-agent slack ask "..."');
    const result = await askLocally(options.question, options.cwd || defaultWorkspaceDirectory());
    if (options.json) {
      print(result, true);
      return 0;
    }
    console.log(`${result.project} via ${result.backend} in ${result.ms}ms\n`);
    for (const message of result.messages) console.log(`${message}\n---`);
    return 0;
  }
  if (subcommand === "run") {
    const { runSlackRunner } = await import("./slack/runner.mjs");
    await runSlackRunner(process.env, options.server || "");
    return 0;
  }
  if (subcommand === "join") {
    const result = await joinRelay(options.question, options.as);
    console.log(`Linked as ${result.userName} (${result.userId}) on "${result.server}". Saved to ${result.envPath}.`);
    for (const step of result.nextSteps) console.log(`  - ${step}`);
    return 0;
  }
  if (subcommand === "server") {
    if (options.forget) {
      console.log(`Forgotten: ${forgetServer(options.forget).removed}.`);
      return 0;
    }
    const state = listServers();
    if (state.servers.length === 0) {
      console.log("No relay configured. Add one with `nemeda-agent slack join <url> --as <name>`.");
      return 1;
    }
    const target = options.question || (await promptForServer(state));
    if (!target) return 0;
    const chosen = useServer(target);
    console.log(`This machine now uses "${chosen.active}" (${chosen.url}).`);
    console.log("  - Restart the runner to apply it: launchctl kickstart -k gui/$(id -u)/io.nemeda.agent-kit.slack");
    return 0;
  }
  if (subcommand === "leave") {
    const result = leaveRelay();
    console.log(result.note);
    return 0;
  }
  if (subcommand === "relay") {
    const { runRelay } = await import("./slack/relay.mjs");
    await runRelay();
    return 0;
  }
  throw new Error(`Unknown slack subcommand: ${subcommand}`);
}

export function run(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parseArguments(argv);
    const cwd = options.cwd || defaultWorkspaceDirectory();
    if (command === "help" || command === "--help" || command === "-h") {
      print(help());
      return 0;
    }
    if (command === "init") {
      const result = initializeWorkspace(cwd, options);
      print({
        root: result.root,
        created: [result.configPath, ...(result.agentsCreated ? [result.agentsPath] : [])],
        preserved: result.agentsCreated ? [] : [result.agentsPath],
        ...(result.config.repository
          ? { profiles: result.config.repository.profiles }
          : { repositories: result.config.workspace.repositories.map((repository) => repository.path) })
      }, options.json);
      return 0;
    }
    if (command === "setup") {
      const report = setupWorkspace(cwd, options);
      if (options.json) print(report, true);
      else {
        console.log(`Nemeda Agent Kit setup${report.dryRun ? " (dry run)" : ""} at ${report.root}`);
        for (const entry of report.actions) {
          console.log(`[${entry.status.toUpperCase()}] ${entry.kind}: ${entry.message}`);
        }
        if (report.nextSteps.length) {
          console.log("\nNext steps:");
          for (const step of report.nextSteps) console.log(`  - ${step}`);
        }
      }
      return report.actions.some((entry) => entry.status === "error") ? 1 : 0;
    }
    if (command === "cursor") {
      return runCursor(options).catch((error) => {
        console.error(`nemeda-agent: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      });
    }
    if (command === "airtable") {
      return runAirtable(options).catch((error) => {
        console.error(`nemeda-agent: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      });
    }
    if (command === "meeting") {
      return runMeeting(options).catch((error) => {
        console.error(`nemeda-agent: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      });
    }
    if (command === "memory") {
      return runMemory(options).catch((error) => {
        console.error(`nemeda-agent: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      });
    }
    if (command === "slack") {
      return runSlack(options).catch((error) => {
        console.error(`nemeda-agent: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      });
    }
    if (command === "context") {
      const context = readWorkspaceContext(cwd);
      print(options.json ? context : formatContextForHook(context) || `No configured Agent Kit context found from ${cwd}.`, options.json);
      return context.mode === "configured" ? 0 : 1;
    }
    if (command === "doctor") {
      const report = workspaceDoctor(cwd);
      if (options.json) print(report, true);
      else {
        console.log(`Nemeda Agent Kit doctor (${report.mode})`);
        for (const check of report.checks) {
          const symbol = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
          console.log(`[${symbol}] ${check.message}`);
        }
      }
      return report.checks.some((check) => check.status === "fail") ? 1 : 0;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`nemeda-agent: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

const exitCode = run();
if (exitCode instanceof Promise) exitCode.then((code) => {
  process.exitCode = code;
});
else process.exitCode = exitCode;
