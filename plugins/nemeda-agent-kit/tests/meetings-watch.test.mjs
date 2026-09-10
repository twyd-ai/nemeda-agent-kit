import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executableOnPath, listTranscripts } from "../scripts/lib/meetings-core.mjs";
import { meetingDoctorChecks } from "../scripts/lib/meetings-doctor.mjs";
import { installMeetingService, meetingServiceStatus, runMeetingWatch, serviceLabel, servicePaths, uninstallMeetingService, watchTick } from "../scripts/lib/meetings-watch.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "nemeda-meetings-watch-"));
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

function makeWorkspace(cfg = config()) {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(cfg));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  if (cfg.meetings) {
    mkdirSync(path.join(root, cfg.meetings.transcripts), { recursive: true });
    if (cfg.meetings.notes) mkdirSync(path.join(root, cfg.meetings.notes), { recursive: true });
  }
  return root;
}

function writeRecording(directory, name, ageSeconds = 600) {
  const filePath = path.join(directory, name);
  writeFileSync(filePath, "video");
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(filePath, when, when);
  return filePath;
}

function writeTranscript(root, folderName, meta, text = "Hablamos del lanzamiento.") {
  const folder = path.join(root, "docs", "transcripts", folderName);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "transcript.txt"), `${text}\n`);
  writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ engine: "whisper-cpp", language: "es", ...meta }));
  return folder;
}

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
    NEMEDA_MEETINGS_ENGINE: "whisper-cpp",
    NEMEDA_FFMPEG_BIN: ffmpeg,
    NEMEDA_WHISPER_BIN: whisper,
    NEMEDA_WHISPER_MODEL: model,
    NEMEDA_CLAUDE_BIN: "/nonexistent/claude",
    NEMEDA_CODEX_BIN: "/nonexistent/codex",
    ...environment
  };
}

test("watchTick runs the pipeline, logs what matters, and survives errors", () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  writeRecording(watch, "2026-09-10 09-00-00.mkv");
  const lines = [];
  const report = watchTick(root, { environment: withStubs({ NEMEDA_MEETINGS_WATCH: watch }) }, (line) => lines.push(line));
  assert.equal(report.processed.length, 1);
  assert.equal(lines.some((line) => /\[created\] transcript/.test(line)), true, lines.join("\n"));
  assert.equal(lines.some((line) => /full: 1 transcribed, 0 handed off/.test(line)), true);
  assert.equal(lines.some((line) => /discover/.test(line)), false, "routine discovery lines are not logged");
  const quiet = [];
  watchTick(root, { environment: withStubs({ NEMEDA_MEETINGS_WATCH: watch }) }, (line) => quiet.push(line));
  assert.deepEqual(quiet, [], "nothing to say when nothing happened");
  const failed = [];
  assert.equal(watchTick(makeWorkspace(config({ meetings: undefined })), { environment: withStubs() }, (line) => failed.push(line)), null);
  assert.match(failed[0], /\[error\] .*no `meetings` section/);
});

test("runMeetingWatch loops at the interval and stops after --once or a signal", async () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  writeRecording(watch, "2026-09-10 09-00-00.mkv");
  const lines = [];
  const once = await runMeetingWatch(root, { once: true, intervalSeconds: 1, environment: withStubs({ NEMEDA_MEETINGS_WATCH: watch }), log: (line) => lines.push(line) });
  assert.equal(once.ticks, 1);
  assert.match(lines[0], /watching .* every 5s/);
  let sleeps = 0;
  const looped = await runMeetingWatch(root, {
    intervalSeconds: 7,
    environment: withStubs({ NEMEDA_MEETINGS_WATCH: watch }),
    log: () => {},
    sleep: async (ms) => {
      assert.equal(ms, 7000);
      sleeps += 1;
      if (sleeps === 3) process.emit("SIGINT");
    }
  });
  assert.equal(looped.ticks, 3);
  await assert.rejects(() => runMeetingWatch(makeWorkspace(config({ meetings: undefined })), { once: true, log: () => {} }), /nothing to watch/);
});

