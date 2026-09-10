import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectObsRecordingFolder,
  discoverRecordings,
  findWhisperModel,
  listRecordings,
  processRecordings,
  readState,
  recordingTimestamp,
  resolveEngine,
  slugify,
  transcriptName
} from "../scripts/lib/meetings.mjs";
import { formatContextForHook, readWorkspaceContext, validateConfig } from "../scripts/lib/workspace.mjs";

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "nemeda-meetings-"));
}

function baseConfig(meetings = { transcripts: "docs/transcripts", notes: "docs/meetings", language: "es" }) {
  return {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "workspace", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true, conversationLanguage: "es" },
    ...(meetings ? { meetings } : {})
  };
}

function makeWorkspace(config = baseConfig()) {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  if (config.meetings?.transcripts) mkdirSync(path.join(root, config.meetings.transcripts), { recursive: true });
  return root;
}

// Old recordings: mtime well past the stability window.
function writeRecording(directory, name, { ageSeconds = 600, content = "video" } = {}) {
  const filePath = path.join(directory, name);
  writeFileSync(filePath, content);
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(filePath, when, when);
  return filePath;
}

// Stub binaries: ffmpeg copies its input to the output path, whisper-cli
// writes canned outputs next to the -of base. Both record their argv so
// tests can assert the exact command line.
function withStubs(environment, { whisperText = "Hola equipo. Decidimos lanzar el lunes.", whisperFails = false } = {}) {
  const binDir = temporaryDirectory();
  const ffmpeg = path.join(binDir, "ffmpeg");
  writeFileSync(ffmpeg, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.STUB_LOG_FFMPEG, JSON.stringify(args));
fs.copyFileSync(args[args.indexOf("-i") + 1], args[args.length - 1]);
`);
  const whisper = path.join(binDir, "whisper-cli");
  writeFileSync(whisper, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.STUB_LOG_WHISPER, JSON.stringify(args));
if (${whisperFails}) { console.error("model load failed"); process.exit(3); }
const base = args[args.indexOf("-of") + 1];
fs.writeFileSync(base + ".txt", ${JSON.stringify(whisperText)} + "\\n");
fs.writeFileSync(base + ".srt", "1\\n00:00:00,000 --> 00:00:04,000\\n" + ${JSON.stringify(whisperText)} + "\\n");
fs.writeFileSync(base + ".json", JSON.stringify({ result: { language: "es" }, transcription: [
  { offsets: { from: 0, to: 4000 }, text: ${JSON.stringify(whisperText)} },
  { offsets: { from: 4000, to: 9500 }, text: " Fin." }
] }));
`);
  chmodSync(ffmpeg, 0o755);
  chmodSync(whisper, 0o755);
  const model = path.join(binDir, "ggml-small.bin");
  writeFileSync(model, "model");
  // PATH and HOME come from the real environment so `#!/usr/bin/env node` resolves.
  return {
    ...process.env,
    // Pin the base engine: on a macOS 26 Mac with yap installed the default would be apple-speech.
    NEMEDA_MEETINGS_ENGINE: "whisper-cpp",
    ...environment,
    NEMEDA_FFMPEG_BIN: ffmpeg,
    NEMEDA_WHISPER_BIN: whisper,
    NEMEDA_WHISPER_MODEL: model,
    NEMEDA_MEETINGS_THREADS: "3",
    STUB_LOG_FFMPEG: path.join(binDir, "ffmpeg.log"),
    STUB_LOG_WHISPER: path.join(binDir, "whisper.log")
  };
}

test("validateConfig accepts a minimal meetings section and rejects bad values", () => {
  assert.deepEqual(validateConfig(baseConfig({ transcripts: "docs/transcripts" })).filter((issue) => issue.code === "invalid-meetings"), []);
  assert.deepEqual(validateConfig(baseConfig(null)).filter((issue) => issue.code === "invalid-meetings"), []);
  const bad = [
    { transcripts: "/abs/path" },
    { transcripts: "../outside" },
    { notes: "docs/meetings" },
    { transcripts: "docs/t", language: "español" },
    { transcripts: "docs/t", naming: "{slug}" },
    { transcripts: "docs/t", naming: "{date}/{slug}" },
    { transcripts: "docs/t", naming: "{date}-{owner}" },
    { transcripts: "docs/t", knowledgeLog: "yes" },
    { transcripts: "docs/t", recordings: { keep: "forever" } },
    { transcripts: "docs/t", recordings: { keep: "delete" } },
    { transcripts: "docs/t", recordings: { keep: "delete", afterDays: 0 } },
    { transcripts: "docs/t", extra: true }
  ];
  for (const meetings of bad) {
    const issues = validateConfig(baseConfig(meetings));
    assert.equal(issues.some((issue) => issue.code === "invalid-meetings" || issue.code === "unknown-field"), true, JSON.stringify(meetings));
  }
  const good = validateConfig(baseConfig({ transcripts: "docs/t", notes: "docs/m", inbox: "docs/recordings/inbox", language: "pt-BR", naming: "{date}-{time}-{slug}", knowledgeLog: true, recordings: { keep: "delete", afterDays: 30 } }));
  assert.deepEqual(good.filter((issue) => issue.level === "error"), []);
});

