// The scheduled harvest trigger (`memory install | uninstall`). Every test
// plans against a fake home directory and a recording command runner, so the
// real launchctl / systemctl / schtasks are never invoked — the plan, the
// files it writes, and the commands it would run are all checked as data.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installHarvestScheduler,
  planHarvestScheduler,
  schedulerIdentity,
  uninstallHarvestScheduler,
  validateInterval
} from "../scripts/lib/harvest-scheduler.mjs";

const config = { project: { id: "acme", name: "Acme & Co" }, memory: { project: { path: "memory" } } };

function fixture({ platform = "darwin", rootName = "workspace" } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "nemeda-scheduler-"));
  const root = path.join(base, rootName);
  const homeDir = path.join(base, "home");
  const calls = [];
  const failing = new Set();
  const run = (command) => {
    calls.push(command.join(" "));
    return failing.has(command.slice(0, 3).join(" ")) ? { ok: false, detail: "boom" } : { ok: true, detail: "" };
  };
  const options = {
    platform,
    homeDir,
    uid: 501,
    run,
    nodePath: "/opt/node/bin/node",
    cliPath: "/plugins/nemeda/scripts/cli.mjs",
    environment: { PATH: "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin" }
  };
  return { root, homeDir, calls, failing, options };
}

test("identity is stable per workspace and distinct across checkouts", () => {
  const first = schedulerIdentity("/work/acme", config);
  assert.deepEqual(schedulerIdentity("/work/acme", config), first);
  assert.notEqual(schedulerIdentity("/work/acme-copy", config).name, first.name);
  assert.match(first.name, /^nemeda-memory-harvest-acme-[0-9a-f]{8}$/);
  assert.match(first.label, /^io\.nemeda\.agent-kit\.memory-harvest\.acme-[0-9a-f]{8}$/);
});

test("interval defaults to 30 minutes and is bounded", () => {
  assert.equal(validateInterval(undefined), 30);
  assert.equal(validateInterval("15"), 15);
  for (const bad of [4, 1441, 7.5, "soon"]) assert.throws(() => validateInterval(bad), /--interval/);
});

