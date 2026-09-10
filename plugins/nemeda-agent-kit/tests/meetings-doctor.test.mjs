import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MODEL_TIERS,
  appleLocale,
  installCommands,
  macosMajorFromDarwin,
  minutesPerHour,
  probeHost,
  recommendTier,
  resolveEngine,
  segmentsToSrt,
  segmentsToText,
  selectEngine
} from "../scripts/lib/meetings-core.mjs";
import { meetingDoctorChecks, meetingInboxContext } from "../scripts/lib/meetings-doctor.mjs";
import { processRecordings } from "../scripts/lib/meetings.mjs";
import { planMeetingSetup, runMeetingSetup } from "../scripts/lib/meetings-setup.mjs";
import { workspaceDoctor } from "../scripts/lib/workspace.mjs";

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "nemeda-meetings-doctor-"));
}

// A PATH with only the named fake binaries, so tool detection is deterministic
// whatever is installed on the machine running the tests.
function fakePath(names) {
  const binDir = temporaryDirectory();
  for (const name of names) {
    const file = path.join(binDir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return binDir;
}

// obs: false keeps the tests independent from what is installed under /Applications.
const M1 = { platform: "darwin", arch: "arm64", release: "25.6.0", cores: 14, totalMemoryGB: 24, obs: false };
const INTEL_MAC = { platform: "darwin", arch: "x64", release: "24.5.0", cores: 8, totalMemoryGB: 16, obs: false };
const PC = { platform: "win32", arch: "x64", release: "10.0.22631", cores: 8, totalMemoryGB: 16, nvidia: false, obs: false };
const OLD_PC = { platform: "linux", arch: "x64", release: "6.8.0", cores: 2, totalMemoryGB: 4, nvidia: false, obs: false };

function baseConfig(meetings = { transcripts: "docs/transcripts", notes: "docs/meetings", language: "es" }, drive = true) {
  return {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "workspace", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true, conversationLanguage: "es" },
    ...(drive ? { drive: { sharedDrive: "Acme", links: { docs: "docs" } } } : {}),
    ...(meetings ? { meetings } : {})
  };
}

function makeWorkspace(config = baseConfig(), { transcriptsFolder = true } = {}) {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  if (transcriptsFolder && config.meetings?.transcripts) mkdirSync(path.join(root, config.meetings.transcripts), { recursive: true });
  return root;
}

function writeRecording(directory, name, ageSeconds = 600) {
  const filePath = path.join(directory, name);
  writeFileSync(filePath, "video");
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(filePath, when, when);
  return filePath;
}

test("macOS major version is derived from the Darwin release", () => {
  assert.equal(macosMajorFromDarwin("25.6.0"), 26);
  assert.equal(macosMajorFromDarwin("24.5.0"), 15);
  assert.equal(macosMajorFromDarwin("23.0.0"), 14);
  assert.equal(macosMajorFromDarwin("garbage"), null);
});

test("probeHost classifies machines and finds tools on the given PATH", () => {
  const env = { PATH: fakePath(["ffmpeg", "yap", "brew"]) };
  const m1 = probeHost(env, M1);
  assert.equal(m1.appleSpeechEligible, true);
  assert.equal(m1.gpu, "metal");
  assert.deepEqual([m1.tools.ffmpeg, m1.tools.yap, m1.tools.brew, m1.tools.whisperCli], [true, true, true, false]);
  const intel = probeHost(env, INTEL_MAC);
  assert.equal(intel.appleSpeechEligible, false);
  assert.equal(intel.gpu, null);
  const pc = probeHost({ PATH: fakePath(["nvidia-smi.exe", "ffmpeg.exe"]) }, { ...PC, nvidia: undefined });
  assert.equal(pc.gpu, "nvidia");
  assert.equal(pc.tools.ffmpeg, true);
});

test("recommendTier follows the hardware and the floor", () => {
  assert.equal(recommendTier(probeHost({}, M1)).tier, "large-v3-turbo");
  assert.equal(recommendTier(probeHost({}, { ...PC, nvidia: true })).tier, "large-v3-turbo");
  assert.equal(recommendTier(probeHost({}, INTEL_MAC)).tier, "small");
  const floor = recommendTier(probeHost({}, OLD_PC));
  assert.equal(floor.tier, null);
  assert.match(floor.reason, /below the floor/);
  assert.ok(minutesPerHour("apple-speech", null, probeHost({}, M1)) <= 2);
  assert.ok(minutesPerHour("whisper-cpp", "large-v3-turbo", probeHost({}, INTEL_MAC)) > 60);
  assert.ok(minutesPerHour("whisper-cpp", "small", probeHost({}, INTEL_MAC)) < 30);
  assert.equal(minutesPerHour("nope", null, probeHost({}, M1)), null);
});

test("selectEngine prefers apple-speech only on an eligible Mac with yap installed", () => {
  const withYap = { PATH: fakePath(["yap", "whisper-cli", "ffmpeg"]) };
  const withoutYap = { PATH: fakePath(["whisper-cli", "ffmpeg"]) };
  assert.equal(selectEngine(probeHost(withYap, M1), withYap).engine.name, "apple-speech");
  const fallback = selectEngine(probeHost(withoutYap, M1), withoutYap);
  assert.equal(fallback.engine.name, "whisper-cpp");
  assert.equal(fallback.alternative, "apple-speech");
  assert.equal(selectEngine(probeHost(withoutYap, M1), withoutYap, { allowUninstalled: true }).engine.name, "apple-speech");
  assert.equal(selectEngine(probeHost(withYap, INTEL_MAC), withYap).engine.name, "whisper-cpp");
  assert.equal(selectEngine(probeHost(withYap, PC), withYap).alternative, null);
  const forced = selectEngine(probeHost(withYap, M1), { ...withYap, NEMEDA_MEETINGS_ENGINE: "whisper-cpp" });
  assert.equal(forced.engine.name, "whisper-cpp");
  assert.match(forced.reason, /NEMEDA_MEETINGS_ENGINE/);
  assert.equal(selectEngine(probeHost(withYap, M1), withYap, { explicit: "whisper-cpp" }).reason, "chosen with --engine");
  assert.throws(() => selectEngine(probeHost(withYap, M1), withYap, { explicit: "parakeet" }), /Unknown transcription engine/);
});

test("installCommands only list what is missing, per platform and engine", () => {
  const bare = { PATH: fakePath(["brew"]) };
  const mac = installCommands(probeHost(bare, M1), { engineName: "apple-speech", obs: true });
  assert.deepEqual(mac.map((step) => step.command), [["brew", "install", "yap"], ["brew", "install", "--cask", "obs"]]);
  const macWhisper = installCommands(probeHost(bare, M1), { engineName: "whisper-cpp" });
  assert.deepEqual(macWhisper[0].command, ["brew", "install", "ffmpeg", "whisper-cpp"]);
  const noBrew = installCommands(probeHost({ PATH: fakePath([]) }, INTEL_MAC), { engineName: "whisper-cpp" });
  assert.equal(noBrew[0].run, false);
  assert.match(noBrew[0].message, /brew\.sh/);
  const pc = installCommands(probeHost({ PATH: fakePath(["winget.exe"]) }, PC), { engineName: "whisper-cpp", obs: true });
  assert.deepEqual(pc.filter((step) => step.run).map((step) => step.command[3]), ["Gyan.FFmpeg", "OBSProject.OBSStudio"]);
  assert.match(pc.find((step) => !step.run).message, /whisper-bin-x64/);
  const linux = installCommands(probeHost({ PATH: fakePath([]) }, OLD_PC), { engineName: "whisper-cpp" });
  assert.equal(linux.every((step) => !step.run), true);
  assert.deepEqual(installCommands(probeHost({ PATH: fakePath(["ffmpeg", "whisper-cli"]) }, INTEL_MAC), { engineName: "whisper-cpp" }), []);
});

test("apple-speech adapter builds the yap command and converts its JSON", () => {
  const engine = resolveEngine("apple-speech");
  const command = engine.command({ binary: "yap", input: "/r/x.mkv", outputBase: "/tmp/t", language: "es" });
  assert.deepEqual(command.args, ["transcribe", "/r/x.mkv", "--json", "--output-file", "/tmp/t.json", "--locale", "es-ES"]);
  assert.equal(engine.command({ binary: "yap", input: "/r/x.mkv", outputBase: "/tmp/t", language: "auto" }).args.includes("--locale"), false);
  assert.equal(appleLocale("pt-BR"), "pt-BR");
  assert.equal(appleLocale("xx"), null);
  const base = path.join(temporaryDirectory(), "t");
  writeFileSync(`${base}.json`, JSON.stringify({
    metadata: { created: "2026-09-10T08:46:13Z", duration: 10.44, language: "en-US" },
    segments: [
      { id: 1, start: 0, end: 5.58, text: "And so, my fellow Americans," },
      { id: 2, start: 5.58, end: 7.74, text: "ask not." },
      { id: 3, start: 10.2, end: 10.44, text: "Thank you." }
    ]
  }));
  const parsed = engine.parse(base);
  assert.equal(parsed.language, "en-US");
  assert.equal(parsed.durationSeconds, 10.44);
  assert.equal(parsed.text, "And so, my fellow Americans, ask not.\n\nThank you.");
  assert.match(parsed.srt, /^1\n00:00:00,000 --> 00:00:05,580\nAnd so, my fellow Americans,\n\n2\n/);
  assert.equal(engine.parse(path.join(temporaryDirectory(), "missing")).text, null);
  assert.equal(segmentsToText([]), "");
  assert.equal(segmentsToSrt([{ start: 3661.5, end: 3662, text: "x" }]), "1\n01:01:01,500 --> 01:01:02,000\nx\n");
});

test("meetingDoctorChecks reports engine, model, folders, watch, and backlog", () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  writeRecording(watch, "2026-09-10 09-00-00.mkv");
  writeRecording(watch, "2026-09-10 10-00-00.mkv", 3);
  const models = temporaryDirectory();
  writeFileSync(path.join(models, "ggml-small.bin"), "m");

  // Eligible Mac with everything installed: apple-speech, no ffmpeg or model needed.
  const home = temporaryDirectory(); // no ~/whisper-models here
  const mac = { PATH: fakePath(["yap", "ffmpeg", "whisper-cli"]), HOME: home, NEMEDA_MEETINGS_WATCH: watch };
  const macChecks = meetingDoctorChecks(root, baseConfig().meetings, baseConfig().drive, mac, { probe: M1 });
  const byCode = (checks, code) => checks.filter((check) => check.code === code);
  assert.match(byCode(macChecks, "meetings-capability")[0].message, /system model/);
  assert.equal(byCode(macChecks, "meetings-engine")[0].status, "pass");
  assert.match(byCode(macChecks, "meetings-ffmpeg")[0].message, /not needed/);
  assert.equal(byCode(macChecks, "meetings-model").length, 0);
  assert.equal(byCode(macChecks, "meetings-watch")[0].status, "pass");
  assert.match(byCode(macChecks, "meetings-backlog")[0].message, /1 recording\(s\) ready.*1 still being written/);
  assert.equal(byCode(macChecks, "meetings-folders").map((check) => check.status).join(","), "pass,warn");

  // Same Mac without yap: whisper fallback, hint to install yap, model below the recommendation.
  const noYap = { PATH: fakePath(["ffmpeg", "whisper-cli"]), HOME: home, NEMEDA_MEETINGS_WATCH: watch, NEMEDA_WHISPER_MODEL: path.join(models, "ggml-small.bin") };
  const noYapChecks = meetingDoctorChecks(root, baseConfig().meetings, baseConfig().drive, noYap, { probe: M1 });
  assert.match(byCode(noYapChecks, "meetings-capability")[0].message, /recommended whisper model large-v3-turbo/);
  assert.deepEqual(byCode(noYapChecks, "meetings-engine").map((check) => check.status), ["pass", "warn"]);
  assert.match(byCode(noYapChecks, "meetings-model")[0].message, /below the recommended large-v3-turbo/);

  // Intel Mac with nothing installed and no model.
  const empty = { PATH: fakePath(["brew"]), HOME: home, NEMEDA_MEETINGS_WATCH: watch };
  const emptyChecks = meetingDoctorChecks(root, baseConfig().meetings, baseConfig().drive, empty, { probe: INTEL_MAC });
  assert.equal(byCode(emptyChecks, "meetings-engine")[0].status, "fail");
  assert.match(byCode(emptyChecks, "meetings-engine")[0].message, /brew install ffmpeg whisper-cpp/);
  assert.equal(byCode(emptyChecks, "meetings-ffmpeg")[0].status, "fail");
  assert.match(byCode(emptyChecks, "meetings-model")[0].message, /downloads ggml-small.bin/);

  // Below the floor.
  const floorChecks = meetingDoctorChecks(root, baseConfig().meetings, baseConfig().drive, empty, { probe: OLD_PC });
  assert.equal(byCode(floorChecks, "meetings-capability")[0].status, "warn");
  assert.match(byCode(floorChecks, "meetings-capability")[0].message, /below the floor/);

  // No watch folder, missing transcripts folder, no drive section.
  const bareRoot = makeWorkspace(baseConfig(undefined, false), { transcriptsFolder: false });
  const bareChecks = meetingDoctorChecks(bareRoot, baseConfig().meetings, undefined, { PATH: fakePath(["yap"]), HOME: temporaryDirectory() }, { probe: M1 });
  assert.equal(byCode(bareChecks, "meetings-watch")[0].status, "warn");
  assert.equal(byCode(bareChecks, "meetings-folders")[0].status, "fail");
  assert.equal(byCode(bareChecks, "meetings-backlog").length, 0);

  // .env.local is honoured without touching the caller's environment.
  writeFileSync(path.join(root, ".env.local"), `NEMEDA_MEETINGS_ENGINE=whisper-cpp\nNEMEDA_WHISPER_MODEL=${path.join(models, "ggml-small.bin")}\n`);
  const envChecks = meetingDoctorChecks(root, baseConfig().meetings, baseConfig().drive, mac, { probe: M1 });
  assert.match(byCode(envChecks, "meetings-engine")[0].message, /NEMEDA_MEETINGS_ENGINE/);
  assert.equal(mac.NEMEDA_MEETINGS_ENGINE, undefined);
});

