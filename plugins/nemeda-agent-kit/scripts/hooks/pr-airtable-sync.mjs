#!/usr/bin/env node
// PostToolUse hook (matcher: Bash). When a `gh pr create` succeeds and the
// command carries a labelled Airtable record id, the linked task moves to the
// configured in-progress status. Always exits 0.
import { prSyncFromEvent } from "../lib/hooks.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const event = input.trim() ? JSON.parse(input) : {};
  const result = await prSyncFromEvent(event);
  if (result.warning) console.error(`[pr-airtable-sync] ${result.warning}`);
  for (const error of result.errors || []) console.error(`[pr-airtable-sync] ${error}`);
  if (result.dryRun) console.log(JSON.stringify(result));
  else if (result.systemMessage) console.log(JSON.stringify({ systemMessage: result.systemMessage }));
} catch (error) {
  console.error(`[pr-airtable-sync] ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
