import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeTranscribers,
  claimRecording,
  handOffRecording,
  listClaims,
  readSharedState,
  reclaimStale,
  releaseClaim,
  resolveRole,
  writeHeartbeat
} from "../scripts/lib/meetings-core.mjs";
import { meetingDoctorChecks, meetingInboxContext } from "../scripts/lib/meetings-doctor.mjs";
import { listRecordings, processRecordings, readState } from "../scripts/lib/meetings.mjs";

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "nemeda-meetings-roles-"));
}

// Two workspaces (two machines) sharing one "drive" folder through the same
// docs path, exactly like two teammates with the Drive link.
function makeTeam() {
  const drive = temporaryDirectory();
  mkdirSync(path.join(drive, "transcripts"));
  mkdirSync(path.join(drive, "recordings", "inbox"), { recursive: true });
  const config = {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "workspace", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true, conversationLanguage: "es" },
    drive: { sharedDrive: "Acme", links: { docs: "docs" } },
    meetings: { inbox: "docs/recordings/inbox", transcripts: "docs/transcripts", language: "es" }
  };
  const machine = () => {
    const root = temporaryDirectory();
    mkdirSync(path.join(root, ".nemeda"), { recursive: true });
    writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
    writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
    // "docs" is a symlink into the shared folder, like the Drive link.
    symlinkSync(drive, path.join(root, "docs"));
    return root;
  };
  return { drive, inbox: path.join(drive, "recordings", "inbox"), recorder: machine(), transcriber: machine(), config };
}

function writeRecording(directory, name, { ageSeconds = 600, content = "video" } = {}) {
  const filePath = path.join(directory, name);
  writeFileSync(filePath, content);
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(filePath, when, when);
  return filePath;
}

function withStubs(environment) {
  const binDir = temporaryDirectory();
  const ffmpeg = path.join(binDir, "ffmpeg");
  writeFileSync(ffmpeg, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.copyFileSync(args[args.indexOf("-i") + 1], args[args.length - 1]);
`);
  const whisper = path.join(binDir, "whisper-cli");
  writeFileSync(whisper, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const base = args[args.indexOf("-of") + 1];
const input = fs.readFileSync(args[args.indexOf("-f") + 1], "utf8");
fs.writeFileSync(base + ".txt", "Transcript of " + input + "\\n");
fs.writeFileSync(base + ".json", JSON.stringify({ result: { language: "es" }, transcription: [{ offsets: { from: 0, to: 2000 }, text: "Transcript of " + input }] }));
`);
  chmodSync(ffmpeg, 0o755);
  chmodSync(whisper, 0o755);
  const model = path.join(binDir, "ggml-small.bin");
  writeFileSync(model, "model");
  return {
    ...process.env,
    NEMEDA_MEETINGS_ENGINE: "whisper-cpp",
    NEMEDA_FFMPEG_BIN: ffmpeg,
    NEMEDA_WHISPER_BIN: whisper,
    NEMEDA_WHISPER_MODEL: model,
    ...environment
  };
}

test("resolveRole defaults to full and rejects unknown values", () => {
  assert.equal(resolveRole({}), "full");
  assert.equal(resolveRole({ NEMEDA_MEETINGS_ROLE: " Recorder " }), "recorder");
  assert.throws(() => resolveRole({ NEMEDA_MEETINGS_ROLE: "viewer" }), /NEMEDA_MEETINGS_ROLE must be one of/);
});

test("claims rename atomically, are listed per host, and stale ones of this host are released", () => {
  const inbox = temporaryDirectory();
  const file = writeRecording(inbox, "2026-09-10 09-00-00.mkv");
  const claimed = claimRecording(file, "MacBook de Ana.local");
  assert.equal(path.basename(claimed), "2026-09-10 09-00-00.mkv.claimed-MacBook-de-Ana.local");
  assert.equal(existsSync(file), false);
  assert.deepEqual(listClaims(inbox).map((claim) => [path.basename(claim.original), claim.host]), [["2026-09-10 09-00-00.mkv", "MacBook-de-Ana.local"]]);
  // Another host cannot claim a file that is gone.
  assert.throws(() => claimRecording(file, "other"));
  assert.deepEqual(reclaimStale(inbox, "other"), []);
  assert.deepEqual(reclaimStale(inbox, "MacBook de Ana.local"), [file]);
  assert.equal(existsSync(file), true);
  const again = claimRecording(file, "b");
  assert.equal(releaseClaim(again), file);
  assert.equal(listClaims(temporaryDirectory()).length, 0);
});

