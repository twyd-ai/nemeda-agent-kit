// `nemeda-agent meeting list | process` — turns finished meeting recordings
// into filed transcripts on the shared drive (docs/meeting-capture-plan.md).
// Discover recordings in the watched folder, extract audio with ffmpeg when
// the engine needs it, transcribe, and file the result under the project's
// `meetings.transcripts` folder. Same contract as `setup`: create-if-absent,
// every step reported as an action, nothing overwritten, nothing deleted.
// Machine-level pieces (engines, models, OBS, discovery) live in
// meetings-core.mjs so the doctor can use them without importing this file.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvLocal } from "./env.mjs";
import {
  discoverRecordings,
  expandHome,
  findWhisperModel,
  probeHost,
  readState,
  recordKey,
  recordingTimestamp,
  resolveWatchFolder,
  selectEngine,
  transcriptName,
  writeState
} from "./meetings-core.mjs";
import { readWorkspaceContext, validateConfig } from "./workspace.mjs";

export * from "./meetings-core.mjs";

function action(kind, status, message, extra = {}) {
  return { kind, status, message, ...extra };
}

// ---------------------------------------------------------------------------
// Resolution: config + .env.local + detection, in one object the commands use.
// ---------------------------------------------------------------------------

export function resolveMeetings(start, options = {}) {
  const environment = options.environment || process.env;
  const context = readWorkspaceContext(start);
  if (context.mode !== "configured") {
    throw new Error("No .nemeda/agent-kit.json found; run `nemeda-agent init` first.");
  }
  if (validateConfig(context.config).some((issue) => issue.level === "error")) {
    throw new Error("Configuration is invalid; run `nemeda-agent doctor` and fix it before processing meetings.");
  }
  const meetings = context.config.meetings;
  if (!meetings) {
    throw new Error("This workspace has no `meetings` section in .nemeda/agent-kit.json; add one to enable meeting capture.");
  }
  loadEnvLocal(context.root, environment);
  const machine = probeHost(environment, options.probe);
  const selection = selectEngine(machine, environment, { explicit: options.engine || null });
  const engine = selection.engine;
  const threads = Number.parseInt(environment.NEMEDA_MEETINGS_THREADS || "", 10) || Math.max(1, os.cpus().length);
  return {
    root: context.root,
    config: meetings,
    machine,
    engine,
    engineReason: selection.reason,
    engineInstalled: selection.installed,
    watch: resolveWatchFolder(environment, machine.platform),
    model: engine.needsModel ? findWhisperModel(environment) : null,
    threads,
    language: meetings.language || context.config.policies?.conversationLanguage || "auto",
    naming: meetings.naming || "{date}-{slug}",
    transcriptsDirectory: path.join(context.root, meetings.transcripts),
    notesDirectory: meetings.notes ? path.join(context.root, meetings.notes) : null,
    ffmpeg: environment.NEMEDA_FFMPEG_BIN || "ffmpeg",
    host: os.hostname(),
    environment
  };
}

export function listRecordings(start, options = {}) {
  const resolved = resolveMeetings(start, options);
  const state = readState(resolved.root);
  const discovered = discoverRecordings(resolved.watch, state);
  return {
    root: resolved.root,
    watch: resolved.watch,
    engine: resolved.engine.name,
    engineReason: resolved.engineReason,
    engineInstalled: resolved.engineInstalled,
    model: resolved.model,
    ready: discovered.ready,
    pending: discovered.pending,
    twins: discovered.twins,
    processed: state.processed
  };
}

// ---------------------------------------------------------------------------
// Processing.
// ---------------------------------------------------------------------------

