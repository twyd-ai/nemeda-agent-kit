#!/usr/bin/env node
import { recordSeenInstructions } from "./lib/config-source.mjs";
import { formatContextForHook, readWorkspaceContext } from "./lib/workspace.mjs";

// The Slack runner injects repository context itself and must stay read-only,
// so no hook side effects run inside a Slack-triggered session.
if (process.env.NEMEDA_SLACK_RUNNER) process.exit(0);

let input = "";
for await (const chunk of process.stdin) input += chunk;

let event = {};
try {
  event = input.trim() ? JSON.parse(input) : {};
} catch {
  event = {};
}

// A configuration on the shared drive that is not downloaded yet would block
// the session start; the last good copy is used instead and the next command
// downloads it.
const context = readWorkspaceContext(event.cwd, { onPlaceholder: "cache" });
const additionalContext = formatContextForHook(context);
if (additionalContext) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext
    }
  })}\n`);
  // Instructions from the drive are now in this session; a later change to
  // them is what doctor and the next session flag.
  if (context.configSource === "drive" || context.configSource === "drive-cache") {
    recordSeenInstructions(context.root, context.instructions);
  }
}
