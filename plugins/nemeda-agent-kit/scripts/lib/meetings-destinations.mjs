// Guard 5 of docs/drive-config-plan.md for meeting capture: the folders that
// receive transcripts, notes, handed-off recordings, and archived recordings
// are pinned per workspace in the same store as the memory folder
// (memory-pins.mjs). When one moves within the shared drive, the unattended
// watch loop stops writing until a person runs `nemeda-agent memory trust`;
// interactive commands only warn. A folder that resolves outside the shared
// drive is refused for everyone.
//
// Kinds are named by role ("meetings:transcripts"), never by the configured
// path: a kind named after the path would change together with the path, and
// the new folder would be pinned silently as a first use.

import { workspaceDriveEnvironment } from "./config-source.mjs";
import { checkFolderPin, folderIdentity } from "./memory-pins.mjs";

export function meetingDestinations(meetingsConfig) {
  if (!meetingsConfig) return [];
  const destinations = [];
  if (meetingsConfig.transcripts) destinations.push({ name: "transcripts", folder: meetingsConfig.transcripts });
  if (meetingsConfig.notes) destinations.push({ name: "notes", folder: meetingsConfig.notes });
  if (meetingsConfig.inbox) destinations.push({ name: "inbox", folder: meetingsConfig.inbox });
  if (meetingsConfig.recordings?.keep === "archive" && meetingsConfig.recordings.path) {
    destinations.push({ name: "archive", folder: meetingsConfig.recordings.path });
  }
  return destinations.map((destination) => ({ ...destination, kind: `meetings:${destination.name}` }));
}

// { allowed, refused: [{ name, folder, kind, reason, message }], warnings: [...] }
// `recordFirstUse: false` (doctor, dry runs, the session hook) writes nothing.
export function checkMeetingDestinations(root, meetingsConfig, driveConfig, { unattended = false, environment = process.env, recordFirstUse = true } = {}) {
  // Same drive as the configuration loader: the given environment plus the
  // workspace .env.local.
  const env = workspaceDriveEnvironment(root, environment);
  const refused = [];
  const warnings = [];
  for (const destination of meetingDestinations(meetingsConfig)) {
    const identity = folderIdentity(root, destination.folder, driveConfig, env);
    const guard = checkFolderPin(root, destination.kind, identity, { unattended, recordFirstUse });
    if (!guard.allowed) {
      refused.push({ ...destination, reason: guard.reason, message: guard.message });
    } else if (guard.warning) {
      warnings.push({ ...destination, message: guard.warning });
    }
  }
  return { allowed: refused.length === 0, refused, warnings };
}

// The doctor rows: nothing when every destination is fine.
export function meetingDestinationChecks(root, meetingsConfig, driveConfig, environment = process.env) {
  const result = checkMeetingDestinations(root, meetingsConfig, driveConfig, { unattended: true, environment, recordFirstUse: false });
  return result.refused.map((entry) => ({
    status: entry.reason === "outside-drive" ? "fail" : "warn",
    code: "meetings-destination",
    message: entry.message
  }));
}