test("install writes a launchd plist or a systemd unit per project and uninstall removes it", () => {
  const root = makeWorkspace();
  const home = temporaryDirectory();
  const env = { HOME: home, NEMEDA_HOME: path.join(home, ".nemeda") };

  const mac = installMeetingService(root, { environment: env, platform: "darwin", intervalSeconds: 45 });
  const plist = path.join(home, "Library", "LaunchAgents", "io.nemeda.agent-kit.meetings.acme.plist");
  assert.equal(mac.actions[0].status, "created");
  assert.equal(mac.actions[0].message, plist);
  const content = readFileSync(plist, "utf8");
  assert.match(content, /<string>io\.nemeda\.agent-kit\.meetings\.acme<\/string>/);
  assert.match(content, new RegExp(`<string>${process.execPath.replaceAll("/", "\\/")}<\\/string>`));
  assert.match(content, /<string>meeting<\/string>\s*<string>watch<\/string>\s*<string>--cwd<\/string>/);
  assert.match(content, /<string>45<\/string>/);
  assert.match(content, /meetings-acme\.log/);
  assert.match(mac.nextSteps[0], /launchctl bootstrap gui/);
  assert.equal(installMeetingService(root, { environment: env, platform: "darwin" }).actions[0].status, "kept");
  assert.equal(meetingServiceStatus("acme", env, "darwin").installed, true);
  const removed = uninstallMeetingService(root, { environment: env, platform: "darwin" });
  assert.equal(existsSync(plist), false);
  assert.equal(removed.actions.at(-1).status, "created");
  assert.equal(uninstallMeetingService(root, { environment: env, platform: "darwin" }).actions[0].status, "kept");

  const linux = installMeetingService(root, { environment: env, platform: "linux" });
  const unit = path.join(home, ".config", "systemd", "user", "io.nemeda.agent-kit.meetings.acme.service");
  assert.equal(linux.actions[0].message, unit);
  const unitContent = readFileSync(unit, "utf8");
  assert.match(unitContent, /^ExecStart=.*meeting watch --cwd/m);
  assert.match(unitContent, /Restart=always/);
  assert.match(linux.nextSteps[0], /systemctl --user daemon-reload && systemctl --user enable --now io\.nemeda\.agent-kit\.meetings\.acme/);
  assert.equal(installMeetingService(root, { environment: env, platform: "linux", dryRun: true }).actions[0].status, "kept");

  const windows = installMeetingService(root, { environment: env, platform: "win32" });
  assert.equal(windows.actions[0].status, "manual");
  assert.match(windows.actions[0].message, /schtasks \/Create \/SC ONLOGON \/TN "io\.nemeda\.agent-kit\.meetings\.acme"/);
  assert.equal(meetingServiceStatus("acme", env, "win32").installed, null);
  assert.equal(serviceLabel("my project/2"), "io.nemeda.agent-kit.meetings.my-project-2");
  assert.equal(servicePaths("acme", env, "linux").logFile, path.join(home, ".nemeda", "state", "meetings-acme.log"));

  const dry = installMeetingService(makeWorkspace(), { environment: { HOME: temporaryDirectory() }, platform: "darwin", dryRun: true });
  assert.equal(dry.actions[0].status, "planned");
  assert.throws(() => installMeetingService(makeWorkspace(config({ meetings: undefined })), { environment: env, platform: "darwin" }), /nothing to install/);
});

