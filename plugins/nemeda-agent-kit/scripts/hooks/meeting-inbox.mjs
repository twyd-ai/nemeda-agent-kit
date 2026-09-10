#!/usr/bin/env node
// SessionStart hook — one context line when meeting recordings are waiting
// to be transcribed. Directory listing only: it never transcribes, never
// writes, and is a no-op without a `meetings` section. Always exits 0.
import { meetingInboxContext } from "../lib/meetings-doctor.mjs";
import { readWorkspaceContext } from "../lib/workspace.mjs";

if (process.env.NEMEDA_SLACK_RUNNER) process.exit(0);

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  let event = {};
  try {
    event = input.trim() ? JSON.parse(input) : {};
  } catch {
    event = {};
  }
  const context = readWorkspaceContext(event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const additionalContext = context.mode === "configured" ? meetingInboxContext(context.root, context.config?.meetings) : "";
  if (additionalContext) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })}\n`);
  }
} catch (error) {
  console.error(`[meeting-inbox] ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
