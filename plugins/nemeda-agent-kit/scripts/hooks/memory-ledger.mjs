#!/usr/bin/env node
// SessionStart and Stop hook (same script, both events) — records this
// session's activity in the local ledger the unattended-capture harvester
// reads (docs/memory-plan.md, "Unattended capture"). A cheap, no-model
// upsert of one JSON file; never blocks, always exits 0, and is a fast
// no-op unless .nemeda/agent-kit.json has a `memory` section.
import { recordSessionActivity, resolveMemoryHookWorkspace } from "../lib/harvest.mjs";

// The Slack runner injects repository context itself and must stay
// read-only. A session the harvester itself resumed must never record
// itself or trigger further harvesting — this is load-bearing, not
// decorative: without it, harvesting could recurse into itself.
if (process.env.NEMEDA_SLACK_RUNNER || process.env.NEMEDA_MEMORY_HARVESTER) process.exit(0);

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const event = input.trim() ? JSON.parse(input) : {};
  const workspace = resolveMemoryHookWorkspace(event, process.env);
  if (workspace) {
    recordSessionActivity(workspace.root, { sessionId: event.session_id, cwd: event.cwd, environment: process.env });
  }
} catch (error) {
  console.error(`[memory-ledger] ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