test("session context tells agents where transcripts land and how to produce them", () => {
  const root = makeWorkspace();
  const text = formatContextForHook(readWorkspaceContext(root));
  assert.match(text, /docs\/transcripts\//);
  assert.match(text, /docs\/meetings\//);
  assert.match(text, /nemeda-agent meeting process/);
  assert.doesNotMatch(formatContextForHook(readWorkspaceContext(makeWorkspace(baseConfig(null)))), /meeting process/);
});

test("slugify and transcriptName produce OneDrive-safe folder names", () => {
  assert.equal(slugify("Reunión de Kick-off: Q3/2026 <plan>"), "reunion-de-kick-off-q3-2026-plan");
  assert.equal(slugify(""), "untitled");
  assert.equal(slugify("   "), "untitled");
  assert.equal(slugify("a".repeat(100)).length, 60);
  const timestamp = new Date(2026, 8, 10, 9, 5, 0);
  assert.equal(transcriptName("{date}-{slug}", { timestamp, title: "Weekly sync" }), "2026-09-10-weekly-sync");
  assert.equal(transcriptName("{date}-{time}-{slug}", { timestamp, title: undefined }), "2026-09-10-0905-untitled");
});

test("recordingTimestamp reads OBS file names and falls back to mtime", () => {
  const fromName = recordingTimestamp("/r/2026-09-10 14-30-05.mkv", new Date(2020, 0, 1));
  assert.deepEqual([fromName.getFullYear(), fromName.getMonth(), fromName.getDate(), fromName.getHours(), fromName.getMinutes()], [2026, 8, 10, 14, 30]);
  const dateOnly = recordingTimestamp("/r/2026-09-10 kickoff.mp4", new Date(2020, 0, 1));
  assert.deepEqual([dateOnly.getFullYear(), dateOnly.getMonth(), dateOnly.getDate()], [2026, 8, 10]);
  const fallback = recordingTimestamp("/r/zoom_recording.mp4", new Date(2025, 4, 2, 10, 0));
  assert.equal(fallback.getFullYear(), 2025);
  assert.equal(fallback.getMonth(), 4);
});

test("discoverRecordings applies the stability window, twin dedupe, and processed state", () => {
  const watch = temporaryDirectory();
  const ready = writeRecording(watch, "2026-09-01 10-00-00.mkv");
  writeRecording(watch, "2026-09-01 10-00-00.mp4"); // remuxed twin: preferred over the mkv
  const fresh = writeRecording(watch, "2026-09-02 11-00-00.mkv", { ageSeconds: 5 });
  const done = writeRecording(watch, "2026-09-03 12-00-00.mkv");
  writeRecording(watch, "notes.txt");
  mkdirSync(path.join(watch, "2026-09-04 13-00-00.mkv")); // a directory with a recording name is ignored
  const state = { processed: [{ path: done, size: 5, mtime: 0 }] };
  // The processed entry must match size+mtime to count; mismatch means "new file with the same name".
  const first = discoverRecordings(watch, state);
  assert.deepEqual(first.ready.map((entry) => path.basename(entry.path)), ["2026-09-01 10-00-00.mp4", "2026-09-03 12-00-00.mkv"]);
  assert.deepEqual(first.twins.map((entry) => path.basename(entry.path)), ["2026-09-01 10-00-00.mkv"]);
  assert.deepEqual(first.pending.map((entry) => path.basename(entry.path)), [path.basename(fresh)]);
  const exact = first.ready.find((entry) => entry.path === done);
  const second = discoverRecordings(watch, { processed: [{ ...exact, transcript: "x" }] });
  assert.deepEqual(second.processed.map((entry) => entry.path), [done]);
  assert.equal(second.ready.some((entry) => entry.path === done), false);
  assert.equal(second.ready.some((entry) => entry.path === ready), false, "the mkv twin stays hidden behind its mp4");
  assert.deepEqual(discoverRecordings(null, state), { ready: [], pending: [], processed: [], twins: [] });
});

test("findWhisperModel honours the env override and skips the whisper.cpp test model", () => {
  const models = temporaryDirectory();
  writeFileSync(path.join(models, "for-tests-ggml-tiny.bin"), "x");
  assert.equal(findWhisperModel({}, [models]), null);
  writeFileSync(path.join(models, "ggml-large-v3-turbo.bin"), "x");
  assert.equal(findWhisperModel({}, [models]), path.join(models, "ggml-large-v3-turbo.bin"));
  assert.equal(findWhisperModel({ NEMEDA_WHISPER_MODEL: path.join(models, "missing.bin") }, [models]), null);
  const home = temporaryDirectory();
  writeFileSync(path.join(home, "m.bin"), "x");
  assert.equal(findWhisperModel({ NEMEDA_WHISPER_MODEL: "~/m.bin", HOME: home }, [models]), path.join(home, "m.bin"));
});

test("detectObsRecordingFolder reads RecFilePath from the active profile", () => {
  const home = temporaryDirectory();
  const recordings = path.join(home, "Movies");
  mkdirSync(recordings);
  const profile = path.join(home, "Library", "Application Support", "obs-studio", "basic", "profiles", "Untitled");
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, "basic.ini"), `[Output]\nMode=Simple\n\n[SimpleOutput]\nFilePath=${path.join(home, "Downloads")}\nRecFormat2=mkv\n\n[AdvOut]\nRecFilePath=${recordings}\n`);
  assert.equal(detectObsRecordingFolder({ HOME: home }, "darwin"), recordings);
  assert.equal(detectObsRecordingFolder({ HOME: temporaryDirectory() }, "darwin"), null);
  assert.equal(detectObsRecordingFolder({ HOME: home }, "linux"), null);
});

