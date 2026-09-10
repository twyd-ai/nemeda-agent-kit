// `nemeda-agent meeting list | process` — turns finished meeting recordings
// into filed transcripts on the shared drive (docs/meeting-capture-plan.md).
// Discover recordings in the watched folder, extract audio with ffmpeg when
// the engine needs it, transcribe, and file the result under the project's
// `meetings.transcripts` folder. Same contract as `setup`: create-if-absent,
// every step reported as an action, nothing overwritten, nothing deleted.
// With `meetings.inbox` and NEMEDA_MEETINGS_ROLE the work splits across
// machines: recorders hand finished recordings to the inbox, transcribers
// drain it. Machine-level pieces (engines, models, OBS, discovery, claims)
// live in meetings-core.mjs so the doctor can use them without this file.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvLocal } from "./env.mjs";
import {
  claimRecording,
  discoverRecordings,
  expandHome,
  findWhisperModel,
  handOffRecording,
  listClaims,
  probeHost,
  readSharedState,
  readState,
  reclaimStale,
  recordKey,
  recordingTimestamp,
  releaseClaim,
  resolveRole,
  resolveWatchFolder,
  selectEngine,
  transcriptName,
  writeHeartbeat,
  writeSharedState,
  writeState
} from "./meetings-core.mjs";
import { archiveRecording, generateNotes, recordMeetingMemory, sweepDeletions } from "./meetings-notes.mjs";
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
  const role = resolveRole(environment);
  const inbox = meetings.inbox ? path.join(context.root, meetings.inbox) : null;
  if (role !== "full" && !inbox) {
    throw new Error(`NEMEDA_MEETINGS_ROLE=${role} needs \`meetings.inbox\` in .nemeda/agent-kit.json (a shared-drive folder both machines can see).`);
  }
  const machine = probeHost(environment, options.probe);
  const selection = selectEngine(machine, environment, { explicit: options.engine || null });
  const engine = selection.engine;
  const threads = Number.parseInt(environment.NEMEDA_MEETINGS_THREADS || "", 10) || Math.max(1, os.cpus().length);
  return {
    root: context.root,
    projectName: context.config.project.name,
    config: meetings,
    role,
    inbox,
    machine,
    engine,
    engineReason: selection.reason,
    engineInstalled: selection.installed,
    watch: role === "transcriber" ? null : resolveWatchFolder(environment, machine.platform),
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

function transcribesInbox(resolved) {
  return Boolean(resolved.inbox) && resolved.role !== "recorder";
}

export function listRecordings(start, options = {}) {
  const resolved = resolveMeetings(start, options);
  const state = readState(resolved.root);
  const local = discoverRecordings(resolved.watch, state);
  const inbox = resolved.inbox && existsSync(resolved.inbox) ? discoverRecordings(resolved.inbox, readSharedState(resolved.inbox)) : null;
  return {
    root: resolved.root,
    role: resolved.role,
    watch: resolved.watch,
    inbox: resolved.inbox,
    inboxExists: Boolean(inbox),
    engine: resolved.engine.name,
    engineReason: resolved.engineReason,
    engineInstalled: resolved.engineInstalled,
    model: resolved.model,
    ready: local.ready,
    pending: local.pending,
    twins: local.twins,
    processed: state.processed,
    inboxReady: inbox ? inbox.ready : [],
    inboxPending: inbox ? inbox.pending : [],
    inboxProcessed: inbox ? readSharedState(resolved.inbox).processed : [],
    claims: resolved.inbox ? listClaims(resolved.inbox) : []
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

// `recording.inputPath` (a claimed inbox file) is what gets read; `recording.path`
// stays the name everyone else knows the recording by.
export function transcribeRecording(resolved, recording, { title, dryRun = false, actions = [] } = {}) {
  const sourceName = path.basename(recording.path);
  const inputPath = recording.inputPath || recording.path;
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
    let input = inputPath;
    if (engine.needsWav) {
      input = path.join(workDirectory, "audio.wav");
      run(resolved.ffmpeg, ["-y", "-loglevel", "error", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", input], resolved.environment);
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
      sha256: sha256(inputPath),
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

// What follows a filed transcript: notes by the local agent, one memory
// entry, and the retention policy. Each step is best effort.
function afterTranscript(resolved, result, recordingPath, { actions, dryRun, skipNotes }) {
  const notes = skipNotes ? null : generateNotes(resolved, result.folder, result.meta, { actions, dryRun });
  recordMeetingMemory(resolved, result.folder, result.meta, notes, { actions, dryRun });
  const archived = archiveRecording(resolved, recordingPath, { actions, dryRun });
  return { notes, archived };
}

function processedEntry(recording, resolved, result) {
  return {
    path: recording.path,
    size: recording.size,
    mtime: recording.mtime,
    transcript: path.relative(resolved.root, result.folder),
    host: resolved.host,
    processedAt: result.meta.processedAt
  };
}

// Recorder side: copy every ready local recording into the inbox once.
function handOffLocal(resolved, targets, state, actions, dryRun) {
  const handed = [];
  if (!existsSync(resolved.inbox)) {
    actions.push(action("inbox", "error", `Inbox folder is missing: ${path.relative(resolved.root, resolved.inbox)}/ (run \`nemeda-agent setup\` so the Drive link exists).`));
    return handed;
  }
  for (const recording of targets) {
    const name = path.basename(recording.path);
    if (dryRun) {
      actions.push(action("handoff", "planned", `${name} -> ${path.relative(resolved.root, resolved.inbox)}/`));
      continue;
    }
    try {
      const { target, status } = handOffRecording(recording, resolved.inbox);
      state.processed.push({ path: recording.path, size: recording.size, mtime: recording.mtime, handedOff: target, host: resolved.host, processedAt: new Date().toISOString() });
      writeState(resolved.root, state);
      handed.push({ source: recording, target });
      actions.push(action("handoff", status, status === "created" ? `${name} copied to ${path.relative(resolved.root, resolved.inbox)}/; a transcriber will pick it up.` : `${name} is already in the inbox.`));
    } catch (error) {
      actions.push(action("handoff", "error", `${name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return handed;
}

// Transcriber side: claim, transcribe, release, record in the shared state.
function drainInbox(resolved, actions, dryRun, title, skipNotes) {
  const processed = [];
  if (!existsSync(resolved.inbox)) {
    actions.push(action("inbox", "error", `Inbox folder is missing: ${path.relative(resolved.root, resolved.inbox)}/ (run \`nemeda-agent setup\` so the Drive link exists).`));
    return processed;
  }
  if (!dryRun) {
    for (const released of reclaimStale(resolved.inbox, resolved.host)) {
      actions.push(action("claim", "warn", `Released a stale claim of this machine on ${path.basename(released)}.`));
    }
    writeHeartbeat(resolved.inbox, resolved.host, { engine: resolved.engine.name, role: resolved.role });
  }
  const shared = readSharedState(resolved.inbox);
  const discovered = discoverRecordings(resolved.inbox, shared);
  const others = listClaims(resolved.inbox).filter((claim) => claim.host !== resolved.host);
  actions.push(action("inbox", "ok", `${path.relative(resolved.root, resolved.inbox)}/: ${discovered.ready.length} ready, ${discovered.pending.length} still syncing, ${others.length} claimed by other machines, ${discovered.processed.length} already transcribed.`));
  if (title && discovered.ready.length > 1) {
    throw new Error(`--title applies to one recording, but ${discovered.ready.length} are ready in the inbox; pass the file explicitly.`);
  }
  for (const recording of discovered.ready) {
    if (dryRun) {
      transcribeRecording(resolved, recording, { title, dryRun, actions });
      continue;
    }
    let claimed;
    try {
      claimed = claimRecording(recording.path, resolved.host);
    } catch (error) {
      actions.push(action("claim", "warn", `${path.basename(recording.path)} was taken by another machine (${error instanceof Error ? error.message : String(error)}).`));
      continue;
    }
    try {
      const result = transcribeRecording(resolved, { ...recording, inputPath: claimed }, { title, dryRun, actions });
      if (result && !result.planned) {
        const latest = readSharedState(resolved.inbox);
        latest.processed.push({ ...processedEntry(recording, resolved, result), path: path.basename(recording.path) });
        writeSharedState(resolved.inbox, latest);
        processed.push(result);
        // Release the claim before touching the file again (archive moves it).
        releaseClaim(claimed);
        claimed = null;
        const { archived } = afterTranscript(resolved, result, recording.path, { actions, dryRun, skipNotes });
        if (archived) {
          const current = readSharedState(resolved.inbox);
          const entry = current.processed.find((item) => item.path === path.basename(recording.path));
          if (entry) entry.archivedTo = path.relative(resolved.root, archived);
          writeSharedState(resolved.inbox, current);
        }
      }
    } finally {
      if (claimed) releaseClaim(claimed);
    }
  }
  return processed;
}

export function processRecordings(start, options = {}) {
  const resolved = resolveMeetings(start, options);
  const dryRun = Boolean(options.dryRun);
  const actions = [];
  const state = readState(resolved.root);
  const processed = [];
  const handedOff = [];
  const canTranscribe = resolved.role !== "recorder";

  if (options.file) {
    const filePath = path.resolve(expandHome(options.file, options.environment || process.env));
    if (!existsSync(filePath)) throw new Error(`Recording not found: ${filePath}`);
    const stat = statSync(filePath);
    const entry = { path: filePath, size: stat.size, mtime: stat.mtimeMs };
    const already = state.processed.find((record) => recordKey(record) === recordKey(entry));
    if (already) {
      actions.push(action("transcript", "kept", already.transcript ? `${path.basename(filePath)} was already transcribed to ${already.transcript}/.` : `${path.basename(filePath)} was already handed off to the inbox.`));
    } else if (!canTranscribe) {
      handedOff.push(...handOffLocal(resolved, [entry], state, actions, dryRun));
    } else if (!dryRun && !existsSync(resolved.transcriptsDirectory)) {
      actions.push(action("folder", "error", `Transcripts folder is missing: ${path.relative(resolved.root, resolved.transcriptsDirectory)}/ (run \`nemeda-agent setup\` so the Drive link exists).`));
    } else {
      const result = transcribeRecording(resolved, entry, { title: options.title, dryRun, actions });
      if (result && !result.planned) {
        const record = processedEntry(entry, resolved, result);
        state.processed.push(record);
        writeState(resolved.root, state);
        processed.push(result);
        const { archived } = afterTranscript(resolved, result, entry.path, { actions, dryRun, skipNotes: options.skipNotes });
        if (archived) record.archivedTo = path.relative(resolved.root, archived);
        writeState(resolved.root, state);
      }
    }
    sweepDeletions(resolved, state, { actions, dryRun });
    writeState(resolved.root, state);
    return { root: resolved.root, role: resolved.role, dryRun, actions, processed, handedOff };
  }

  // Local folder: recorders hand off, transcribers have none, full transcribes.
  if (resolved.watch) {
    const discovered = discoverRecordings(resolved.watch, state);
    actions.push(action("discover", "ok", `${resolved.watch}: ${discovered.ready.length} ready, ${discovered.pending.length} still being written, ${discovered.processed.length} already ${canTranscribe ? "transcribed" : "handed off"}.`));
    if (options.title && discovered.ready.length > 1) {
      throw new Error(`--title applies to one recording, but ${discovered.ready.length} are ready; pass the file explicitly.`);
    }
    if (!canTranscribe) {
      handedOff.push(...handOffLocal(resolved, discovered.ready, state, actions, dryRun));
    } else if (discovered.ready.length && !dryRun && !existsSync(resolved.transcriptsDirectory)) {
      actions.push(action("folder", "error", `Transcripts folder is missing: ${path.relative(resolved.root, resolved.transcriptsDirectory)}/ (run \`nemeda-agent setup\` so the Drive link exists).`));
    } else {
      for (const recording of discovered.ready) {
        const result = transcribeRecording(resolved, recording, { title: options.title, dryRun, actions });
        if (!result || result.planned) continue;
        const record = processedEntry(recording, resolved, result);
        state.processed.push(record);
        writeState(resolved.root, state);
        processed.push(result);
        const { archived } = afterTranscript(resolved, result, recording.path, { actions, dryRun, skipNotes: options.skipNotes });
        if (archived) record.archivedTo = path.relative(resolved.root, archived);
        writeState(resolved.root, state);
      }
    }
  } else if (resolved.role === "full") {
    throw new Error("No recordings folder: set NEMEDA_MEETINGS_WATCH in .env.local (OBS's recording folder was not detected), or pass a file.");
  }

  // Shared inbox: transcribers and full machines drain it.
  if (transcribesInbox(resolved)) {
    if (!dryRun && !existsSync(resolved.transcriptsDirectory)) {
      actions.push(action("folder", "error", `Transcripts folder is missing: ${path.relative(resolved.root, resolved.transcriptsDirectory)}/ (run \`nemeda-agent setup\` so the Drive link exists).`));
    } else {
      processed.push(...drainInbox(resolved, actions, dryRun, options.title, options.skipNotes));
    }
  }
  // Retention sweep: local recordings, then the inbox copies (names relative to the inbox).
  if (sweepDeletions(resolved, state, { actions, dryRun }) && !dryRun) writeState(resolved.root, state);
  if (transcribesInbox(resolved) && existsSync(resolved.inbox)) {
    const shared = readSharedState(resolved.inbox);
    if (sweepDeletions(resolved, shared, { actions, dryRun, resolvePath: (entry) => path.join(resolved.inbox, entry.path) }) && !dryRun) writeSharedState(resolved.inbox, shared);
  }
  return { root: resolved.root, role: resolved.role, dryRun, actions, processed, handedOff };
}

// `nemeda-agent meeting notes FOLDER`: notes and memory for an existing
// transcript, for retries and for transcripts made before notes existed.
export function notesForTranscript(start, folder, options = {}) {
  const resolved = resolveMeetings(start, options);
  const transcriptFolder = path.resolve(resolved.root, expandHome(folder, resolved.environment));
  const metaPath = path.join(transcriptFolder, "meta.json");
  if (!existsSync(metaPath)) throw new Error(`Not a transcript folder (no meta.json): ${transcriptFolder}`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const actions = [];
  if (!resolved.notesDirectory) {
    actions.push(action("notes", "skipped", "meetings.notes is not configured; add it to .nemeda/agent-kit.json to write notes."));
  }
  const notes = resolved.notesDirectory ? generateNotes(resolved, transcriptFolder, meta, { actions, dryRun: Boolean(options.dryRun), force: Boolean(options.force) }) : null;
  const memory = notes && !notes.kept ? recordMeetingMemory(resolved, transcriptFolder, meta, notes, { actions, dryRun: Boolean(options.dryRun) }) : null;
  return { root: resolved.root, dryRun: Boolean(options.dryRun), actions, notes: notes?.notesPath ? path.relative(resolved.root, notes.notesPath) : null, memory: memory?.id || null };
}