test("nemeda-agent doctor includes the meetings block only when configured", () => {
  const root = makeWorkspace();
  const codes = workspaceDoctor(root).checks.map((check) => check.code);
  assert.ok(codes.includes("meetings-engine"));
  assert.ok(codes.includes("meetings-capability"));
  const plain = workspaceDoctor(makeWorkspace(baseConfig(null))).checks.map((check) => check.code);
  assert.equal(plain.some((code) => code.startsWith("meetings-")), false);
});

test("meetingInboxContext flags waiting recordings and stays silent otherwise", () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  assert.equal(meetingInboxContext(root, baseConfig().meetings, { NEMEDA_MEETINGS_WATCH: watch }), "");
  writeRecording(watch, "2026-09-10 09-00-00.mkv");
  writeRecording(watch, "2026-09-10 11-00-00.mkv", 3);
  const line = meetingInboxContext(root, baseConfig().meetings, { NEMEDA_MEETINGS_WATCH: watch });
  assert.match(line, /Meeting recordings waiting: 1 in .*2026-09-10 09-00-00\.mkv/);
  assert.match(line, /nemeda-agent meeting process/);
  assert.equal(meetingInboxContext(root, undefined, { NEMEDA_MEETINGS_WATCH: watch }), "");
  assert.equal(meetingInboxContext(root, baseConfig().meetings, { HOME: temporaryDirectory() }), "");
});

