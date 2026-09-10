// `nemeda-agent meeting` — turns finished meeting recordings into filed
// transcripts on the shared drive. Phase 1 of docs/meeting-capture-plan.md:
// discover recordings in the watched folder, extract audio with ffmpeg,
// transcribe with whisper.cpp, and file the result under the project's
// `meetings.transcripts` folder. Same contract as `setup`: create-if-absent,
// every step reported as an action, nothing overwritten, nothing deleted.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvLocal } from "./env.mjs";
import { readWorkspaceContext, validateConfig } from "./workspace.mjs";

// mp4 first: OBS "auto-remux" writes x.mkv while recording and x.mp4 when
// done, and the mp4 is the finished artifact when both are present.
export const RECORDING_EXTENSIONS = [".mp4", ".mkv", ".mov", ".m4a", ".wav", ".mp3"];
// A recording is ready when nothing has written to it for this long; OBS
// keeps touching the file until the encoder closes it.
export const STABLE_SECONDS = 60;
export const DEFAULT_ENGINE = "whisper-cpp";
export const STATE_FILE = "meetings.json";

const MODEL_SEARCH_DIRECTORIES = [path.join(os.homedir(), ".nemeda", "models"), path.join(os.homedir(), "whisper-models")];

function action(kind, status, message, extra = {}) {
  return { kind, status, message, ...extra };
}

function expandHome(candidate, environment = process.env) {
  if (typeof candidate !== "string" || !candidate) return candidate;
  if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    return path.join(environment.HOME || os.homedir(), candidate.slice(1));
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Engine adapters. Same shape as the drive providers: one table, one contract.
// Phase 1 ships whisper.cpp only; apple-speech lands in phase 2 with doctor.
// ---------------------------------------------------------------------------

const ENGINES = {
  "whisper-cpp": {
    label: "whisper.cpp",
    needsWav: true,
    needsModel: true,
    binary: (environment) => environment.NEMEDA_WHISPER_BIN || "whisper-cli",
    command({ binary, model, input, outputBase, language, threads }) {
      return {
        file: binary,
        args: ["-m", model, "-f", input, "-l", language, "-t", String(threads), "-otxt", "-osrt", "-oj", "-of", outputBase, "-np"]
      };
    },
    parse(outputBase) {
      const text = readIfExists(`${outputBase}.txt`);
      const srt = readIfExists(`${outputBase}.srt`);
      const rawJson = readIfExists(`${outputBase}.json`);
      let language = null;
      let segments = [];
      if (rawJson) {
        try {
          const parsed = JSON.parse(rawJson);
          language = parsed?.result?.language || null;
          segments = (parsed?.transcription || []).map((segment) => ({
            start: (segment?.offsets?.from ?? 0) / 1000,
            end: (segment?.offsets?.to ?? 0) / 1000,
            text: String(segment?.text || "").trim()
          }));
        } catch {
          segments = [];
        }
      }
      const durationSeconds = segments.length ? segments[segments.length - 1].end : null;
      return { text: text === null ? null : text.trim(), srt, language, segments, durationSeconds };
    }
  }
};

export function engineNames() {
  return Object.keys(ENGINES);
}

export function resolveEngine(name = DEFAULT_ENGINE) {
  const engine = ENGINES[name];
  if (!engine) throw new Error(`Unknown transcription engine "${name}"; available: ${engineNames().join(", ")}.`);
  return { name, ...engine };
}

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

export function findWhisperModel(environment = process.env, searchDirectories = MODEL_SEARCH_DIRECTORIES) {
  const explicit = expandHome(environment.NEMEDA_WHISPER_MODEL, environment);
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const directory of searchDirectories) {
    if (!existsSync(directory)) continue;
    const candidate = readdirSync(directory)
      .filter((name) => /^ggml-.*\.bin$/.test(name) && !name.startsWith("for-tests-"))
      .sort()[0];
    if (candidate) return path.join(directory, candidate);
  }
  return null;
}

// ---------------------------------------------------------------------------
// OBS: the recordings folder comes from the active profile so the common
// case needs no configuration at all.
// ---------------------------------------------------------------------------

export function obsProfileDirectories(environment = process.env, platform = process.platform) {
  const home = environment.HOME || os.homedir();
  if (platform === "darwin") return [path.join(home, "Library", "Application Support", "obs-studio", "basic", "profiles")];
  if (platform === "win32") return [path.join(environment.APPDATA || path.join(home, "AppData", "Roaming"), "obs-studio", "basic", "profiles")];
  return [path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "obs-studio", "basic", "profiles")];
}

