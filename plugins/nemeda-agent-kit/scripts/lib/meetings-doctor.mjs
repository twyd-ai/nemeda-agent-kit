// `nemeda-agent meeting doctor`, the meetings block of `nemeda-agent doctor`
// / `workspace_doctor`, and the SessionStart inbox context. Read-only. Works
// on a scratch copy of the environment so .env.local never leaks into the
// process, exactly like the Airtable checks.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { detectBackend } from "./backend.mjs";
import { meetingServiceStatus } from "./meetings-watch.mjs";
import { ENV_LOCAL_NAME, loadEnvLocal } from "./env.mjs";
import {
  HEARTBEAT_STALE_HOURS,
  MODEL_TIERS,
  activeTranscribers,
  discoverRecordings,
  findWhisperModel,
  installCommands,
  listClaims,
  minutesPerHour,
  probeHost,
  readSharedState,
  readState,
  recommendTier,
  resolveRole,
  resolveWatchFolder,
  selectEngine,
  tierOfModel
} from "./meetings-core.mjs";

// Loads .env.local into a scratch environment and probes the machine once.
export function resolveMeetingHost(root, environment = process.env, { explicitEngine = null, allowUninstalled = false, probe = {} } = {}) {
  const scratch = { ...environment };
  loadEnvLocal(root, scratch);
  const host = probeHost(scratch, probe);
  const selection = selectEngine(host, scratch, { explicit: explicitEngine, allowUninstalled });
  const tier = recommendTier(host);
  let role = null;
  let roleError = null;
  try {
    role = resolveRole(scratch);
  } catch (error) {
    roleError = error instanceof Error ? error.message : String(error);
  }
  return { environment: scratch, host, selection, tier, role, roleError, model: findWhisperModel(scratch), watch: resolveWatchFolder(scratch, host.platform) };
}

function describeHost(host) {
  const parts = [`${host.cores} cores`, `${host.totalMemoryGB} GB RAM`];
  if (host.platform === "darwin") parts.push(`macOS ${host.macosMajor ?? "?"} on ${host.appleSilicon ? "Apple Silicon (Metal)" : "Intel"}`);
  else parts.push(`${host.platform}/${host.arch}${host.gpu === "nvidia" ? " with NVIDIA GPU" : ", no GPU"}`);
  return parts.join(", ");
}

function firstSegment(relativePath) {
  return relativePath.replaceAll("\\", "/").split("/")[0];
}

