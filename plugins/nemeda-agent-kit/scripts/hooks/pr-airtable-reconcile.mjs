#!/usr/bin/env node
// SessionStart hook (also runnable by hand; --force bypasses the 12h
// throttle). Reads open and merged PRs via `gh pr list` and moves their
// labelled Airtable tasks to the matching status. This is the authoritative
// sync: unlike the PostToolUse fast-path, it works no matter how the PR was
// opened (web UI, another machine, `gh` CLI). Always exits 0.
import { reconcilePrs } from "../lib/hooks.mjs";

let input = "";
if (!process.stdin.isTTY) {
  for await (const chunk of process.stdin) input += chunk;
}

try {
  const event = input.trim() ? JSON.parse(input) : {};
  const result = await reconcilePrs(event, process.env, { force: process.argv.includes("--force") });
  for (const error of result.errors || []) console.error(`[pr-airtable-reconcile] ${error}`);
  if (result.dryRun) console.log(JSON.stringify(result));
  else if (result.systemMessage) console.log(JSON.stringify({ systemMessage: result.systemMessage }));
} catch (error) {
  console.error(`[pr-airtable-reconcile] ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
