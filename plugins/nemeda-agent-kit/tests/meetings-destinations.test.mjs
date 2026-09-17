// Guard 5 of docs/drive-config-plan.md for meeting capture: moved destination
// folders pause the unattended watch loop until `memory trust`, interactive
// commands only warn, and a folder outside the shared drive is refused.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkMeetingDestinations, meetingDestinations } from "../scripts/lib/meetings-destinations.mjs";
import { meetingDoctorChecks } from "../scripts/lib/meetings-doctor.mjs";
import { recordMeetingMemory } from "../scripts/lib/meetings-notes.mjs";
import { watchTick } from "../scripts/lib/meetings-watch.mjs";
import { processRecordings } from "../scripts/lib/meetings.mjs";
import { checkMemoryWrite, readWorkspacePins, trustPendingFolders } from "../scripts/lib/memory-pins.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "nemeda-meetings-destinations-"));
}

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "workspace", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    meetings: { transcripts: "docs/transcripts", notes: "docs/meetings" },
    ...overrides
  };
}

function writeConfig(root, cfg) {
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(cfg));
}

function makeWorkspace(cfg = config()) {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeConfig(root, cfg);
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  mkdirSync(path.join(root, "docs", "transcripts"), { recursive: true });
  mkdirSync(path.join(root, "docs", "meetings"), { recursive: true });
  return root;
}

function writeRecording(directory, name, ageSeconds = 600) {
  const filePath = path.join(directory, name);
  writeFileSync(filePath, "video");
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(filePath, when, when);
  return filePath;
}