test("planMeetingSetup and runMeetingSetup install, download, and record choices without running anything in dry run", () => {
  const root = makeWorkspace();
  const models = temporaryDirectory();
  const env = { PATH: fakePath(["brew"]), HOME: temporaryDirectory() };

  const macPlan = planMeetingSetup(root, env, { probe: M1, obs: true, modelsDirectory: models });
  assert.equal(macPlan.engine, "apple-speech");
  assert.deepEqual(macPlan.steps.map((step) => step.command), [["brew", "install", "yap"], ["brew", "install", "--cask", "obs"]]);
  assert.equal(macPlan.download, null);
  assert.deepEqual(macPlan.envLines, ["NEMEDA_MEETINGS_ENGINE=apple-speech"]);

  const intelPlan = planMeetingSetup(root, env, { probe: INTEL_MAC, modelsDirectory: models });
  assert.equal(intelPlan.engine, "whisper-cpp");
  assert.equal(intelPlan.download.tier, "small");
  assert.equal(intelPlan.download.file, path.join(models, MODEL_TIERS.small.file));
  assert.match(intelPlan.download.url, /ggml-small\.bin$/);
  assert.deepEqual(intelPlan.envLines, ["NEMEDA_MEETINGS_ENGINE=whisper-cpp", `NEMEDA_WHISPER_MODEL=${path.join(models, "ggml-small.bin")}`]);
  assert.equal(planMeetingSetup(root, env, { probe: INTEL_MAC, model: "large-v3-turbo", modelsDirectory: models }).download.tier, "large-v3-turbo");
  assert.throws(() => planMeetingSetup(root, env, { probe: INTEL_MAC, model: "huge" }), /Unknown model tier/);
  assert.equal(planMeetingSetup(root, env, { probe: OLD_PC, modelsDirectory: models }).download, null);

  const dry = runMeetingSetup(intelPlan, { dryRun: true });
  assert.deepEqual(dry.actions.map((entry) => entry.status), ["planned", "planned", "planned"]);
  assert.equal(existsSync(path.join(root, ".env.local")), false);

  const executed = [];
  const fetched = [];
  const done = runMeetingSetup(intelPlan, {
    execute: (command) => executed.push(command),
    fetchModel: (download) => {
      fetched.push(download.url);
      writeFileSync(download.file, "model");
    }
  });
  assert.deepEqual(executed, [["brew", "install", "ffmpeg", "whisper-cpp"]]);
  assert.equal(fetched.length, 1);
  assert.equal(done.actions.some((entry) => entry.status === "error"), false);
  const envFile = readFileSync(path.join(root, ".env.local"), "utf8");
  assert.match(envFile, /# Meeting capture/);
  assert.match(envFile, /^NEMEDA_MEETINGS_ENGINE=whisper-cpp$/m);
  assert.match(envFile, new RegExp(`^NEMEDA_WHISPER_MODEL=${path.join(models, "ggml-small.bin").replaceAll("/", "\\/")}$`, "m"));

  // Second plan on the same machine: tools and model present, env already written.
  const again = planMeetingSetup(root, { ...env, PATH: fakePath(["brew", "ffmpeg", "whisper-cli"]) }, { probe: INTEL_MAC, modelsDirectory: models });
  assert.equal(again.nothingToDo, true);
  assert.equal(runMeetingSetup(again).actions[0].status, "kept");

  // A failing install stops before the download and reports it.
  const failing = runMeetingSetup(intelPlan, { execute: () => { throw new Error("brew exploded"); }, fetchModel: () => fetched.push("unexpected") });
  assert.equal(failing.actions[0].status, "error");
  assert.equal(fetched.length, 1);
});

test("processRecordings uses apple-speech without ffmpeg or a model when selected", () => {
  const root = makeWorkspace();
  const watch = temporaryDirectory();
  const file = writeRecording(watch, "2026-09-10 09-00-00.mkv");
  const binDir = temporaryDirectory();
  const yap = path.join(binDir, "yap");
  writeFileSync(yap, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.STUB_LOG_YAP, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf("--output-file") + 1], JSON.stringify({ metadata: { duration: 3, language: "es-ES" }, segments: [{ id: 1, start: 0, end: 3, text: "Hola equipo." }] }));
`);
  chmodSync(yap, 0o755);
  const environment = { ...process.env, NEMEDA_YAP_BIN: yap, NEMEDA_FFMPEG_BIN: "/nonexistent/ffmpeg", STUB_LOG_YAP: path.join(binDir, "yap.log") };
  delete environment.NEMEDA_MEETINGS_ENGINE;
  delete environment.NEMEDA_WHISPER_MODEL;
  const report = processRecordings(root, { environment, file, engine: "apple-speech", title: "Daily" });
  assert.equal(report.processed.length, 1, JSON.stringify(report.actions));
  assert.equal(report.actions.some((entry) => entry.kind === "audio"), false, "no ffmpeg step for apple-speech");
  const args = JSON.parse(readFileSync(environment.STUB_LOG_YAP, "utf8"));
  assert.equal(args[0], "transcribe");
  assert.equal(args[1], file);
  assert.equal(args[args.indexOf("--locale") + 1], "es-ES");
  const folder = path.join(root, "docs", "transcripts", "2026-09-10-daily");
  assert.equal(readFileSync(path.join(folder, "transcript.txt"), "utf8"), "Hola equipo.\n");
  const meta = JSON.parse(readFileSync(path.join(folder, "meta.json"), "utf8"));
  assert.equal(meta.engine, "apple-speech");
  assert.equal(meta.model, null);
  assert.equal(meta.language, "es-ES");
  assert.equal(meta.durationSeconds, 3);
  // Selecting an engine whose binary is missing is reported, not crashed.
  const missing = processRecordings(root, { environment: { ...environment, NEMEDA_YAP_BIN: "/nonexistent/yap" }, file: writeRecording(watch, "2026-09-11 09-00-00.mkv"), engine: "apple-speech" });
  assert.match(missing.actions.find((entry) => entry.status === "error").message, /not installed/);
});
