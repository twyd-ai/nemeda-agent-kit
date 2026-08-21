#!/usr/bin/env node
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

const context = readWorkspaceContext(event.cwd);
const additionalContext = formatContextForHook(context);
if (additionalContext) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext
    }
  })}\n`);
}
