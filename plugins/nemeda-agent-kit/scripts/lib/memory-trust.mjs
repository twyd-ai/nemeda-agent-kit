// The one human confirmation that trusts a workspace's central memory origin,
// its project, and any pending folder moves (docs/drive-config-plan.md,
// guards 1, 4, and 5). `nemeda-agent memory trust` and `nemeda-agent init
// --from-drive` both call it, so the gate has a single implementation: it
// shows what changes, needs an interactive terminal, and needs the person to
// type the service host (or the project id when there is no service), so an
// agent or a script cannot confirm it.
import { createInterface } from "node:readline/promises";
import { workspaceDriveEnvironment } from "./config-source.mjs";
import { meetingDestinations } from "./meetings-destinations.mjs";
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
  // Write destinations not pinned yet (the memory folder and the meetings
  // folders) would otherwise pin themselves silently on their first write,
  // leaving a window in which a configuration edit could point them
  // elsewhere unseen. The person confirming sees where journals, transcripts,
  // and notes go, and pins them in the same step.
  const driveEnvironment = workspaceDriveEnvironment(root, environment);
  const pinnedFolders = readWorkspacePins(root).folders || {};
  const unpinnedFolders = [
    ...(config.memory?.project?.path ? [{ kind: "memory", label: "memory folder", folder: config.memory.project.path }] : []),
    ...meetingDestinations(config.meetings).map((destination) => ({ kind: destination.kind, label: `meetings ${destination.name} folder`, folder: destination.folder }))
  ]
    .map((destination) => ({ ...destination, destination: folderIdentity(root, destination.folder, config.drive, driveEnvironment) }))
    .filter(({ kind, destination }) => destination.identity && destination.insideDrive !== false && !pinnedFolders[kind]);
  for (const folder of unpinnedFolders) plan.changes.push({ kind: folder.label, from: null, to: describeFolderIdentity(folder.destination.identity) });
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
  // The instruction gets its own line and the question a short prompt:
  // readline redraws the line once prompt plus typing reach the terminal
  // width, which a narrow panel leaves visibly duplicated.
  log(`Type ${expected} to trust it:`);
  const reader = createInterface({ input, output });
  let answer;
  try {
    answer = await reader.question("> ");
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
  for (const folder of unpinnedFolders) checkFolderPin(root, folder.kind, folder.destination, { recordFirstUse: true, via });
  log(`Trusted ${plan.changes.map((change) => change.kind).join(", ")} for this workspace; paused writers resume.`);
  return { trusted: true, changes: plan.changes };
}