export function detectObsRecordingFolder(environment = process.env, platform = process.platform) {
  for (const profilesDirectory of obsProfileDirectories(environment, platform)) {
    if (!existsSync(profilesDirectory)) continue;
    for (const profile of readdirSync(profilesDirectory)) {
      const ini = path.join(profilesDirectory, profile, "basic.ini");
      if (!existsSync(ini)) continue;
      const match = readFileSync(ini, "utf8").match(/^RecFilePath=(.+)$/m);
      if (match && existsSync(match[1].trim())) return match[1].trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Naming. `{date}` comes from the recording (OBS names files
// "YYYY-MM-DD HH-mm-ss"), `{slug}` from --title. The slug is restricted to
// the strictest provider's character set (OneDrive), so the folder name is
// valid on every shared drive.
// ---------------------------------------------------------------------------

export function slugify(title) {
  const slug = String(title || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function recordingTimestamp(filePath, mtime) {
  const base = path.basename(filePath, path.extname(filePath));
  const match = base.match(/(\d{4})-(\d{2})-(\d{2})(?:[ _T-](\d{2})[-:.](\d{2})(?:[-:.](\d{2}))?)?/);
  if (match) {
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return mtime instanceof Date ? mtime : new Date(mtime);
}

export function transcriptName(template, { timestamp, title }) {
  const date = `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())}`;
  const time = `${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}`;
  return template.replaceAll("{date}", date).replaceAll("{time}", time).replaceAll("{slug}", slugify(title));
}

// ---------------------------------------------------------------------------
// State: one record per processed recording, keyed by path + size + mtime so
// a re-exported file with the same name is seen as new.
// ---------------------------------------------------------------------------

export function statePath(root) {
  return path.join(root, ".nemeda", "state", STATE_FILE);
}

export function readState(root) {
  const filePath = statePath(root);
  if (!existsSync(filePath)) return { processed: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return { processed: Array.isArray(parsed?.processed) ? parsed.processed : [] };
  } catch {
    return { processed: [] };
  }
}

export function writeState(root, state) {
  const filePath = statePath(root);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function recordKey(entry) {
  return `${entry.path}|${entry.size}|${entry.mtime}`;
}

function twinKey(filePath) {
  return path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)));
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
  const engine = resolveEngine(options.engine || environment.NEMEDA_MEETINGS_ENGINE || DEFAULT_ENGINE);
  const watch = expandHome(environment.NEMEDA_MEETINGS_WATCH, environment) || detectObsRecordingFolder(environment) || null;
  const threads = Number.parseInt(environment.NEMEDA_MEETINGS_THREADS || "", 10) || Math.max(1, os.cpus().length);
  return {
    root: context.root,
    config: meetings,
    engine,
    watch,
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

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

export function discoverRecordings(watch, state, { now = Date.now(), stableSeconds = STABLE_SECONDS } = {}) {
  const result = { ready: [], pending: [], processed: [], twins: [] };
  if (!watch || !existsSync(watch)) return result;
  const processedKeys = new Set(state.processed.map(recordKey));
  const processedPaths = new Map();
  for (const entry of state.processed) {
    if (!processedPaths.has(twinKey(entry.path))) processedPaths.set(twinKey(entry.path), new Set());
    processedPaths.get(twinKey(entry.path)).add(entry.path);
  }
  const seenTwins = new Set();
  const candidates = readdirSync(watch, { withFileTypes: true })
    .filter((entry) => entry.isFile() && RECORDING_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(watch, entry.name))
    // Chronological (OBS names are date-first); extension priority only decides between twins.
    .sort((a, b) => twinKey(a).localeCompare(twinKey(b)) || RECORDING_EXTENSIONS.indexOf(path.extname(a).toLowerCase()) - RECORDING_EXTENSIONS.indexOf(path.extname(b).toLowerCase()));
  for (const filePath of candidates) {
    const stat = statSync(filePath);
    const entry = { path: filePath, size: stat.size, mtime: stat.mtimeMs };
    if (processedKeys.has(recordKey(entry))) {
      result.processed.push(entry);
      continue;
    }
    const twin = twinKey(filePath);
    const processedSiblings = processedPaths.get(twin);
    const hiddenByProcessedTwin = Boolean(processedSiblings) && !processedSiblings.has(filePath);
    if (hiddenByProcessedTwin || seenTwins.has(twin)) {
      result.twins.push(entry);
      continue;
    }
    seenTwins.add(twin);
    if (now - stat.mtimeMs < stableSeconds * 1000) result.pending.push(entry);
    else result.ready.push(entry);
  }
  return result;
}

export function listRecordings(start, options = {}) {
  const resolved = resolveMeetings(start, options);
  const state = readState(resolved.root);
  const discovered = discoverRecordings(resolved.watch, state);
  return {
    root: resolved.root,
    watch: resolved.watch,
    engine: resolved.engine.name,
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
  if (resolved.engine.needsModel && !resolved.model) {
    actions.push(action("model", "error", `No whisper model found for ${sourceName}; set NEMEDA_WHISPER_MODEL in .env.local or place a ggml-*.bin under ~/.nemeda/models/.`));
    return null;
  }
  if (dryRun) {
    actions.push(action("transcript", "planned", `${sourceName} -> ${relativeFolder}/ (engine ${resolved.engine.name}${resolved.model ? `, model ${path.basename(resolved.model)}` : ""})`));
    return { source: recording, folder, planned: true };
  }
  const workDirectory = mkdtempSync(path.join(os.tmpdir(), "nemeda-meeting-"));
  try {
    let input = recording.path;
    if (resolved.engine.needsWav) {
      input = path.join(workDirectory, "audio.wav");
      run(resolved.ffmpeg, ["-y", "-loglevel", "error", "-i", recording.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", input], resolved.environment);
      actions.push(action("audio", "ok", `${sourceName}: audio extracted with ffmpeg.`));
    }
    const outputBase = path.join(workDirectory, "transcript");
    const command = resolved.engine.command({
      binary: resolved.engine.binary(resolved.environment),
      model: resolved.model,
      input,
      outputBase,
      language: resolved.language,
      threads: resolved.threads
    });
    const startedAt = Date.now();
    run(command.file, command.args, resolved.environment);
    const parsed = resolved.engine.parse(outputBase);
    if (parsed.text === null) throw new Error(`${resolved.engine.label} produced no transcript for ${sourceName}.`);
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
      engine: resolved.engine.name,
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
    actions.push(action("transcript", "created", `${sourceName} -> ${relativeFolder}/ (${meta.transcriptionSeconds}s with ${resolved.engine.label}).`, { transcript: relativeFolder }));
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