// Same stubs as meetings-watch.test.mjs: ffmpeg copies, whisper writes a
// one-line transcript, and no notes backend exists.
function withStubs(environment = {}) {
  const binDir = temporaryDirectory();
  const write = (name, body) => {
    const file = path.join(binDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
    return file;
  };
  const ffmpeg = write("ffmpeg", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.copyFileSync(args[args.indexOf("-i") + 1], args[args.length - 1]);
`);
  const whisper = write("whisper-cli", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const base = args[args.indexOf("-of") + 1];
fs.writeFileSync(base + ".txt", "Texto.\\n");
fs.writeFileSync(base + ".json", JSON.stringify({ result: { language: "es" }, transcription: [{ offsets: { from: 0, to: 1000 }, text: "Texto." }] }));
`);
  const model = path.join(binDir, "ggml-small.bin");
  writeFileSync(model, "model");
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}`,
    HOME: temporaryDirectory(),
    NEMEDA_DRIVE_ROOT: "",
    NEMEDA_MEETINGS_ENGINE: "whisper-cpp",
    NEMEDA_FFMPEG_BIN: ffmpeg,
    NEMEDA_WHISPER_BIN: whisper,
    NEMEDA_WHISPER_MODEL: model,
    NEMEDA_CLAUDE_BIN: "/nonexistent/claude",
    NEMEDA_CODEX_BIN: "/nonexistent/codex",
    ...environment
  };
}

// Points meetings.transcripts at another existing folder: the move a drive
// editor could make in the configuration.
function moveTranscripts(root, folder = "docs/transcripts-shared") {
  mkdirSync(path.join(root, folder), { recursive: true });
  writeConfig(root, config({ meetings: { transcripts: folder, notes: "docs/meetings" } }));
}

test("destinations are named by role, so changing a configured path is a move, never a new first use", () => {
  assert.deepEqual(
    meetingDestinations({ transcripts: "docs/t", notes: "docs/n", inbox: "docs/in", recordings: { keep: "archive", path: "docs/a" } }).map((entry) => entry.kind),
    ["meetings:transcripts", "meetings:notes", "meetings:inbox", "meetings:archive"]
  );
  assert.deepEqual(meetingDestinations({ transcripts: "docs/t", recordings: { keep: "delete", afterDays: 3 } }).map((entry) => entry.kind), ["meetings:transcripts"]);
  assert.deepEqual(meetingDestinations(null), []);
});

test("the watch loop pins silently, pauses once when a folder moves, and resumes after memory trust", () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  const environment = () => withStubs({ NEMEDA_MEETINGS_WATCH: watch });
  writeRecording(watch, "2026-09-10 09-00-00.mkv");

  const first = watchTick(root, { environment: environment() }, () => {}, {});
  assert.equal(first.processed.length, 1);
  const pinned = readWorkspacePins(root).folders;
  assert.equal(pinned["meetings:transcripts"].identity, "local:docs/transcripts");
  assert.equal(pinned["meetings:notes"].identity, "local:docs/meetings");

  moveTranscripts(root);
  writeRecording(watch, "2026-09-11 09-00-00.mkv");
  const lines = [];
  const memory = {};
  const paused = watchTick(root, { environment: environment() }, (line) => lines.push(line), memory);
  watchTick(root, { environment: environment() }, (line) => lines.push(line), memory);
  assert.equal(paused.paused, true);
  assert.equal(paused.processed.length, 0);
  assert.equal(lines.length, 1, `a pause is logged once, not every tick:\n${lines.join("\n")}`);
  assert.match(lines[0], /\[paused\] destination: The meetings transcripts folder moved from \.\/docs\/transcripts to \.\/docs\/transcripts-shared.*the meeting watch loop.*memory trust/);
  assert.doesNotMatch(lines[0], /harvest/, "a meetings pause names the watch loop, not the memory writers");
  const pins = readWorkspacePins(root);
  assert.equal(pins.pendingFolders["meetings:transcripts"].identity, "local:docs/transcripts-shared");
  assert.equal(pins.folders["meetings:transcripts"].identity, "local:docs/transcripts", "the trusted folder is unchanged until a person confirms");

  trustPendingFolders(root);
  const resumedLines = [];
  const resumed = watchTick(root, { environment: environment() }, (line) => resumedLines.push(line), memory);
  assert.equal(resumed.processed.length, 1);
  assert.match(resumedLines[0], /\[resumed\] destination/);
});

test("an interactive meeting process only warns about a moved folder", () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  processRecordings(root, { environment: withStubs({ NEMEDA_MEETINGS_WATCH: watch }) });
  moveTranscripts(root);
  writeRecording(watch, "2026-09-12 09-00-00.mkv");

  const report = processRecordings(root, { environment: withStubs({ NEMEDA_MEETINGS_WATCH: watch }) });
  assert.equal(report.paused, undefined);
  assert.equal(report.processed.length, 1);
  assert.ok(report.actions.some((entry) => entry.kind === "destination" && entry.status === "warning" && /moved from/.test(entry.message)));
});

test("a dry run neither pins nor records a pending move", () => {
  const root = makeWorkspace();
  processRecordings(root, { dryRun: true, environment: withStubs({ NEMEDA_MEETINGS_WATCH: temporaryDirectory() }) });
  assert.equal(readWorkspacePins(root).folders, undefined);
});

test("a meetings folder that resolves outside the shared drive is refused, even interactively", () => {
  const base = temporaryDirectory();
  const drive = path.join(base, "drive");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(drive, "docs"), { recursive: true });
  mkdirSync(path.join(outside, "transcripts"), { recursive: true });
  mkdirSync(path.join(outside, "meetings"), { recursive: true });
  const root = path.join(base, "workspace");
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeConfig(root, config({ drive: { provider: "google", sharedDrive: "Acme", links: { docs: "docs" } } }));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  symlinkSync(outside, path.join(root, "docs"));

  const report = processRecordings(root, { environment: withStubs({ NEMEDA_DRIVE_ROOT: drive, NEMEDA_MEETINGS_WATCH: temporaryDirectory() }) });
  assert.equal(report.paused, true);
  const refusal = report.actions.find((entry) => entry.kind === "destination" && entry.status === "error");
  assert.ok(refusal);
  assert.match(refusal.message, /The meetings transcripts folder resolves to .*outside the shared drive Acme/);

  const checks = meetingDoctorChecks(root, config().meetings, { provider: "google", sharedDrive: "Acme", links: { docs: "docs" } }, withStubs({ NEMEDA_DRIVE_ROOT: drive }));
  assert.ok(checks.some((check) => check.code === "meetings-destination" && check.status === "fail"));
});

test("doctor and the SessionStart hook report a paused watch loop without recording anything", () => {
  const root = makeWorkspace();
  const environment = withStubs({ NEMEDA_MEETINGS_WATCH: temporaryDirectory() });
  checkMeetingDestinations(root, config().meetings, null, { environment });
  moveTranscripts(root);
  const meetings = { transcripts: "docs/transcripts-shared", notes: "docs/meetings" };

  const checks = meetingDoctorChecks(root, meetings, null, environment);
  const row = checks.find((check) => check.code === "meetings-destination");
  assert.equal(row.status, "warn");
  assert.equal(readWorkspacePins(root).pendingFolders, undefined, "doctor never records a pending move");

  const output = execFileSync(process.execPath, [path.join(pluginRoot, "scripts", "hooks", "meeting-inbox.mjs")], {
    input: JSON.stringify({ cwd: root }),
    env: { ...environment, NEMEDA_SLACK_RUNNER: "" },
    encoding: "utf8"
  });
  assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /Meeting capture: the unattended watch loop is paused\. The meetings transcripts folder moved/);
  assert.equal(readWorkspacePins(root).pendingFolders, undefined, "the hook never records a pending move");
});

test("a paused meeting memory entry reports the real reason", () => {
  const root = makeWorkspace();
  mkdirSync(path.join(root, "memory-a"), { recursive: true });
  mkdirSync(path.join(root, "memory-b"), { recursive: true });
  const projectConfig = config({ memory: { project: { path: "memory-a" } } });
  checkMemoryWrite(root, projectConfig, { unattended: true });
  const moved = config({ memory: { project: { path: "memory-b" } } });

  const transcriptFolder = path.join(root, "docs", "transcripts", "2026-09-10-sync");
  mkdirSync(transcriptFolder, { recursive: true });
  writeFileSync(path.join(transcriptFolder, "transcript.txt"), "Texto.\n");
  const actions = [];
  const entry = recordMeetingMemory(
    { root, config: moved.meetings, projectConfig: moved, environment: withStubs() },
    transcriptFolder,
    { title: "Sync", recordedAt: "2026-09-10T09:00:00Z", engine: "whisper-cpp" },
    { markdown: "## Summary\nTexto.\n", notesPath: null },
    { actions }
  );
  assert.equal(entry, null);
  assert.equal(actions[0].status, "paused");
  assert.match(actions[0].message, /memory folder moved from \.\/memory-a to \.\/memory-b/);
  assert.doesNotMatch(actions[0].message, /not configured/);
});
