// The one human confirmation that trusts a workspace's central memory origin,
// its project, and any pending folder moves (docs/drive-config-plan.md,
// guards 1, 4, and 5). `nemeda-agent memory trust` and `nemeda-agent init
// --from-drive` both call it, so the gate has a single implementation: it
// shows what changes, needs an interactive terminal, and needs the person to
// type the service host (or the project id when there is no service), so an
// agent or a script cannot confirm it.
import { createInterface } from "node:readline/promises";
import { workspaceDriveEnvironment } from "./config-source.mjs";
import { centralSettings } from "./memory-central.mjs";
import {
  checkFolderPin,
  describeCentralTrust,
  describeFolderIdentity,
  folderIdentity,
  pendingFolderChanges,
  readWorkspacePins,
  serviceOrigin,
  trustCentralPins,
  trustPendingFolders
} from "./memory-pins.mjs";

// Returns { trusted, changes }: trusted is false when there was nothing to
// confirm. Throws when the terminal is not interactive, the typed answer does
// not match, or `url` names another origin than the configuration. `via`
// records which command pinned ("memory trust", "init --from-drive").
export async function confirmWorkspaceTrust(root, config, {
  configSource,
  url,
  via = "memory trust",
  environment = process.env,
  input = process.stdin,
  output = process.stdout
} = {}) {
  const log = (line) => output.write(`${line}\n`);
  const settings = centralSettings(config, { configSource });
  // Without a central section only folder moves can need confirming.
  const plan = settings
    ? describeCentralTrust(root, settings, environment)
    : { origin: null, projectId: config.project.id, configSource: configSource || "repository", changes: pendingFolderChanges(root) };
  // A memory folder not pinned yet would otherwise pin itself silently on the
  // first write, leaving a window in which a configuration edit could point
  // it elsewhere unseen. The person confirming sees where journals go and
  // pins it in the same step.
  const memoryDestination = config.memory?.project?.path
    ? folderIdentity(root, config.memory.project.path, config.drive, workspaceDriveEnvironment(root, environment))
    : null;
  const pinMemoryFolder = Boolean(memoryDestination?.identity) && memoryDestination.insideDrive !== false && !readWorkspacePins(root).folders?.memory;
  if (pinMemoryFolder) plan.changes.push({ kind: "memory folder", from: null, to: describeFolderIdentity(memoryDestination.identity) });
  if (url && serviceOrigin(url) !== plan.origin) {
    throw new Error(`This workspace uses ${plan.origin || "no service URL"}, not ${serviceOrigin(url) || url}; trust the URL its configuration names, or change the configuration first.`);
  }
  log(`Workspace ${root} (${plan.configSource} configuration):`);
  log(`  central memory service: ${plan.origin || "(none; --via psql only)"}`);
  log(`  promotes to project:    ${plan.projectId}`);
  if (!plan.changes.length) {
    log("Already trusted; nothing to confirm.");
    return { trusted: false, changes: [] };
  }
  for (const change of plan.changes) log(`  ${change.kind}: ${change.from || "(not trusted yet)"} -> ${change.to}`);
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Trusting needs a person at an interactive terminal: it decides where your token and this project's memory go, so an agent or a script cannot confirm it. Run it yourself in a terminal.");
  }
  const expected = plan.origin ? new URL(plan.origin).host : plan.projectId;
  const reader = createInterface({ input, output });
  let answer;
  try {
    answer = await reader.question(`Type ${expected} to trust it: `);
  } finally {
    reader.close();
  }
  if (String(answer).trim() !== expected) throw new Error("Not confirmed; nothing changed.");
  // Only what changed is rewritten, so each pin keeps an honest record of
  // which command confirmed it and when.
  if (settings && plan.changes.some((change) => change.kind === "origin" || change.kind === "project")) {
    trustCentralPins(root, { mcpUrl: settings.mcpUrl, projectId: settings.projectId }, environment, { via });
  }
  trustPendingFolders(root);
  if (pinMemoryFolder) checkFolderPin(root, "memory", memoryDestination, { recordFirstUse: true, via });
  log(`Trusted ${plan.changes.map((change) => change.kind).join(", ")} for this workspace; paused writers resume.`);
  return { trusted: true, changes: plan.changes };
}
