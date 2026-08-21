#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { setupWorkspace } from "./lib/setup.mjs";
import { askLocally, initSlack, installLaunchAgent, joinRelay, leaveRelay, slackDoctor } from "./lib/slack-ops.mjs";
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
  if (command === "slack" && rest[0] && !rest[0].startsWith("-")) options.subcommand = rest.shift();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--json") options.json = true;
    else if (value === "--cwd") options.cwd = rest[++index];
    else if (value === "--project-id") options.projectId = rest[++index];
    else if (value === "--project-name") options.projectName = rest[++index];
    else if (value === "--role") options.role = rest[++index];
    else if (value === "--profile") options.profiles.push(rest[++index]);
    else if (value === "--workspace") options.workspace = true;
    else if (value === "--dry-run") options.dryRun = true;
    else if (command === "slack" && ["ask", "join"].includes(options.subcommand) && !options.question) options.question = value;
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
  nemeda-agent slack <init|doctor|run|install|manifest> [--json]
  nemeda-agent slack ask "question" [--cwd PATH]
  nemeda-agent slack join <https://relay-url> | leave | relay

Commands:
  init     Create missing .nemeda/agent-kit.json and AGENTS.md safely.
           --workspace scans nested Git repositories into a workspace config.
  setup    Assemble machine-local pieces: Drive symlinks, declared repository
           clones, the .env.local template, and .gitignore entries. Idempotent;
           never overwrites existing files.
  context  Show the normalized repository context.
  doctor   Run read-only configuration, Drive, Airtable, and host diagnostics.
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
    await runSlackRunner();
    return 0;
  }
  if (subcommand === "join") {
    const result = await joinRelay(options.question);
    console.log(`Vinculado como ${result.userName} (${result.userId}). Token guardado en ${result.envPath}.`);
    for (const step of result.nextSteps) console.log(`  - ${step}`);
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
