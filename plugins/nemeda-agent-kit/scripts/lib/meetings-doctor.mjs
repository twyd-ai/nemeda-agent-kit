// `nemeda-agent meeting doctor`, the meetings block of `nemeda-agent doctor`
// / `workspace_doctor`, and the SessionStart inbox context. Read-only. Works
// on a scratch copy of the environment so .env.local never leaks into the
// process, exactly like the Airtable checks.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ENV_LOCAL_NAME, loadEnvLocal } from "./env.mjs";
import {
  MODEL_TIERS,
  discoverRecordings,
  findWhisperModel,
  installCommands,
  minutesPerHour,
  probeHost,
  readState,
  recommendTier,
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
  return { environment: scratch, host, selection, tier, model: findWhisperModel(scratch), watch: resolveWatchFolder(scratch, host.platform) };
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
  const { host, selection, tier, model, watch } = resolved;
  const engine = selection.engine;

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

  // Watch folder.
  if (!watch) {
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
  const watch = resolveWatchFolder(scratch);
  if (!watch || !existsSync(watch) || !statSync(watch).isDirectory()) return "";
  const discovered = discoverRecordings(watch, readState(root));
  if (discovered.ready.length === 0) return "";
  const names = discovered.ready.slice(0, 5).map((entry) => path.basename(entry.path)).join(", ");
  return `Meeting recordings waiting: ${discovered.ready.length} in ${watch} (${names}${discovered.ready.length > 5 ? ", …" : ""}). Transcribe them with \`nemeda-agent meeting process\` (add --title "…" for one file); never transcribe or copy them by hand.`;
}
