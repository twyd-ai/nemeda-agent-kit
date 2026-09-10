#!/usr/bin/env node
// SessionStart and Stop hook (same script, both events) — records this
// session's activity in the local ledger the unattended-capture harvester
// reads (docs/memory-plan.md, "Unattended capture"). A cheap, no-model
// upsert of one JSON file; never blocks, always exits 0, and is a fast
// no-op unless .nemeda/agent-kit.json has a `memory` section.
//
// With --session-start (hooks.json passes it on SessionStart only, never on
// Stop, which fires after every turn) it also:
// - spawns a detached `nemeda-agent memory harvest` when MEMORY_HARVEST=true
//   and earlier sessions have closed, so nobody has to remember to run it;
// - tells the agent how many of the user's entries await `memory review`.
import { pendingReviewCount, recordSessionActivity, resolveMemoryHookWorkspace, shouldTriggerHarvest, spawnDetachedHarvest } from "../lib/harvest.mjs";

// The Slack runner injects repository context itself and must stay
// read-only. A session the harvester itself resumed must never record
// itself or trigger further harvesting — this is load-bearing, not
// decorative: without it, harvesting could recurse into itself.
if (process.env.NEMEDA_SLACK_RUNNER || process.env.NEMEDA_MEMORY_HARVESTER) process.exit(0);

const isSessionStart = process.argv.includes("--session-start");

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const event = input.trim() ? JSON.parse(input) : {};
  const workspace = resolveMemoryHookWorkspace(event, process.env);
  if (workspace) {
    recordSessionActivity(workspace.root, { sessionId: event.session_id, cwd: event.cwd, environment: process.env });
    if (isSessionStart) {
      const lines = [];
      const decision = shouldTriggerHarvest(workspace.root, workspace.config, process.env);
      if (decision.trigger) {
        spawnDetachedHarvest(workspace.root, { environment: process.env });
        lines.push(`Project memory: summarising ${decision.closed} earlier session${decision.closed === 1 ? "" : "s"} in the background; the resulting entries land as pending review (log: .nemeda/state/harvest.log).`);
      }
      const pending = pendingReviewCount(workspace.root, workspace.config, process.env);
      if (pending > 0) {
        lines.push(`Project memory: ${pending} ${pending === 1 ? "entry" : "entries"} by the user ${pending === 1 ? "is" : "are"} pending review; \`nemeda-agent memory review\` lists them and confirms each one.`);
      }
      if (lines.length) {
        process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } })}\n`);
      }
    }
  }
} catch (error) {
  console.error(`[memory-ledger] ${error instanceof Error ? error.message : String(error)}`);
}
// No process.exit here: on macOS a pipe write is asynchronous, and exiting
// immediately could drop the context line above. Nothing else keeps the
// loop alive — the detached harvest is unref'd.
process.exitCode = 0;
