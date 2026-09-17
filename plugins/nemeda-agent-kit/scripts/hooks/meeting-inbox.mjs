#!/usr/bin/env node
// SessionStart hook — one context line when meeting recordings are waiting
// to be transcribed, and one when the watch loop is paused because a
// meetings folder moved. Listing and reading only: it never transcribes,
// never writes, and is a no-op without a `meetings` section. Always exits 0.
import { checkMeetingDestinations } from "../lib/meetings-destinations.mjs";
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
  const context = readWorkspaceContext(event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(), { onPlaceholder: "cache" });
  const lines = [];
  if (context.mode === "configured" && context.config?.meetings) {
    const inboxLine = meetingInboxContext(context.root, context.config.meetings);
    if (inboxLine) lines.push(inboxLine);
    // Reads the pins only; the watch loop is what pauses.
    const destinations = checkMeetingDestinations(context.root, context.config.meetings, context.config.drive, { unattended: true, recordFirstUse: false });
    if (!destinations.allowed) {
      lines.push(`Meeting capture: the unattended watch loop is paused. ${destinations.refused.map((entry) => entry.message).join(" ")}`);
    }
  }
  const additionalContext = lines.join("\n");
  if (additionalContext) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })}\n`);
  }
} catch (error) {
  console.error(`[meeting-inbox] ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
