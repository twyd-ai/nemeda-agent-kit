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
  if (["slack", "airtable", "cursor", "meeting"].includes(command) && rest[0] && !rest[0].startsWith("-")) options.subcommand = rest.shift();
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
    else if (command === "meeting" && options.subcommand === "process" && !options.file && !value.startsWith("-")) options.file = value;
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
           docs/meeting-capture-plan.md).
             process   transcribe every ready recording in the watched folder
                       (OBS's recording folder, or NEMEDA_MEETINGS_WATCH), or
                       one FILE; files <date>-<slug>/ under meetings.transcripts
             list      show ready, in-progress, and already transcribed recordings
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
    console.log(`Recordings folder: ${listing.watch || "not configured (set NEMEDA_MEETINGS_WATCH in .env.local)"}`);
    console.log(`Engine: ${listing.engine}${listing.model ? ` (model ${listing.model})` : " (no model found)"}`);
    const describe = (entry) => `${entry.path} (${(entry.size / 1024 / 1024).toFixed(0)} MB)`;
    console.log(`\nReady (${listing.ready.length}):`);
    for (const entry of listing.ready) console.log(`  ${describe(entry)}`);
    if (listing.pending.length) {
      console.log(`\nStill being written (${listing.pending.length}):`);
      for (const entry of listing.pending) console.log(`  ${describe(entry)}`);
    }
    console.log(`\nTranscribed (${listing.processed.length}):`);
    for (const entry of listing.processed.slice(-10)) console.log(`  ${path.basename(entry.path)} -> ${entry.transcript}/`);
    if (listing.ready.length) console.log("\nRun `nemeda-agent meeting process` to transcribe the ready recordings.");
    return 0;
  }
  if (subcommand === "process") {
    const report = processRecordings(cwd, { file: options.file, title: options.title, engine: options.engine, dryRun: Boolean(options.dryRun) });
    printReport(report, options, `Nemeda Agent Kit meeting process${report.dryRun ? " (dry run)" : ""} at ${report.root}`);
    return report.actions.some((entry) => entry.status === "error") ? 1 : 0;
  }
  throw new Error(`Unknown meeting subcommand: ${subcommand}; use process or list.`);
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