test("heartbeats record transcribers and expire", () => {
  const inbox = temporaryDirectory();
  writeHeartbeat(inbox, "fast-mac", { engine: "apple-speech" }, new Date(Date.now() - 1000));
  writeHeartbeat(inbox, "old-pc", { engine: "whisper-cpp" }, new Date(Date.now() - 3 * 24 * 3_600_000));
  const active = activeTranscribers(inbox);
  assert.deepEqual(active.map((beat) => beat.host), ["fast-mac"]);
  assert.equal(active[0].engine, "apple-speech");
  assert.equal(activeTranscribers(temporaryDirectory()).length, 0);
});

test("handOffRecording copies through a temporary name and never overwrites", () => {
  const source = temporaryDirectory();
  const inbox = temporaryDirectory();
  const file = writeRecording(source, "2026-09-10 09-00-00.mkv", { content: "abc" });
  const first = handOffRecording({ path: file }, inbox);
  assert.equal(first.status, "created");
  assert.equal(readFileSync(first.target, "utf8"), "abc");
  assert.equal(existsSync(file), true, "the original stays");
  assert.equal(readdirSync(inbox).some((name) => name.endsWith(".part")), false);
  writeFileSync(file, "changed");
  assert.equal(handOffRecording({ path: file }, inbox).status, "kept");
  assert.equal(readFileSync(first.target, "utf8"), "abc");
});

