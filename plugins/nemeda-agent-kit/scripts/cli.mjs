#!/usr/bin/env node
import { setupWorkspace } from "./lib/setup.mjs";
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

Commands:
  init     Create missing .nemeda/agent-kit.json and AGENTS.md safely.
           --workspace scans nested Git repositories into a workspace config.
  setup    Assemble machine-local pieces: Drive symlinks, declared repository
           clones, the .env.local template, and .gitignore entries. Idempotent;
           never overwrites existing files.
  context  Show the normalized repository context.
  doctor   Run read-only configuration, Drive, Airtable, and host diagnostics.
`;
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

process.exitCode = run();