test("resolveEngine only knows the shipped adapters", () => {
  assert.equal(resolveEngine().name, "whisper-cpp");
  assert.equal(resolveEngine("apple-speech").needsModel, false);
  assert.throws(() => resolveEngine("parakeet"), /Unknown transcription engine/);
});

test("processRecordings transcribes ready recordings end to end with stubs and is idempotent", () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  writeRecording(watch, "2026-09-10 09-00-00.mkv", { content: "first" });
  writeRecording(watch, "2026-09-11 15-30-00.mp4", { content: "second" });
  writeRecording(watch, "2026-09-12 16-00-00.mkv", { ageSeconds: 2, content: "still-writing" });
  const environment = withStubs({ NEMEDA_MEETINGS_WATCH: watch });

  const dry = processRecordings(root, { environment, dryRun: true });
  assert.equal(dry.actions.filter((entry) => entry.status === "planned").length, 2);
  assert.equal(existsSync(path.join(root, "docs", "transcripts", "2026-09-10-untitled")), false);
  assert.equal(readState(root).processed.length, 0);

  const report = processRecordings(root, { environment });
  const created = report.actions.filter((entry) => entry.kind === "transcript" && entry.status === "created");
  assert.equal(created.length, 2, JSON.stringify(report.actions));
  assert.equal(report.actions.some((entry) => entry.status === "error"), false);
  const folder = path.join(root, "docs", "transcripts", "2026-09-10-untitled");
  assert.equal(readFileSync(path.join(folder, "transcript.txt"), "utf8"), "Hola equipo. Decidimos lanzar el lunes.\n");
  assert.match(readFileSync(path.join(folder, "transcript.srt"), "utf8"), /00:00:00,000 --> 00:00:04,000/);
  const transcript = JSON.parse(readFileSync(path.join(folder, "transcript.json"), "utf8"));
  assert.equal(transcript.language, "es");
  assert.equal(transcript.durationSeconds, 9.5);
  assert.equal(transcript.segments.length, 2);
  const meta = JSON.parse(readFileSync(path.join(folder, "meta.json"), "utf8"));
  assert.equal(meta.sourceName, "2026-09-10 09-00-00.mkv");
  assert.equal(meta.engine, "whisper-cpp");
  assert.equal(meta.model, "ggml-small.bin");
  assert.equal(meta.language, "es");
  assert.match(meta.sha256, /^[0-9a-f]{64}$/);
  assert.match(meta.recordedAt, /^2026-09-10T/);
  assert.equal(existsSync(path.join(root, "docs", "transcripts", "2026-09-11-untitled", "meta.json")), true);

  // The command lines are exactly what whisper.cpp and ffmpeg expect.
  const ffmpegArgs = JSON.parse(readFileSync(environment.STUB_LOG_FFMPEG, "utf8"));
  assert.deepEqual(ffmpegArgs.slice(-7, -1), ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]);
  assert.match(ffmpegArgs[ffmpegArgs.length - 1], /audio\.wav$/);
  assert.equal(ffmpegArgs[ffmpegArgs.indexOf("-i") + 1].endsWith("2026-09-11 15-30-00.mp4") || ffmpegArgs[ffmpegArgs.indexOf("-i") + 1].endsWith("2026-09-10 09-00-00.mkv"), true);
  const whisperArgs = JSON.parse(readFileSync(environment.STUB_LOG_WHISPER, "utf8"));
  assert.equal(whisperArgs[whisperArgs.indexOf("-m") + 1], environment.NEMEDA_WHISPER_MODEL);
  assert.equal(whisperArgs[whisperArgs.indexOf("-l") + 1], "es");
  assert.equal(whisperArgs[whisperArgs.indexOf("-t") + 1], "3");
  for (const flag of ["-otxt", "-osrt", "-oj", "-np"]) assert.ok(whisperArgs.includes(flag), flag);

  // State records both; a second run finds nothing new and touches nothing.
  const state = readState(root);
  assert.equal(state.processed.length, 2);
  assert.equal(state.processed[0].transcript, path.join("docs", "transcripts", "2026-09-10-untitled"));
  const again = processRecordings(root, { environment });
  assert.equal(again.actions.filter((entry) => entry.kind === "transcript").length, 0);
  assert.match(again.actions[0].message, /0 ready, 1 still being written, 2 already transcribed/);
});

