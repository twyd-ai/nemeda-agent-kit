import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { backendCommand, detectBackend } from "../scripts/lib/backend.mjs";
import { meetingDoctorChecks } from "../scripts/lib/meetings-doctor.mjs";
import { notesFileName, notesInstructions, summaryFromNotes, sweepDeletions } from "../scripts/lib/meetings-notes.mjs";
import { notesForTranscript, processRecordings, readState } from "../scripts/lib/meetings.mjs";
import { readAllJournals } from "../scripts/lib/memory.mjs";
import { validateConfig } from "../scripts/lib/workspace.mjs";

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "nemeda-meetings-notes-"));
}

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "workspace", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true, conversationLanguage: "es" },
    memory: { project: { path: ".nemeda/memory" } },
    meetings: { transcripts: "docs/transcripts", notes: "docs/meetings", language: "es" },
    ...overrides
  };
}

function makeWorkspace(cfg = config()) {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(cfg));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  mkdirSync(path.join(root, cfg.meetings.transcripts), { recursive: true });
  if (cfg.meetings.notes) mkdirSync(path.join(root, cfg.meetings.notes), { recursive: true });
  // The memory author is git config user.email of the workspace, as in production.
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  return root;
}

function writeRecording(directory, name, { ageSeconds = 600, content = "video" } = {}) {
  const filePath = path.join(directory, name);
  writeFileSync(filePath, content);
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(filePath, when, when);
  return filePath;
}

