#!/usr/bin/env node
import { formatContextForHook, readWorkspaceContext } from "./lib/workspace.mjs";

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
