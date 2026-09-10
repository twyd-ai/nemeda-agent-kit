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
    else if (value === "--model") options.model = rest[++index];
    else if (value === "--obs") options.obs = true;
    else if (value === "--yes" || value === "-y") options.yes = true;
    else if (command === "meeting" && options.subcommand === "process" && !options.file && !value.startsWith("-")) options.file = value;
    else if (command === "memory" && options.subcommand === "search" && !options.query && !value.startsWith("-")) options.query = value;
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
  nemeda-agent meeting process [FILE] [--title TITLE] [--engine NAME] [--dry-run] [--json]
  nemeda-agent meeting list [--json]
  nemeda-agent meeting doctor [--engine NAME] [--json]
  nemeda-agent meeting setup [--obs] [--model TIER] [--engine NAME] [--yes] [--dry-run] [--json]
  nemeda-agent memory add [--type TYPE] [--title TITLE] [--tags a,b] [--json]
  nemeda-agent memory list [--pending] [--type TYPE] [--author EMAIL] [--since DATE] [--json]
  nemeda-agent memory search "query" [--pending] [--type TYPE] [--json]

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
             doctor    machine capability, engine selection (apple-speech on
                       macOS 26 + Apple Silicon, whisper.cpp elsewhere), model,
                       ffmpeg, recordings folder, Drive folders, backlog
             setup     install the missing tools (brew/winget, on confirmation),
                       download the recommended whisper model, and record the
                       choices in .env.local; --obs also installs OBS Studio
  memory   Read and write project memory (needs a \`memory\` section in
           .nemeda/agent-kit.json; see docs/memory-plan.md).
             add       append one entry; the summary is read from stdin (or,
                       with --json, the whole entry as JSON on stdin), the
                       author is always this machine's \`git config user.email\`
             list      list entries, newest first
             search    full-text search across every author's journal
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
    const report = processRecordings(cwd, { file: options.file, title: options.title, engine: options.engine, dryRun: Boolean(options.dryRun) });
    printReport(report, options, `Nemeda Agent Kit meeting process${report.dryRun ? " (dry run)" : ""} at ${report.root}`);
    return report.actions.some((entry) => entry.status === "error") ? 1 : 0;
  }
  if (subcommand === "doctor") {
    const { meetingDoctorChecks } = await import("./lib/meetings-doctor.mjs");
    const context = readWorkspaceContext(cwd);
    if (context.mode !== "configured") throw new Error("No .nemeda/agent-kit.json found; run `nemeda-agent init` first.");
    if (!context.config?.meetings) throw new Error("This workspace has no `meetings` section in .nemeda/agent-kit.json; add one to enable meeting capture.");
    const checks = meetingDoctorChecks(context.root, context.config.meetings, context.config.drive, process.env, { explicitEngine: options.engine || null });
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
  throw new Error(`Unknown meeting subcommand: ${subcommand}; use process, list, doctor, or setup.`);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function summarizeMemoryEntry(entry) {
  return `[${entry.status}] ${entry.date} ${entry.type} — ${entry.title} (${entry.author}) ${entry.id}`;
}

async function runMemory(options) {
  const subcommand = options.subcommand || "list";
  const cwd = options.cwd || defaultWorkspaceDirectory();
  const context = readWorkspaceContext(cwd);
  if (context.mode !== "configured" || !context.config?.memory) {
    throw new Error("No `memory` section in .nemeda/agent-kit.json; see docs/memory-plan.md.");
  }
  const memoryLib = await import("./lib/memory.mjs");
  const memoryRoot = path.join(context.root, context.config.memory.project.path);

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

  const { entries: rawEntries } = memoryLib.readAllJournals(memoryRoot);
  const entries = memoryLib.latestRevisions(rawEntries).sort((a, b) => (a.date < b.date ? 1 : -1));
  const filters = { type: options.type, author: options.author, status: options.pending ? "pending" : undefined, since: options.since };

  if (subcommand === "list") {
    const filtered = memoryLib.filterEntries(entries, filters);
    if (options.json) {
      print(filtered, true);
      return 0;
    }
    console.log(`Nemeda Agent Kit memory at ${memoryRoot} (${filtered.length} of ${entries.length} entries)`);
    for (const entry of filtered) console.log(summarizeMemoryEntry(entry));
    return 0;
  }

  if (subcommand === "search") {
    if (!options.query) throw new Error('memory search needs a query: nemeda-agent memory search "..."');
    const results = memoryLib.searchEntries(entries, options.query, filters);
    if (options.json) {
      print(results, true);
      return 0;
    }
    console.log(`${results.length} result(s) for "${options.query}":`);
    for (const entry of results) {
      const preview = entry.summary.length > 200 ? `${entry.summary.slice(0, 200)}…` : entry.summary;
      console.log(`${summarizeMemoryEntry(entry)}\n  ${preview}`);
    }
    return 0;
  }

  throw new Error(`Unknown memory subcommand: ${subcommand}; use add, list, or search.`);
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
