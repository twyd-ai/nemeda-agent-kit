#!/usr/bin/env node
// SessionStart hook (also runnable by hand; --force bypasses the 12h
// throttle). Detects merged PRs via `gh` and moves their labelled Airtable
// tasks to the configured done status. Always exits 0.
import { reconcileMergedPrs } from "../lib/hooks.mjs";

let input = "";
if (!process.stdin.isTTY) {
  for await (const chunk of process.stdin) input += chunk;
}

try {
  const event = input.trim() ? JSON.parse(input) : {};
  const result = await reconcileMergedPrs(event, process.env, { force: process.argv.includes("--force") });
  for (const error of result.errors || []) console.error(`[pr-airtable-reconcile] ${error}`);
  if (result.dryRun) console.log(JSON.stringify(result));
  else if (result.systemMessage) console.log(JSON.stringify({ systemMessage: result.systemMessage }));
} catch (error) {
  console.error(`[pr-airtable-reconcile] ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
