#!/usr/bin/env node
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
                    [--role ROLE] [--profile PROFILE ...]
  nemeda-agent context [--cwd PATH] [--json]
  nemeda-agent doctor [--cwd PATH] [--json]

Commands:
  init     Create missing .nemeda/agent-kit.json and AGENTS.md safely.
  context  Show the normalized repository context.
  doctor   Run read-only configuration and host diagnostics.
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
        profiles: result.config.repository.profiles
      }, options.json);
      return 0;
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