function run(file, args, environment) {
  const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: environment });
  if (result.error) throw new Error(`${file}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`${file} exited with status ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function uniqueTranscriptFolder(directory, name) {
  let candidate = path.join(directory, name);
  let counter = 2;
  while (existsSync(candidate)) {
    candidate = path.join(directory, `${name}-${counter}`);
    counter += 1;
  }
  return candidate;
}

export function transcribeRecording(resolved, recording, { title, dryRun = false, actions = [] } = {}) {
  const sourceName = path.basename(recording.path);
  const timestamp = recordingTimestamp(recording.path, new Date(recording.mtime));
  const name = transcriptName(resolved.naming, { timestamp, title });
  const folder = uniqueTranscriptFolder(resolved.transcriptsDirectory, name);
  const relativeFolder = path.relative(resolved.root, folder);
  const engine = resolved.engine;
  if (!resolved.engineInstalled) {
    actions.push(action("engine", "error", `Engine ${engine.name} is not installed (${engine.binary(resolved.environment)} not found); run \`nemeda-agent meeting setup\`.`));
    return null;
  }
  if (engine.needsModel && !resolved.model) {
    actions.push(action("model", "error", `No whisper model found for ${sourceName}; run \`nemeda-agent meeting setup\` or set NEMEDA_WHISPER_MODEL in .env.local.`));
    return null;
  }
  if (dryRun) {
    actions.push(action("transcript", "planned", `${sourceName} -> ${relativeFolder}/ (engine ${engine.name}${resolved.model ? `, model ${path.basename(resolved.model)}` : ""})`));
    return { source: recording, folder, planned: true };
  }
  const workDirectory = mkdtempSync(path.join(os.tmpdir(), "nemeda-meeting-"));
  try {
    let input = recording.path;
    if (engine.needsWav) {
      input = path.join(workDirectory, "audio.wav");
      run(resolved.ffmpeg, ["-y", "-loglevel", "error", "-i", recording.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", input], resolved.environment);
      actions.push(action("audio", "ok", `${sourceName}: audio extracted with ffmpeg.`));
    }
    const outputBase = path.join(workDirectory, "transcript");
    const command = engine.command({
      binary: engine.binary(resolved.environment),
      model: resolved.model,
      input,
      outputBase,
      language: resolved.language,
      threads: resolved.threads
    });
    const startedAt = Date.now();
    run(command.file, command.args, resolved.environment);
    const parsed = engine.parse(outputBase);
    if (parsed.text === null) throw new Error(`${engine.label} produced no transcript for ${sourceName}.`);
    if (!parsed.text) {
      actions.push(action("transcript", "warn", `${sourceName}: the transcript is empty (silent recording or wrong audio track?); nothing filed.`));
      return null;
    }
    mkdirSync(folder, { recursive: true });
    const meta = {
      title: title || null,
      source: recording.path,
      sourceName,
      sizeBytes: recording.size,
      sha256: sha256(recording.path),
      recordedAt: timestamp.toISOString(),
      durationSeconds: parsed.durationSeconds,
      engine: engine.name,
      model: resolved.model ? path.basename(resolved.model) : null,
      language: parsed.language || resolved.language,
      host: resolved.host,
      processedAt: new Date().toISOString(),
      transcriptionSeconds: Math.round((Date.now() - startedAt) / 1000)
    };
    writeFileSync(path.join(folder, "transcript.txt"), `${parsed.text}\n`);
    if (parsed.srt) writeFileSync(path.join(folder, "transcript.srt"), parsed.srt);
    writeFileSync(path.join(folder, "transcript.json"), `${JSON.stringify({ language: meta.language, durationSeconds: meta.durationSeconds, segments: parsed.segments }, null, 2)}\n`);
    writeFileSync(path.join(folder, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    actions.push(action("transcript", "created", `${sourceName} -> ${relativeFolder}/ (${meta.transcriptionSeconds}s with ${engine.label}).`, { transcript: relativeFolder }));
    return { source: recording, folder, meta };
  } catch (error) {
    actions.push(action("transcript", "error", `${sourceName}: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

export function processRecordings(start, options = {}) {
  const resolved = resolveMeetings(start, options);
  const dryRun = Boolean(options.dryRun);
  const actions = [];
  const state = readState(resolved.root);
  let targets = [];
  if (options.file) {
    const filePath = path.resolve(expandHome(options.file, options.environment || process.env));
    if (!existsSync(filePath)) throw new Error(`Recording not found: ${filePath}`);
    const stat = statSync(filePath);
    const entry = { path: filePath, size: stat.size, mtime: stat.mtimeMs };
    const already = state.processed.find((record) => recordKey(record) === recordKey(entry));
    if (already) {
      actions.push(action("transcript", "kept", `${path.basename(filePath)} was already transcribed to ${already.transcript}/.`));
    } else {
      targets = [entry];
    }
  } else {
    if (!resolved.watch) {
      throw new Error("No recordings folder: set NEMEDA_MEETINGS_WATCH in .env.local (OBS's recording folder was not detected), or pass a file.");
    }
    const discovered = discoverRecordings(resolved.watch, state);
    actions.push(action("discover", "ok", `${resolved.watch}: ${discovered.ready.length} ready, ${discovered.pending.length} still being written, ${discovered.processed.length} already transcribed.`));
    if (options.title && discovered.ready.length > 1) {
      throw new Error(`--title applies to one recording, but ${discovered.ready.length} are ready; pass the file explicitly.`);
    }
    targets = discovered.ready;
  }
  if (!dryRun && !existsSync(resolved.transcriptsDirectory)) {
    actions.push(action("folder", "error", `Transcripts folder is missing: ${path.relative(resolved.root, resolved.transcriptsDirectory)}/ (run \`nemeda-agent setup\` so the Drive link exists).`));
    return { root: resolved.root, dryRun, actions, processed: [] };
  }
  const processed = [];
  for (const recording of targets) {
    const result = transcribeRecording(resolved, recording, { title: options.title, dryRun, actions });
    if (!result || result.planned) continue;
    state.processed.push({
      path: recording.path,
      size: recording.size,
      mtime: recording.mtime,
      transcript: path.relative(resolved.root, result.folder),
      host: resolved.host,
      processedAt: result.meta.processedAt
    });
    writeState(resolved.root, state);
    processed.push(result);
  }
  return { root: resolved.root, dryRun, actions, processed };
}