export function meetingDoctorChecks(root, meetingsConfig, driveConfig, environment = process.env, options = {}) {
  const checks = [];
  const resolved = resolveMeetingHost(root, environment, options);
  const { host, selection, tier, model, watch, role, roleError } = resolved;
  const engine = selection.engine;
  const inbox = meetingsConfig.inbox ? path.join(root, meetingsConfig.inbox) : null;

  if (roleError) {
    checks.push({ status: "fail", code: "meetings-role", message: roleError });
  } else if (role !== "full" && !inbox) {
    checks.push({ status: "fail", code: "meetings-role", message: `Role ${role} needs meetings.inbox in .nemeda/agent-kit.json (a shared-drive folder every machine can see).` });
  } else {
    const roleText = { recorder: "records and hands finished recordings to the shared inbox; no transcription tools needed here", transcriber: "transcribes the shared inbox for the whole team", full: inbox ? "transcribes its own recordings and the shared inbox" : "records and transcribes on this machine" }[role];
    checks.push({ status: "pass", code: "meetings-role", message: `Role ${role}${resolved.environment.NEMEDA_MEETINGS_ROLE ? "" : " (default)"}: ${roleText}.` });
  }
  if (inbox) {
    const links = new Set(Object.keys(driveConfig?.links || {}));
    if (!existsSync(inbox)) {
      checks.push({ status: "fail", code: "meetings-inbox", message: `${meetingsConfig.inbox}/ is missing; run \`nemeda-agent setup\` (Drive link) or create it on the shared drive.` });
    } else if (driveConfig && !links.has(firstSegment(meetingsConfig.inbox))) {
      checks.push({ status: "warn", code: "meetings-inbox", message: `${meetingsConfig.inbox}/ is not inside a Drive link; other machines cannot see it.` });
    } else {
      checks.push({ status: "pass", code: "meetings-inbox", message: `Inbox ${meetingsConfig.inbox}/ exists${driveConfig ? " on the shared drive" : ""}.` });
    }
    if (existsSync(inbox)) {
      const active = activeTranscribers(inbox);
      const claims = listClaims(inbox);
      const shared = discoverRecordings(inbox, readSharedState(inbox));
      if (role === "recorder") {
        checks.push(active.length
          ? { status: "pass", code: "meetings-transcriber", message: `${active.length} transcriber(s) seen in the last ${HEARTBEAT_STALE_HOURS} h: ${active.map((beat) => `${beat.host} (${beat.engine || "?"})`).join(", ")}.` }
          : { status: "warn", code: "meetings-transcriber", message: `No transcriber has reported in the last ${HEARTBEAT_STALE_HOURS} h; recordings will pile up in the inbox until one runs \`nemeda-agent meeting process\`.` });
      }
      const inboxBacklog = [];
      if (shared.ready.length) inboxBacklog.push(`${shared.ready.length} waiting`);
      if (shared.pending.length) inboxBacklog.push(`${shared.pending.length} still syncing`);
      if (claims.length) inboxBacklog.push(`${claims.length} claimed (${claims.map((claim) => claim.host).join(", ")})`);
      checks.push(shared.ready.length && role !== "recorder"
        ? { status: "warn", code: "meetings-inbox-backlog", message: `Inbox: ${inboxBacklog.join(", ")}; run \`nemeda-agent meeting process\`.` }
        : { status: "pass", code: "meetings-inbox-backlog", message: `Inbox: ${inboxBacklog.length ? inboxBacklog.join(", ") : "empty"}.` });
    }
  }
  if (role === "recorder") {
    checks.push(watch && existsSync(watch)
      ? { status: "pass", code: "meetings-watch", message: `Recordings folder: ${watch}${resolved.environment.NEMEDA_MEETINGS_WATCH ? "" : " (from OBS)"}.` }
      : { status: "warn", code: "meetings-watch", message: `No recordings folder: OBS is ${host.tools.obs ? "installed but its profile has no RecFilePath" : "not installed"}; set NEMEDA_MEETINGS_WATCH in ${ENV_LOCAL_NAME}.` });
    return checks;
  }

  // Capability and recommendation.
  const estimateFor = (name, modelTier) => {
    const minutes = minutesPerHour(name, modelTier, host);
    return minutes === null ? "" : ` About ${minutes} min per hour of audio.`;
  };
  if (engine.name === "apple-speech") {
    checks.push({ status: "pass", code: "meetings-capability", message: `${describeHost(host)}: apple-speech uses the system model, no memory floor.${estimateFor("apple-speech")}` });
  } else if (tier.tier === null) {
    checks.push({ status: "warn", code: "meetings-capability", message: `${describeHost(host)}: ${tier.reason} (set NEMEDA_MEETINGS_ROLE=recorder once team roles ship).` });
  } else {
    checks.push({ status: "pass", code: "meetings-capability", message: `${describeHost(host)}: recommended whisper model ${tier.tier} (${tier.reason}).${estimateFor("whisper-cpp", tier.tier)}` });
  }

  // Engine.
  const steps = installCommands(host, { engineName: engine.name });
  const installHint = steps.length ? ` ${steps.map((step) => (step.command ? step.command.join(" ") : step.message)).join("; ")}` : "";
  if (selection.installed) {
    checks.push({ status: "pass", code: "meetings-engine", message: `Engine ${engine.name} (${selection.reason}).` });
  } else {
    checks.push({ status: "fail", code: "meetings-engine", message: `Engine ${engine.name} selected (${selection.reason}) but its binary is missing; run \`nemeda-agent meeting setup\`.${installHint}` });
  }
  if (selection.alternative === "apple-speech") {
    checks.push({ status: "warn", code: "meetings-engine", message: "This Mac can use apple-speech (faster, no model to download): brew install yap, or run `nemeda-agent meeting setup`." });
  }

  // ffmpeg and model, whisper engines only.
  if (engine.needsWav) {
    checks.push(host.tools.ffmpeg
      ? { status: "pass", code: "meetings-ffmpeg", message: "ffmpeg is available." }
      : { status: "fail", code: "meetings-ffmpeg", message: "ffmpeg is missing; run `nemeda-agent meeting setup`." });
  } else {
    checks.push({ status: "pass", code: "meetings-ffmpeg", message: `ffmpeg is not needed by ${engine.name}.` });
  }
  if (engine.needsModel) {
    if (!model) {
      checks.push({ status: "fail", code: "meetings-model", message: `No whisper model found${tier.tier ? `; \`nemeda-agent meeting setup\` downloads ${MODEL_TIERS[tier.tier].file} (${MODEL_TIERS[tier.tier].downloadMB} MB)` : ""}. Or set NEMEDA_WHISPER_MODEL in ${ENV_LOCAL_NAME}.` });
    } else {
      const modelTier = tierOfModel(model);
      const below = modelTier && tier.tier && MODEL_TIERS[modelTier].rank < MODEL_TIERS[tier.tier].rank;
      const above = modelTier && tier.tier === null;
      checks.push(below
        ? { status: "warn", code: "meetings-model", message: `Model ${path.basename(model)} is below the recommended ${tier.tier}; \`nemeda-agent meeting setup --model ${tier.tier}\` upgrades it.` }
        : above
          ? { status: "warn", code: "meetings-model", message: `Model ${path.basename(model)} found, but this machine is below the floor; transcription will be slow.` }
          : { status: "pass", code: "meetings-model", message: `Model ${path.basename(model)}${modelTier ? ` (${modelTier})` : ""}.${estimateFor("whisper-cpp", modelTier)}` });
    }
  }

  // Watch folder (not for transcribers, which only read the inbox).
  if (role === "transcriber") {
    // nothing local to watch
  } else if (!watch) {
    checks.push({ status: "warn", code: "meetings-watch", message: `No recordings folder: OBS is ${host.tools.obs ? "installed but its profile has no RecFilePath" : "not installed"}; set NEMEDA_MEETINGS_WATCH in ${ENV_LOCAL_NAME}.` });
  } else if (!existsSync(watch)) {
    checks.push({ status: "fail", code: "meetings-watch", message: `Recordings folder does not exist: ${watch}.` });
  } else {
    checks.push({ status: "pass", code: "meetings-watch", message: `Recordings folder: ${watch}${resolved.environment.NEMEDA_MEETINGS_WATCH ? "" : " (from OBS)"}.` });
  }

  // Folders on the shared drive.
  const links = new Set(Object.keys(driveConfig?.links || {}));
  for (const field of ["transcripts", "notes"]) {
    const relative = meetingsConfig[field];
    if (!relative) continue;
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) {
      checks.push({ status: field === "transcripts" ? "fail" : "warn", code: "meetings-folders", message: `${relative}/ is missing; run \`nemeda-agent setup\` (Drive link) or create it.` });
    } else if (driveConfig && !links.has(firstSegment(relative))) {
      checks.push({ status: "warn", code: "meetings-folders", message: `${relative}/ is not inside a Drive link; ${field} would stay on this machine.` });
    } else {
      checks.push({ status: "pass", code: "meetings-folders", message: `${relative}/ exists${driveConfig ? " on the shared drive" : ""}.` });
    }
  }

  // Notes, memory, retention.
  if (meetingsConfig.notes) {
    let detected;
    try {
      detected = detectBackend(resolved.environment);
      checks.push(detected.backend && detected.installed
        ? { status: "pass", code: "meetings-notes", message: `Notes will be written by ${detected.backend} (${detected.reason})${resolved.environment.NEMEDA_MEETINGS_MODEL ? `, model ${resolved.environment.NEMEDA_MEETINGS_MODEL}` : ""}.` }
        : { status: "warn", code: "meetings-notes", message: `No local agent for notes (${detected.reason}); transcripts are still filed, notes need the meeting-notes skill or \`nemeda-agent meeting notes\`.` });
    } catch (error) {
      checks.push({ status: "fail", code: "meetings-notes", message: error instanceof Error ? error.message : String(error) });
    }
  }
  checks.push(meetingsConfig.memory === false
    ? { status: "pass", code: "meetings-memory", message: "Meetings are not logged to the project memory (meetings.memory is false)." }
    : options.memoryConfigured
      ? { status: "pass", code: "meetings-memory", message: "Every transcribed meeting is logged to the project memory." }
      : { status: "warn", code: "meetings-memory", message: "No `memory` section: transcribed meetings are filed but not logged; add one (see docs/memory-plan.md)." });
  const policy = meetingsConfig.recordings;
  if (policy?.keep === "archive") {
    checks.push({ status: existsSync(path.join(root, policy.path)) ? "pass" : "warn", code: "meetings-retention", message: `Recordings are archived to ${policy.path}/ after transcription${existsSync(path.join(root, policy.path)) ? "" : " (folder missing; it is created on first use)"}.` });
  } else if (policy?.keep === "delete") {
    checks.push({ status: "pass", code: "meetings-retention", message: `Recordings are deleted ${policy.afterDays} days after their transcript exists.` });
  }

  // Unattended service.
  if (options.projectId) {
    const service = meetingServiceStatus(options.projectId, resolved.environment, host.platform);
    if (service.installed === null) {
      checks.push({ status: "pass", code: "meetings-service", message: "Unattended mode on Windows uses a Task Scheduler entry; `nemeda-agent meeting install` prints the command." });
    } else if (!service.installed) {
      checks.push({ status: "pass", code: "meetings-service", message: "No watch service installed; `nemeda-agent meeting install` starts the loop at login, or run `meeting watch` by hand." });
    } else if (service.loaded === false) {
      checks.push({ status: "warn", code: "meetings-service", message: `Watch service ${service.label} is installed but not loaded; ${host.platform === "darwin" ? `launchctl bootstrap gui/$(id -u) ${service.file}` : `systemctl --user enable --now ${service.label}`}.` });
    } else {
      checks.push({ status: "pass", code: "meetings-service", message: `Watch service ${service.label} is installed${service.loaded ? " and running" : ""}; logs in ${service.logFile}.` });
    }
  }

  // Backlog.
  if (watch && existsSync(watch)) {
    const discovered = discoverRecordings(watch, readState(root));
    const sizeMB = Math.round(discovered.ready.reduce((total, entry) => total + entry.size, 0) / 1024 / 1024);
    const minutes = minutesPerHour(engine.name, engine.needsModel ? tierOfModel(model) : null, host);
    const estimate = minutes === null ? "" : ` This machine needs about ${minutes} min per hour of audio.`;
    checks.push(discovered.ready.length
      ? { status: "warn", code: "meetings-backlog", message: `${discovered.ready.length} recording(s) ready (${sizeMB} MB)${discovered.pending.length ? `, ${discovered.pending.length} still being written` : ""}; run \`nemeda-agent meeting process\`.${estimate}` }
      : { status: "pass", code: "meetings-backlog", message: `No recordings waiting${discovered.pending.length ? ` (${discovered.pending.length} still being written)` : ""}.` });
  }
  return checks;
}