test("recorder hands off, transcriber drains the inbox, and the shared state keeps them in step", () => {
  const team = makeTeam();
  const recordings = temporaryDirectory();
  writeRecording(recordings, "2026-09-10 09-00-00.mkv", { content: "first" });
  writeRecording(recordings, "2026-09-10 11-00-00.mkv", { content: "second" });
  writeRecording(recordings, "2026-09-10 12-00-00.mkv", { ageSeconds: 3, content: "writing" });
  const recorderEnv = withStubs({ NEMEDA_MEETINGS_ROLE: "recorder", NEMEDA_MEETINGS_WATCH: recordings, NEMEDA_WHISPER_BIN: "/nonexistent" });

  const dry = processRecordings(team.recorder, { environment: recorderEnv, dryRun: true });
  assert.equal(dry.actions.filter((entry) => entry.kind === "handoff" && entry.status === "planned").length, 2);
  assert.equal(readdirSync(team.inbox).length, 0);

  const handed = processRecordings(team.recorder, { environment: recorderEnv });
  assert.equal(handed.role, "recorder");
  assert.equal(handed.handedOff.length, 2, JSON.stringify(handed.actions));
  assert.equal(handed.processed.length, 0);
  assert.equal(handed.actions.some((entry) => entry.kind === "transcript"), false, "a recorder never transcribes");
  assert.deepEqual(readdirSync(team.inbox).sort(), ["2026-09-10 09-00-00.mkv", "2026-09-10 11-00-00.mkv"]);
  assert.equal(readState(team.recorder).processed.every((entry) => entry.handedOff), true);
  // Idempotent: nothing new on the second run.
  const again = processRecordings(team.recorder, { environment: recorderEnv });
  assert.equal(again.handedOff.length, 0);
  assert.match(again.actions[0].message, /0 ready, 1 still being written, 2 already handed off/);

  // Freshly copied files sit inside the stability window on every machine; age them.
  const ageInbox = () => {
    for (const name of readdirSync(team.inbox)) {
      const when = new Date(Date.now() - 600_000);
      if (!name.startsWith(".")) utimesSync(path.join(team.inbox, name), when, when);
    }
  };
  ageInbox();
  // Recorder's listing shows its side only.
  const recorderListing = listRecordings(team.recorder, { environment: recorderEnv });
  assert.equal(recorderListing.role, "recorder");
  assert.equal(recorderListing.inboxReady.length, 2);

  // The transcriber sees the inbox, not a local folder, and drains it.
  const transcriberEnv = withStubs({ NEMEDA_MEETINGS_ROLE: "transcriber", NEMEDA_MEETINGS_WATCH: recordings });
  const listing = listRecordings(team.transcriber, { environment: transcriberEnv });
  assert.equal(listing.watch, null);
  assert.equal(listing.inboxReady.length, 2);
  const drained = processRecordings(team.transcriber, { environment: transcriberEnv });
  assert.equal(drained.processed.length, 2, JSON.stringify(drained.actions));
  assert.equal(drained.actions.some((entry) => entry.kind === "discover"), false, "no local folder for a transcriber");
  const folders = readdirSync(path.join(team.drive, "transcripts")).sort();
  assert.deepEqual(folders, ["2026-09-10-untitled", "2026-09-10-untitled-2"]);
  assert.equal(readFileSync(path.join(team.drive, "transcripts", "2026-09-10-untitled", "transcript.txt"), "utf8"), "Transcript of first\n");
  const meta = JSON.parse(readFileSync(path.join(team.drive, "transcripts", "2026-09-10-untitled", "meta.json"), "utf8"));
  assert.equal(path.basename(meta.source), "2026-09-10 09-00-00.mkv", "source is the inbox name, not the claimed name");
  assert.match(meta.source, /docs\/recordings\/inbox\//, "source is the inbox path as this machine sees it");
  // Claims are released, state is shared, heartbeat written.
  assert.equal(listClaims(team.inbox).length, 0);
  assert.deepEqual(readdirSync(team.inbox).filter((name) => !name.startsWith(".")).sort(), ["2026-09-10 09-00-00.mkv", "2026-09-10 11-00-00.mkv"]);
  assert.equal(readSharedState(team.inbox).processed.length, 2);
  assert.equal(activeTranscribers(team.inbox).length, 1);
  assert.equal(readState(team.transcriber).processed.length, 0, "inbox work is not recorded in the local state");

  // A second transcriber on the same inbox finds nothing left.
  const second = processRecordings(makeTeamMachine(team), { environment: withStubs({ NEMEDA_MEETINGS_ROLE: "transcriber" }) });
  assert.equal(second.processed.length, 0);
  assert.match(second.actions.find((entry) => entry.kind === "inbox").message, /0 ready.*2 already transcribed/);
});

function makeTeamMachine(team) {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(team.config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  symlinkSync(team.drive, path.join(root, "docs"));
  return root;
}

test("a file claimed by another machine is skipped and a stale own claim is recovered", () => {
  const team = makeTeam();
  const mine = writeRecording(team.inbox, "2026-09-10 09-00-00.mkv", { content: "mine" });
  const theirs = writeRecording(team.inbox, "2026-09-10 10-00-00.mkv", { content: "theirs" });
  claimRecording(theirs, "other-machine");
  claimRecording(mine, os.hostname()); // left over from a run of this machine that died
  const env = withStubs({ NEMEDA_MEETINGS_ROLE: "transcriber" });
  const report = processRecordings(team.transcriber, { environment: env });
  assert.equal(report.actions.some((entry) => entry.kind === "claim" && /stale claim/.test(entry.message)), true);
  assert.equal(report.processed.length, 1);
  assert.match(report.actions.find((entry) => entry.kind === "inbox").message, /1 claimed by other machines/);
  assert.deepEqual(listClaims(team.inbox).map((claim) => claim.host), ["other-machine"]);
  assert.equal(readSharedState(team.inbox).processed[0].path, path.basename(mine), "shared state stores names relative to the inbox");
});

test("full role transcribes its own folder and the inbox; roles without an inbox are refused", () => {
  const team = makeTeam();
  const recordings = temporaryDirectory();
  writeRecording(recordings, "2026-09-11 09-00-00.mkv", { content: "local" });
  writeRecording(team.inbox, "2026-09-10 09-00-00.mkv", { content: "shared" });
  const env = withStubs({ NEMEDA_MEETINGS_WATCH: recordings });
  const report = processRecordings(team.transcriber, { environment: env });
  assert.equal(report.role, "full");
  assert.equal(report.processed.length, 2, JSON.stringify(report.actions));
  assert.equal(readState(team.transcriber).processed.length, 1);
  assert.equal(readSharedState(team.inbox).processed.length, 1);

  const noInbox = { ...team.config, meetings: { transcripts: "docs/transcripts" } };
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(noInbox));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  assert.throws(() => processRecordings(root, { environment: withStubs({ NEMEDA_MEETINGS_ROLE: "transcriber" }) }), /needs `meetings.inbox`/);
  assert.throws(() => processRecordings(root, { environment: withStubs({ NEMEDA_MEETINGS_ROLE: "recorder" }) }), /needs `meetings.inbox`/);
  assert.throws(() => processRecordings(root, { environment: withStubs({ NEMEDA_MEETINGS_ROLE: "dj" }) }), /NEMEDA_MEETINGS_ROLE must be one of/);
});

test("doctor and session context follow the role", () => {
  const team = makeTeam();
  const recordings = temporaryDirectory();
  writeRecording(recordings, "2026-09-11 09-00-00.mkv");
  writeRecording(team.inbox, "2026-09-10 09-00-00.mkv");
  const probe = { platform: "darwin", arch: "arm64", release: "25.6.0", cores: 14, totalMemoryGB: 24, obs: false };
  const byCode = (checks, code) => checks.filter((check) => check.code === code);

  const recorderEnv = { PATH: "/nonexistent", HOME: temporaryDirectory(), NEMEDA_MEETINGS_ROLE: "recorder", NEMEDA_MEETINGS_WATCH: recordings };
  const recorderChecks = meetingDoctorChecks(team.recorder, team.config.meetings, team.config.drive, recorderEnv, { probe });
  assert.match(byCode(recorderChecks, "meetings-role")[0].message, /Role recorder/);
  assert.equal(byCode(recorderChecks, "meetings-engine").length, 0, "no engine checks for a recorder");
  assert.equal(byCode(recorderChecks, "meetings-inbox")[0].status, "pass");
  assert.equal(byCode(recorderChecks, "meetings-transcriber")[0].status, "warn");
  assert.equal(byCode(recorderChecks, "meetings-watch")[0].status, "pass");
  writeHeartbeat(team.inbox, "fast-mac", { engine: "apple-speech" });
  assert.match(byCode(meetingDoctorChecks(team.recorder, team.config.meetings, team.config.drive, recorderEnv, { probe }), "meetings-transcriber")[0].message, /fast-mac \(apple-speech\)/);

  const transcriberEnv = { PATH: "/nonexistent", HOME: temporaryDirectory(), NEMEDA_MEETINGS_ROLE: "transcriber" };
  const transcriberChecks = meetingDoctorChecks(team.transcriber, team.config.meetings, team.config.drive, transcriberEnv, { probe });
  assert.equal(byCode(transcriberChecks, "meetings-watch").length, 0, "no local folder for a transcriber");
  assert.equal(byCode(transcriberChecks, "meetings-engine")[0].status, "fail");
  assert.match(byCode(transcriberChecks, "meetings-inbox-backlog")[0].message, /1 waiting/);

  const badRole = meetingDoctorChecks(team.transcriber, team.config.meetings, team.config.drive, { ...transcriberEnv, NEMEDA_MEETINGS_ROLE: "dj" }, { probe });
  assert.equal(byCode(badRole, "meetings-role")[0].status, "fail");
  const noInbox = meetingDoctorChecks(team.transcriber, { transcripts: "docs/transcripts" }, team.config.drive, transcriberEnv, { probe });
  assert.match(byCode(noInbox, "meetings-role")[0].message, /needs meetings.inbox/);

  assert.match(meetingInboxContext(team.recorder, team.config.meetings, recorderEnv), /waiting to be handed to the team inbox/);
  assert.doesNotMatch(meetingInboxContext(team.recorder, team.config.meetings, recorderEnv), /shared inbox/);
  assert.match(meetingInboxContext(team.transcriber, team.config.meetings, transcriberEnv), /1 team recording\(s\) in the shared inbox/);
  const fullEnv = { HOME: temporaryDirectory(), NEMEDA_MEETINGS_WATCH: recordings };
  const full = meetingInboxContext(team.transcriber, team.config.meetings, fullEnv);
  assert.match(full, /waiting to be transcribed/);
  assert.match(full, /shared inbox/);
  assert.equal(meetingInboxContext(team.transcriber, team.config.meetings, { ...fullEnv, NEMEDA_MEETINGS_ROLE: "dj" }), "");
});