test("processRecordings handles one explicit file with a title, collisions, and failures", () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  const file = writeRecording(watch, "2026-09-10 09-00-00.mkv", { content: "one" });
  const environment = withStubs({});

  const first = processRecordings(root, { environment, file, title: "Kick-off Acme / Q3" });
  assert.equal(first.processed.length, 1);
  assert.equal(path.basename(first.processed[0].folder), "2026-09-10-kick-off-acme-q3");
  assert.equal(JSON.parse(readFileSync(path.join(first.processed[0].folder, "meta.json"), "utf8")).title, "Kick-off Acme / Q3");

  const repeated = processRecordings(root, { environment, file });
  assert.equal(repeated.processed.length, 0);
  assert.match(repeated.actions[0].message, /already transcribed/);

  // Same day, same title, different recording: the folder name gets a suffix.
  const other = writeRecording(watch, "2026-09-10 17-00-00.mkv", { content: "two" });
  const second = processRecordings(root, { environment, file: other, title: "Kick-off Acme / Q3" });
  assert.equal(path.basename(second.processed[0].folder), "2026-09-10-kick-off-acme-q3-2");

  // Engine failure is reported, nothing is filed, state is untouched.
  const third = writeRecording(watch, "2026-09-13 10-00-00.mkv", { content: "three" });
  const failing = processRecordings(root, { environment: withStubs({}, { whisperFails: true }), file: third });
  assert.equal(failing.processed.length, 0);
  const error = failing.actions.find((entry) => entry.status === "error");
  assert.match(error.message, /status 3.*model load failed/);
  assert.equal(readState(root).processed.length, 2);
  assert.equal(existsSync(path.join(root, "docs", "transcripts", "2026-09-13-untitled")), false);

  // Missing model: reported before any binary runs.
  const noModel = { ...environment, NEMEDA_WHISPER_MODEL: path.join(watch, "nope.bin") };
  const missing = processRecordings(root, { environment: noModel, file: third });
  assert.match(missing.actions.find((entry) => entry.status === "error").message, /No whisper model found/);

  assert.throws(() => processRecordings(root, { environment, file: path.join(watch, "ghost.mkv") }), /Recording not found/);
});

test("processRecordings and listRecordings refuse to run without configuration", () => {
  const environment = withStubs({});
  assert.throws(() => processRecordings(makeWorkspace(baseConfig(null)), { environment }), /no `meetings` section/);
  const root = makeWorkspace();
  assert.throws(() => processRecordings(root, { environment: { ...environment, HOME: temporaryDirectory() } }), /No recordings folder/);
  const watch = temporaryDirectory();
  writeRecording(watch, "2026-09-10 09-00-00.mkv");
  const listing = listRecordings(root, { environment: { ...environment, NEMEDA_MEETINGS_WATCH: watch } });
  assert.equal(listing.ready.length, 1);
  assert.equal(listing.engine, "whisper-cpp");
  assert.equal(listing.model, environment.NEMEDA_WHISPER_MODEL);
  // --title with several ready recordings is ambiguous.
  writeRecording(watch, "2026-09-11 09-00-00.mkv");
  assert.throws(() => processRecordings(root, { environment: { ...environment, NEMEDA_MEETINGS_WATCH: watch }, title: "x" }), /--title applies to one recording/);
});