// SessionStart: one line when recordings are waiting, nothing otherwise.
// Directory listing only; never transcribes.
export function meetingInboxContext(root, meetingsConfig, environment = process.env) {
  if (!root || !meetingsConfig) return "";
  const scratch = { ...environment };
  loadEnvLocal(root, scratch);
  let role;
  try {
    role = resolveRole(scratch);
  } catch {
    return "";
  }
  const parts = [];
  const names = (entries) => entries.slice(0, 5).map((entry) => path.basename(entry.path)).join(", ") + (entries.length > 5 ? ", …" : "");
  if (role !== "transcriber") {
    const watch = resolveWatchFolder(scratch);
    if (watch && existsSync(watch) && statSync(watch).isDirectory()) {
      const local = discoverRecordings(watch, readState(root));
      if (local.ready.length) {
        parts.push(role === "recorder"
          ? `${local.ready.length} recording(s) in ${watch} waiting to be handed to the team inbox (${names(local.ready)})`
          : `${local.ready.length} recording(s) in ${watch} waiting to be transcribed (${names(local.ready)})`);
      }
    }
  }
  const inbox = meetingsConfig.inbox ? path.join(root, meetingsConfig.inbox) : null;
  if (inbox && role !== "recorder" && existsSync(inbox)) {
    const shared = discoverRecordings(inbox, readSharedState(inbox));
    if (shared.ready.length) parts.push(`${shared.ready.length} team recording(s) in the shared inbox ${meetingsConfig.inbox}/ (${names(shared.ready)})`);
  }
  if (parts.length === 0) return "";
  return `Meeting recordings waiting: ${parts.join("; ")}. Handle them with \`nemeda-agent meeting process\` (add --title "…" for one file); never transcribe or copy them by hand.`;
}