test("macOS: a LaunchAgent that runs every interval and at load, with the installer's PATH", () => {
  const { root, homeDir, options } = fixture({ platform: "darwin", rootName: "R&D <workspace>" });
  const plan = planHarvestScheduler(root, config, { ...options, intervalMinutes: 20 });
  const [plist] = plan.files;
  assert.equal(path.dirname(plist.path), path.join(homeDir, "Library", "LaunchAgents"));
  assert.match(plist.content, /<key>StartInterval<\/key><integer>1200<\/integer>/);
  assert.match(plist.content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist.content, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(plist.content, /<string>memory<\/string>\s*<string>harvest<\/string>\s*<string>--cwd<\/string>/);
  assert.ok(plist.content.includes("R&amp;D &lt;workspace&gt;"), "paths are XML-escaped");
  assert.ok(!plist.content.includes("R&D <workspace>"));
  assert.ok(plist.content.includes(path.join(".nemeda", "state", "harvest.log")));
  assert.match(plist.content, /<string>\/opt\/node\/bin:\/Users\/me\/\.local\/bin:\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.deepEqual(plan.activate.map((step) => step.command.slice(0, 2).join(" ")), ["launchctl bootout", "launchctl bootstrap"]);
  assert.equal(plan.activate[0].optional, true, "bootout of a job that is not loaded yet is harmless");
  assert.equal(plan.activate[1].command[2], "gui/501");
});

test("Linux: a systemd user service and timer, quoted for paths with spaces", () => {
  const { root, homeDir, options } = fixture({ platform: "linux", rootName: "my workspace" });
  const plan = planHarvestScheduler(root, config, { ...options, intervalMinutes: 15 });
  const [service, timer] = plan.files;
  assert.equal(path.dirname(service.path), path.join(homeDir, ".config", "systemd", "user"));
  assert.match(service.path, /\.service$/);
  assert.match(timer.path, /\.timer$/);
  assert.match(service.content, /^Type=oneshot$/m);
  assert.ok(service.content.includes(`"--cwd" "${root}"`), "every ExecStart argument is quoted");
  assert.match(service.content, /^StandardOutput=append:.*harvest\.log$/m);
  assert.match(timer.content, /^OnUnitActiveSec=15min$/m);
  assert.match(timer.content, /^OnStartupSec=2min$/m);
  assert.match(timer.content, /^WantedBy=timers\.target$/m);
  assert.deepEqual(plan.activate.map((step) => step.command.slice(2).join(" ")), ["daemon-reload", `enable --now ${path.basename(timer.path)}`, `restart ${path.basename(timer.path)}`]);
});

test("Windows: a schtasks job calling a .cmd wrapper that appends to the log", () => {
  const { root, options } = fixture({ platform: "win32" });
  const plan = planHarvestScheduler(root, config, { ...options, environment: { PATH: "C:\\Tools;C:\\Windows" } });
  const [wrapper] = plan.files;
  assert.equal(path.dirname(wrapper.path), path.join(root, ".nemeda", "state"));
  assert.match(wrapper.content, /^@echo off\r\n/);
  assert.match(wrapper.content, /memory harvest --cwd ".*" >> ".*harvest\.log" 2>&1/);
  assert.ok(wrapper.content.includes('set "PATH=/opt/node/bin;C:\\Tools;C:\\Windows"'));
  const create = plan.activate[0].command;
  assert.deepEqual(create.slice(0, 3), ["schtasks", "/Create", "/F"]);
  assert.equal(create[create.indexOf("/SC") + 1], "MINUTE");
  assert.equal(create[create.indexOf("/MO") + 1], "30");
  assert.equal(create[create.indexOf("/TR") + 1], `"${wrapper.path}"`);
  assert.ok(create[create.indexOf("/TR") + 1].length < 261, "/TR stays under schtasks' limit however long the real command is");
});

test("unsupported platforms say what to do instead", () => {
  const { root, options } = fixture({ platform: "freebsd" });
  assert.throws(() => planHarvestScheduler(root, config, options), /No scheduler is wired for platform "freebsd"/);
});

test("install writes the files, activates, and is idempotent; a changed plan is rewritten", () => {
  const { root, calls, options } = fixture({ platform: "darwin" });
  const first = installHarvestScheduler(root, config, options);
  assert.ok(first.actions.some((entry) => entry.kind === "scheduler-file" && entry.status === "created"));
  assert.ok(existsSync(first.actions.find((entry) => entry.status === "created").message));
  assert.deepEqual(calls.map((call) => call.split(" ").slice(0, 2).join(" ")), ["launchctl bootout", "launchctl bootstrap"]);

  calls.length = 0;
  const second = installHarvestScheduler(root, config, options);
  assert.ok(second.actions.some((entry) => entry.kind === "scheduler-file" && entry.status === "kept"));
  assert.equal(calls.length, 2, "activation still runs, to re-enable a job someone unloaded by hand");

  const updated = installHarvestScheduler(root, config, { ...options, cliPath: "/plugins/nemeda-0.4.0/scripts/cli.mjs" });
  const rewrite = updated.actions.find((entry) => entry.kind === "scheduler-file");
  assert.equal(rewrite.status, "updated", "a new plugin path rewrites the job");
  assert.ok(readFileSync(rewrite.message, "utf8").includes("/plugins/nemeda-0.4.0/scripts/cli.mjs"));
  assert.ok(updated.nextSteps.some((step) => step.includes("after updating the plugin")));
});

test("a failing required command is an error; a failing optional one is not", () => {
  const { root, failing, options } = fixture({ platform: "darwin" });
  failing.add("launchctl bootout gui/501/" + schedulerIdentity(root, config).label);
  const tolerated = installHarvestScheduler(root, config, options);
  assert.ok(tolerated.actions.some((entry) => entry.status === "skipped"));
  assert.ok(!tolerated.actions.some((entry) => entry.status === "error"));

  const broken = fixture({ platform: "darwin" });
  broken.failing.add("launchctl bootstrap gui/501");
  const report = installHarvestScheduler(broken.root, config, broken.options);
  const error = report.actions.find((entry) => entry.status === "error");
  assert.ok(error);
  assert.match(error.message, /launchctl bootstrap .* failed: boom/);
});

test("a dry run writes nothing and runs nothing", () => {
  const { root, calls, options } = fixture({ platform: "linux" });
  const report = installHarvestScheduler(root, config, { ...options, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(calls.length, 0);
  assert.ok(report.actions.every((entry) => entry.status === "planned"));
  assert.ok(planHarvestScheduler(root, config, options).files.every((file) => !existsSync(file.path)));
});

test("uninstall deactivates and removes exactly what install created", () => {
  const { root, calls, options } = fixture({ platform: "linux" });
  const plan = planHarvestScheduler(root, config, options);
  installHarvestScheduler(root, config, options);
  assert.ok(plan.files.every((file) => existsSync(file.path)));

  calls.length = 0;
  const report = uninstallHarvestScheduler(root, config, options);
  assert.ok(plan.files.every((file) => !existsSync(file.path)));
  assert.equal(report.actions.filter((entry) => entry.status === "removed").length, 2);
  assert.deepEqual(calls, [`systemctl --user disable --now ${path.basename(plan.files[1].path)}`, "systemctl --user daemon-reload"]);

  const again = uninstallHarvestScheduler(root, config, options);
  assert.match(again.actions[0].message, /nothing to remove/);
});