// Stubs: ffmpeg copies, whisper-cli writes a Spanish transcript, and a fake
// `claude` prints Claude Code's JSON envelope with canned notes (recording
// its argv and stdin so the test can check the read-only command line).
function withStubs(environment = {}, { claudeFails = false, noBackend = false } = {}) {
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
fs.writeFileSync(base + ".txt", "Hola equipo. Decidimos lanzar el lunes. Ana prepara la demo.\\n");
fs.writeFileSync(base + ".json", JSON.stringify({ result: { language: "es" }, transcription: [{ offsets: { from: 0, to: 5000 }, text: "Hola equipo." }] }));
`);
  const claude = write("claude", `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.STUB_LOG_CLAUDE, JSON.stringify({ args: process.argv.slice(2), stdin: input }));
  if (${claudeFails}) { process.stdout.write(JSON.stringify({ is_error: true, result: "Not logged in" })); process.exit(1); }
  process.stdout.write(JSON.stringify({ result: "## Resumen\\n\\nEl equipo acordó lanzar el lunes.\\n\\n## Decisiones\\n\\n- Lanzar el lunes.\\n\\n## Acciones\\n\\n- Ana: preparar la demo.\\n\\n## Preguntas abiertas\\n\\n- ninguna\\n" }));
});
`);
  const model = path.join(binDir, "ggml-small.bin");
  writeFileSync(model, "model");
  return {
    ...process.env,
    // Only the stubs and node itself (for the #!/usr/bin/env node shebangs).
    PATH: noBackend ? path.dirname(process.execPath) : `${binDir}${path.delimiter}${path.dirname(process.execPath)}`,
    HOME: temporaryDirectory(),
    NEMEDA_MEETINGS_ENGINE: "whisper-cpp",
    NEMEDA_FFMPEG_BIN: ffmpeg,
    NEMEDA_WHISPER_BIN: whisper,
    NEMEDA_WHISPER_MODEL: model,
    NEMEDA_CLAUDE_BIN: noBackend ? "/nonexistent/claude" : claude,
    NEMEDA_CODEX_BIN: "/nonexistent/codex",
    STUB_LOG_CLAUDE: path.join(binDir, "claude.log"),
    ...environment
  };
}

test("validator accepts memory flag and archive path, flags knowledgeLog as deprecated", () => {
  const base = config();
  assert.deepEqual(validateConfig(config({ meetings: { ...base.meetings, memory: false } })).filter((issue) => issue.level === "error"), []);
  assert.equal(validateConfig(config({ meetings: { ...base.meetings, memory: "yes" } })).some((issue) => issue.code === "invalid-meetings"), true);
  const deprecated = validateConfig(config({ meetings: { ...base.meetings, knowledgeLog: true } }));
  assert.equal(deprecated.some((issue) => issue.code === "deprecated-knowledge-log" && issue.level === "warn"), true);
  assert.deepEqual(deprecated.filter((issue) => issue.level === "error"), []);
  assert.equal(validateConfig(config({ meetings: { ...base.meetings, recordings: { keep: "archive" } } })).some((issue) => issue.code === "invalid-meetings"), true, "archive needs a path");
  assert.equal(validateConfig(config({ meetings: { ...base.meetings, recordings: { keep: "archive", path: "/abs" } } })).some((issue) => issue.code === "invalid-meetings"), true);
  assert.deepEqual(validateConfig(config({ meetings: { ...base.meetings, recordings: { keep: "archive", path: "docs/recordings/archive" } } })).filter((issue) => issue.level === "error"), []);
});

test("backend detection and read-only command lines", () => {
  const env = withStubs();
  assert.deepEqual(detectBackend(env).backend, "claude");
  assert.equal(detectBackend({ ...env, NEMEDA_MEETINGS_BACKEND: "codex" }).installed, false);
  assert.throws(() => detectBackend({ ...env, NEMEDA_MEETINGS_BACKEND: "gemini" }), /NEMEDA_MEETINGS_BACKEND must be one of/);
  assert.equal(detectBackend(withStubs({}, { noBackend: true })).backend, null);
  const claude = backendCommand({ backend: "claude", model: "sonnet", instructions: "Do it", cwd: "/w", inputFile: "transcript.txt" }, env);
  assert.equal(claude.command, env.NEMEDA_CLAUDE_BIN);
  assert.deepEqual(claude.args.slice(0, 6), ["-p", "Do it", "--output-format", "json", "--model", "sonnet"]);
  assert.match(claude.args[claude.args.indexOf("--disallowed-tools") + 1], /Bash Write Edit/);
  assert.equal(claude.stdin, null, "the transcript goes on stdin");
  const codex = backendCommand({ backend: "codex", instructions: "Do it", cwd: "/w", inputFile: "transcript.txt" }, env);
  assert.deepEqual(codex.args.slice(0, 5), ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--cd"]);
  assert.match(codex.args[codex.args.length - 1], /transcript\.txt/);
});

test("notes helpers: instructions, file name, summary extraction", () => {
  const instructions = notesInstructions({ projectName: "Acme", title: "Kick-off", date: "2026-09-10" });
  assert.match(instructions, /same language as the transcript/);
  assert.match(instructions, /## Action items/);
  assert.equal(notesFileName("{date}-{slug}", { timestamp: new Date(2026, 8, 10, 9, 0), title: "Kick-off Q3" }), "2026-09-10-kick-off-q3.md");
  assert.equal(summaryFromNotes("## Resumen\n\nPárrafo uno.\nPárrafo dos.\n\n## Decisiones\n\n- x"), "Párrafo uno.\nPárrafo dos.");
  assert.equal(summaryFromNotes("sin cabeceras"), "sin cabeceras");
});

test("process writes notes with the local agent, logs the meeting to memory, and is idempotent", () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  const file = writeRecording(watch, "2026-09-10 09-00-00.mkv");
  const env = withStubs({ NEMEDA_MEETINGS_MODEL: "sonnet" });

  const dry = processRecordings(root, { environment: env, file, title: "Kick-off Q3", dryRun: true });
  assert.deepEqual(dry.actions.filter((entry) => ["notes", "memory"].includes(entry.kind)).map((entry) => entry.status), []);

  const report = processRecordings(root, { environment: env, file, title: "Kick-off Q3" });
  assert.equal(report.processed.length, 1, JSON.stringify(report.actions));
  const notes = report.actions.find((entry) => entry.kind === "notes");
  assert.equal(notes.status, "created", JSON.stringify(report.actions));
  assert.equal(notes.notes, path.join("docs", "meetings", "2026-09-10-kick-off-q3.md"));
  const markdown = readFileSync(path.join(root, notes.notes), "utf8");
  assert.match(markdown, /^# Kick-off Q3 — 2026-09-10\n/);
  assert.match(markdown, /- Transcript: docs\/transcripts\/2026-09-10-kick-off-q3\/transcript\.txt/);
  assert.match(markdown, /- Generated by: claude \(sonnet\) from a whisper-cpp transcript/);
  assert.match(markdown, /## Decisiones\n\n- Lanzar el lunes\./);
  // The transcript went on stdin, the command was read-only, the model was passed.
  const call = JSON.parse(readFileSync(env.STUB_LOG_CLAUDE, "utf8"));
  assert.match(call.stdin, /Hola equipo\. Decidimos lanzar el lunes\./);
  assert.match(call.args[1], /Kick-off Q3/);
  assert.equal(call.args[call.args.indexOf("--model") + 1], "sonnet");
  // Memory entry: type meeting, summary from the notes, source points at both files.
  const memory = report.actions.find((entry) => entry.kind === "memory");
  assert.equal(memory.status, "created", memory.message);
  const journals = readAllJournals(path.join(root, ".nemeda", "memory"));
  const entries = journals.entries || journals;
  const entry = (Array.isArray(entries) ? entries : []).find((item) => item.type === "meeting");
  assert.ok(entry, JSON.stringify(journals).slice(0, 300));
  assert.equal(entry.title, "Kick-off Q3 (2026-09-10)");
  assert.equal(entry.author, "ana@example.com");
  assert.equal(entry.summary, "El equipo acordó lanzar el lunes.");
  assert.equal(entry.source.kind, "meeting");
  assert.equal(entry.source.transcript, path.join("docs", "transcripts", "2026-09-10-kick-off-q3"));
  assert.equal(entry.source.notes, path.join("docs", "meetings", "2026-09-10-kick-off-q3.md"));
  assert.deepEqual(entry.tags, ["meeting"]);

  // Re-running notes keeps the file unless forced; forcing regenerates and logs again.
  const again = notesForTranscript(root, "docs/transcripts/2026-09-10-kick-off-q3", { environment: env });
  assert.equal(again.actions.find((entry) => entry.kind === "notes").status, "kept");
  assert.equal(again.memory, null);
  const forced = notesForTranscript(root, "docs/transcripts/2026-09-10-kick-off-q3", { environment: env, force: true });
  assert.equal(forced.actions.find((entry) => entry.kind === "notes").status, "created");
  assert.ok(forced.memory);
  assert.throws(() => notesForTranscript(root, "docs/transcripts/nope", { environment: env }), /Not a transcript folder/);
});

test("notes degrade gracefully: no backend, failing backend, --no-notes, memory off", () => {
  const watch = temporaryDirectory();

  const noBackendRoot = makeWorkspace();
  const noBackend = processRecordings(noBackendRoot, { environment: withStubs({}, { noBackend: true }), file: writeRecording(watch, "2026-09-10 09-00-00.mkv") });
  assert.equal(noBackend.processed.length, 1);
  const manual = noBackend.actions.find((entry) => entry.kind === "notes");
  assert.equal(manual.status, "manual");
  assert.match(manual.message, /meeting-notes skill/);
  // Memory still gets an entry, summarised from the transcript itself.
  const memory = noBackend.actions.find((entry) => entry.kind === "memory");
  assert.equal(memory.status, "created");
  const entries = readAllJournals(path.join(noBackendRoot, ".nemeda", "memory"));
  const list = Array.isArray(entries) ? entries : entries.entries;
  assert.match(list.find((item) => item.type === "meeting").summary, /Transcript filed at docs\/transcripts/);

  const failingRoot = makeWorkspace();
  const failing = processRecordings(failingRoot, { environment: withStubs({}, { claudeFails: true }), file: writeRecording(watch, "2026-09-11 09-00-00.mkv") });
  assert.equal(failing.processed.length, 1, "the transcript is still filed");
  assert.match(failing.actions.find((entry) => entry.kind === "notes").message, /Not logged in/);
  assert.equal(existsSync(path.join(failingRoot, "docs", "meetings")) && readdirSync(path.join(failingRoot, "docs", "meetings")).length, 0);

  const skipRoot = makeWorkspace();
  const skipped = processRecordings(skipRoot, { environment: withStubs(), file: writeRecording(watch, "2026-09-12 09-00-00.mkv"), skipNotes: true });
  assert.equal(skipped.actions.some((entry) => entry.kind === "notes"), false);
  assert.equal(skipped.actions.find((entry) => entry.kind === "memory").status, "created");

  const offRoot = makeWorkspace(config({ meetings: { transcripts: "docs/transcripts", memory: false } }));
  const off = processRecordings(offRoot, { environment: withStubs(), file: writeRecording(watch, "2026-09-13 09-00-00.mkv") });
  assert.equal(off.actions.some((entry) => entry.kind === "memory" || entry.kind === "notes"), false);

  const noMemoryRoot = makeWorkspace(config({ memory: undefined }));
  const noMemory = processRecordings(noMemoryRoot, { environment: withStubs(), file: writeRecording(watch, "2026-09-14 09-00-00.mkv") });
  assert.equal(noMemory.actions.find((entry) => entry.kind === "memory").status, "skipped");
});

test("retention: archive moves the recording after transcription, delete sweeps old ones", () => {
  const watch = temporaryDirectory();
  const archiveRoot = makeWorkspace(config({ meetings: { transcripts: "docs/transcripts", recordings: { keep: "archive", path: "docs/recordings/archive" } } }));
  const env = withStubs();
  const file = writeRecording(watch, "2026-09-10 09-00-00.mkv", { content: "big" });
  const report = processRecordings(archiveRoot, { environment: env, file });
  assert.equal(existsSync(file), false, "moved away");
  assert.equal(readFileSync(path.join(archiveRoot, "docs", "recordings", "archive", "2026-09-10 09-00-00.mkv"), "utf8"), "big");
  assert.equal(readState(archiveRoot).processed[0].archivedTo, path.join("docs", "recordings", "archive", "2026-09-10 09-00-00.mkv"));
  assert.equal(report.actions.find((entry) => entry.kind === "recording").status, "created");
  // A second recording with the same name is not overwritten.
  const twin = writeRecording(watch, "2026-09-10 09-00-00.mkv", { content: "other" });
  const second = processRecordings(archiveRoot, { environment: env, file: twin });
  assert.equal(second.actions.find((entry) => entry.kind === "recording").status, "kept");
  assert.equal(existsSync(twin), true);

  const deleteRoot = makeWorkspace(config({ meetings: { transcripts: "docs/transcripts", recordings: { keep: "delete", afterDays: 7 } } }));
  const old = writeRecording(watch, "2026-09-01 09-00-00.mkv");
  processRecordings(deleteRoot, { environment: env, file: old });
  assert.equal(existsSync(old), true, "not deleted yet: transcribed just now");
  const state = readState(deleteRoot);
  state.processed[0].processedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const actions = [];
  const resolved = { root: deleteRoot, config: { recordings: { keep: "delete", afterDays: 7 } } };
  assert.equal(sweepDeletions(resolved, state, { actions, dryRun: true }), 0);
  assert.equal(existsSync(old), true);
  assert.equal(sweepDeletions(resolved, state, { actions }), 1);
  assert.equal(existsSync(old), false);
  assert.ok(state.processed[0].deletedAt);
  assert.equal(sweepDeletions(resolved, state, { actions }), 0, "deleted only once");
});

test("doctor reports notes backend, memory, and retention", () => {
  const probe = { platform: "darwin", arch: "arm64", release: "25.6.0", cores: 14, totalMemoryGB: 24, obs: false };
  const root = makeWorkspace();
  const byCode = (checks, code) => checks.filter((check) => check.code === code);
  const withClaude = meetingDoctorChecks(root, config().meetings, undefined, withStubs({ NEMEDA_MEETINGS_MODEL: "sonnet" }), { probe, memoryConfigured: true });
  assert.match(byCode(withClaude, "meetings-notes")[0].message, /written by claude .*model sonnet/);
  assert.equal(byCode(withClaude, "meetings-memory")[0].status, "pass");
  assert.equal(byCode(withClaude, "meetings-retention").length, 0);
  const without = meetingDoctorChecks(root, config().meetings, undefined, withStubs({}, { noBackend: true }), { probe, memoryConfigured: false });
  assert.equal(byCode(without, "meetings-notes")[0].status, "warn");
  assert.equal(byCode(without, "meetings-memory")[0].status, "warn");
  const archive = meetingDoctorChecks(root, { ...config().meetings, recordings: { keep: "archive", path: "docs/recordings/archive" } }, undefined, withStubs(), { probe, memoryConfigured: true });
  assert.match(byCode(archive, "meetings-retention")[0].message, /archived to docs\/recordings\/archive/);
  const off = meetingDoctorChecks(root, { ...config().meetings, memory: false }, undefined, withStubs(), { probe, memoryConfigured: true });
  assert.match(byCode(off, "meetings-memory")[0].message, /not logged/);
});