test("doctor reports the watch service state", () => {
  const root = makeWorkspace();
  const home = temporaryDirectory();
  const env = { PATH: path.dirname(process.execPath), HOME: home, NEMEDA_HOME: path.join(home, ".nemeda") };
  const probe = { platform: "darwin", arch: "arm64", release: "25.6.0", cores: 14, totalMemoryGB: 24, obs: false, yap: true };
  const byCode = (checks) => checks.filter((check) => check.code === "meetings-service");
  assert.match(byCode(meetingDoctorChecks(root, config().meetings, undefined, env, { probe, projectId: "acme" }))[0].message, /No watch service installed/);
  assert.equal(byCode(meetingDoctorChecks(root, config().meetings, undefined, env, { probe })).length, 0, "no project id, no service check");
  installMeetingService(root, { environment: env, platform: "darwin" });
  // Installed but never bootstrapped: on a Mac launchctl answers "not loaded"
  // (warn); where launchctl does not exist the state is unknown (pass).
  const canAskLaunchd = executableOnPath("launchctl", process.env);
  const check = byCode(meetingDoctorChecks(root, config().meetings, undefined, env, { probe, projectId: "acme" }))[0];
  assert.equal(check.status, canAskLaunchd ? "warn" : "pass");
  assert.equal(meetingServiceStatus("acme", env, "darwin").loaded, canAskLaunchd ? false : null);
});

test("listTranscripts and the workspace_meetings MCP tool expose what was transcribed", async () => {
  const root = makeWorkspace();
  writeTranscript(root, "2026-09-10-kick-off", { title: "Kick-off", recordedAt: "2026-09-10T09:00:00.000Z", durationSeconds: 3600, sourceName: "a.mkv" }, "Arrancamos el proyecto Acme.");
  writeTranscript(root, "2026-09-12-weekly", { title: "Weekly", recordedAt: "2026-09-12T09:00:00.000Z", durationSeconds: 1800, sourceName: "b.mkv" }, "Repasamos el backlog.");
  writeTranscript(root, "2026-09-01-old", { title: "Old", recordedAt: "2026-09-01T09:00:00.000Z", sourceName: "c.mkv" });
  writeFileSync(path.join(root, "docs", "meetings", "2026-09-12-weekly.md"), "# Weekly\n");
  mkdirSync(path.join(root, "docs", "transcripts", "not-a-transcript"));

  const all = listTranscripts(root, config().meetings);
  assert.deepEqual(all.map((item) => item.folder), ["docs/transcripts/2026-09-12-weekly", "docs/transcripts/2026-09-10-kick-off", "docs/transcripts/2026-09-01-old"]);
  assert.equal(all[0].notes, "docs/meetings/2026-09-12-weekly.md");
  assert.equal(all[1].notes, null);
  assert.equal(all[1].excerpt, "Arrancamos el proyecto Acme.");
  assert.deepEqual(listTranscripts(root, config().meetings, { since: "2026-09-10" }).map((item) => item.title), ["Weekly", "Kick-off"]);
  assert.deepEqual(listTranscripts(root, config().meetings, { query: "backlog" }).map((item) => item.title), ["Weekly"]);
  assert.deepEqual(listTranscripts(root, config().meetings, { query: "kick" }).map((item) => item.title), ["Kick-off"]);
  assert.equal(listTranscripts(root, config().meetings, { limit: 1 }).length, 1);
  assert.deepEqual(listTranscripts(temporaryDirectory(), config().meetings), []);

  const responses = await callServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_meetings", arguments: { cwd: root, query: "backlog" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workspace_meetings", arguments: { cwd: makeWorkspace(config({ meetings: undefined })) } } }
  ]);
  assert.ok(responses.get(2).result.tools.some((tool) => tool.name === "workspace_meetings"));
  const found = JSON.parse(responses.get(3).result.content[0].text);
  assert.deepEqual(found.transcripts.map((item) => item.title), ["Weekly"]);
  const missing = responses.get(4).result;
  assert.equal(missing.isError, true);
  assert.match(JSON.parse(missing.content[0].text).error, /No `meetings` section/);
});

async function callServer(requests) {
  const child = spawn(process.execPath, [path.join(pluginRoot, "scripts", "mcp-server.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const parsed = JSON.parse(line);
        responses.set(parsed.id, parsed);
      }
      newline = buffer.indexOf("\n");
    }
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  const ids = requests.map((request) => request.id);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP server timed out")), 3000);
    const poll = setInterval(() => {
      if (ids.every((id) => responses.has(id))) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 10);
  });
  child.kill();
  return responses;
}
