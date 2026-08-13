#!/usr/bin/env node
// Stop hook — creates ONE "Pending" Knowledge Log entry per session, deduped
// by session_id. Disabled unless KNOWLEDGE_LOG_AUTO=true in .env.local; the
// recommended flow is the reviewed /klog command. Always exits 0.
import { logSessionFromEvent } from "../lib/hooks.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const event = input.trim() ? JSON.parse(input) : {};
  const result = await logSessionFromEvent(event);
  for (const error of result.errors || []) console.error(`[session-log] ${error}`);
  if (result.systemMessage) console.log(JSON.stringify({ systemMessage: result.systemMessage }));
} catch (error) {
  console.error(`[session-log] ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
