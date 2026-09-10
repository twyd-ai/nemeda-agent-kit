// `nemeda-agent memory install | uninstall` — the scheduled harvest trigger
// (docs/memory-plan.md, "Unattended capture", trigger 2). The SessionStart
// trigger only fires when someone opens a new session; this one runs
// `nemeda-agent memory harvest` every N minutes and at login, so a machine
// where nobody opens a session still gets its closed sessions summarised.
//
// One job per workspace, on the platform's own user-level scheduler:
// - macOS: a LaunchAgent (~/Library/LaunchAgents), loaded with launchctl;
// - Linux: a systemd user service + timer (~/.config/systemd/user);
// - Windows: a Task Scheduler task (schtasks) calling a small .cmd wrapper,
//   which keeps /TR under its 261-character limit and appends the output to
//   the log, since a scheduled task has no stdout of its own.
//
// Unlike `slack install`, this activates the job instead of printing the
// commands to run: a trigger that still needs a manual step would bring
// back the exact forgetting it exists to remove. Everything is planned as
// data first (files + commands), so tests and --dry-run exercise the real
// plan without touching the machine's scheduler.
//
// Installing is an upsert: the job embeds the plugin's absolute path, which
// changes whenever the plugin is updated, so re-running install rewrites
// what differs and re-activates. The job itself runs `memory harvest`, which
// takes the per-machine lock, so it never races the SessionStart trigger.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_INTERVAL_MINUTES = 30;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;
const DEFAULT_CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function action(kind, status, message) {
  return { kind, status, message };
}

// Stable per workspace (a hash of its root), readable (the project id), and
// distinct for two checkouts of the same project on one machine.
export function schedulerIdentity(root, config) {
  const hash = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8);
  const suffix = `${config.project.id}-${hash}`;
  return { name: `nemeda-memory-harvest-${suffix}`, label: `io.nemeda.agent-kit.memory-harvest.${suffix}` };
}

export function validateInterval(intervalMinutes) {
  const value = intervalMinutes === undefined ? DEFAULT_INTERVAL_MINUTES : Number(intervalMinutes);
  if (!Number.isInteger(value) || value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) {
    throw new Error(`--interval must be a whole number of minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`);
  }
  return value;
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

// The scheduler starts with a bare environment, so the job would not find
// `claude` or `codex` (Homebrew, ~/.local/bin, nvm). It gets the PATH of the
// person installing it, with this Node's own directory first.
function jobPath(environment, nodePath, platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  const entries = [path.dirname(nodePath), ...String(environment.PATH || "").split(delimiter)].filter(Boolean);
  return [...new Set(entries)].join(delimiter);
}

function logPathFor(root) {
  return path.join(root, ".nemeda", "state", "harvest.log");
}

function launchdPlan({ root, identity, nodePath, cliPath, intervalMinutes, environment, homeDir, uid }) {
  const plistPath = path.join(homeDir, "Library", "LaunchAgents", `${identity.label}.plist`);
  const logPath = logPathFor(root);
  const args = [nodePath, cliPath, "memory", "harvest", "--cwd", root];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(identity.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
  <key>StartInterval</key><integer>${intervalMinutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(jobPath(environment, nodePath, "darwin"))}</string>
  </dict>
</dict>
</plist>
`;
  const domain = `gui/${uid}`;
  return {
    files: [{ path: plistPath, content: plist }],
    // bootout first so a changed plist is picked up; it fails harmlessly
    // when the job was not loaded yet.
    activate: [
      { command: ["launchctl", "bootout", `${domain}/${identity.label}`], optional: true },
      { command: ["launchctl", "bootstrap", domain, plistPath] }
    ],
    deactivate: [{ command: ["launchctl", "bootout", `${domain}/${identity.label}`], optional: true }],
    logPath
  };
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdPlan({ root, config, identity, nodePath, cliPath, intervalMinutes, environment, homeDir }) {
  const unitDir = path.join(homeDir, ".config", "systemd", "user");
  const logPath = logPathFor(root);
  const service = `[Unit]
Description=Nemeda Agent Kit memory harvest for ${config.project.name}

[Service]
Type=oneshot
WorkingDirectory=${root}
Environment=${systemdQuote(`PATH=${jobPath(environment, nodePath, "linux")}`)}
ExecStart=${[nodePath, cliPath, "memory", "harvest", "--cwd", root].map(systemdQuote).join(" ")}
StandardOutput=append:${logPath}
StandardError=append:${logPath}
`;
  // OnStartupSec counts from the user manager starting, which is login.
  const timer = `[Unit]
Description=Run the Nemeda Agent Kit memory harvest for ${config.project.name} every ${intervalMinutes} minutes

[Timer]
OnStartupSec=2min
OnUnitActiveSec=${intervalMinutes}min

[Install]
WantedBy=timers.target
`;
  const timerUnit = `${identity.name}.timer`;
  return {
    files: [
      { path: path.join(unitDir, `${identity.name}.service`), content: service },
      { path: path.join(unitDir, timerUnit), content: timer }
    ],
    activate: [
      { command: ["systemctl", "--user", "daemon-reload"] },
      { command: ["systemctl", "--user", "enable", "--now", timerUnit] },
      { command: ["systemctl", "--user", "restart", timerUnit] }
    ],
    deactivate: [{ command: ["systemctl", "--user", "disable", "--now", timerUnit], optional: true }],
    afterRemoval: [{ command: ["systemctl", "--user", "daemon-reload"], optional: true }],
    logPath
  };
}

function schtasksPlan({ root, identity, nodePath, cliPath, intervalMinutes, environment }) {
  const wrapperPath = path.join(root, ".nemeda", "state", "memory-harvest-task.cmd");
  const logPath = logPathFor(root);
  const wrapper = [
    "@echo off",
    `set "PATH=${jobPath(environment, nodePath, "win32")}"`,
    `cd /d "${root}"`,
    `"${nodePath}" "${cliPath}" memory harvest --cwd "${root}" >> "${logPath}" 2>&1`,
    ""
  ].join("\r\n");
  const taskName = `Nemeda\\${identity.name}`;
  return {
    files: [{ path: wrapperPath, content: wrapper }],
    activate: [{ command: ["schtasks", "/Create", "/F", "/TN", taskName, "/SC", "MINUTE", "/MO", String(intervalMinutes), "/TR", `"${wrapperPath}"`] }],
    deactivate: [{ command: ["schtasks", "/Delete", "/F", "/TN", taskName], optional: true }],
    logPath
  };
}

// Pure: what files the job consists of and what commands (de)activate it.
export function planHarvestScheduler(root, config, options = {}) {
  const platform = options.platform || process.platform;
  const context = {
    root: path.resolve(root),
    config,
    identity: schedulerIdentity(root, config),
    nodePath: options.nodePath || process.execPath,
    cliPath: options.cliPath || DEFAULT_CLI_PATH,
    intervalMinutes: validateInterval(options.intervalMinutes),
    environment: options.environment || process.env,
    homeDir: options.homeDir || os.homedir(),
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0)
  };
  let plan;
  if (platform === "darwin") plan = launchdPlan(context);
  else if (platform === "win32") plan = schtasksPlan(context);
  else if (platform === "linux") plan = systemdPlan(context);
  else throw new Error(`No scheduler is wired for platform "${platform}"; run \`nemeda-agent memory harvest\` from your own scheduler instead.`);
  return { platform, identity: context.identity, intervalMinutes: context.intervalMinutes, cliPath: context.cliPath, afterRemoval: [], ...plan };
}

function defaultRun(command) {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 30_000 });
  if (result.error) return { ok: false, detail: result.error.message };
  return { ok: result.status === 0, detail: String(result.stderr || result.stdout || "").trim().slice(0, 300) };
}

function runCommands(steps, run, actions, dryRun) {
  for (const step of steps) {
    const shown = step.command.join(" ");
    if (dryRun) {
      actions.push(action("scheduler", "planned", `run: ${shown}`));
      continue;
    }
    const result = run(step.command);
    if (result.ok) actions.push(action("scheduler", "ok", `ran: ${shown}`));
    else if (step.optional) actions.push(action("scheduler", "skipped", `${shown} (not needed: ${result.detail || "nothing to undo"})`));
    else actions.push(action("scheduler", "error", `${shown} failed: ${result.detail || "no output"}`));
  }
}

export function installHarvestScheduler(root, config, options = {}) {
  const plan = planHarvestScheduler(root, config, options);
  const dryRun = Boolean(options.dryRun);
  const run = options.run || defaultRun;
  const actions = [];
  for (const file of plan.files) {
    const current = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
    if (current === file.content) {
      actions.push(action("scheduler-file", "kept", `${file.path} is already up to date.`));
    } else if (dryRun) {
      actions.push(action("scheduler-file", "planned", `${current === null ? "create" : "update"} ${file.path}`));
    } else {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
      actions.push(action("scheduler-file", current === null ? "created" : "updated", file.path));
    }
  }
  // Activation always runs, even when every file was kept: it is idempotent
  // on every platform, and it re-enables a job someone unloaded by hand.
  runCommands(plan.activate, run, actions, dryRun);
  return {
    dryRun,
    platform: plan.platform,
    identity: plan.identity,
    intervalMinutes: plan.intervalMinutes,
    actions,
    nextSteps: [
      `Every ${plan.intervalMinutes} minutes and at login, closed sessions are summarised into project memory. Output: ${plan.logPath}`,
      `The job points at ${plan.cliPath}; run \`nemeda-agent memory install\` again after updating the plugin so it follows the new path.`,
      "Remove it with `nemeda-agent memory uninstall`."
    ]
  };
}

export function uninstallHarvestScheduler(root, config, options = {}) {
  const plan = planHarvestScheduler(root, config, options);
  const dryRun = Boolean(options.dryRun);
  const run = options.run || defaultRun;
  const actions = [];
  const present = plan.files.filter((file) => existsSync(file.path));
  if (!present.length) {
    actions.push(action("scheduler", "kept", "No scheduled harvest is installed for this workspace; nothing to remove."));
    return { dryRun, platform: plan.platform, identity: plan.identity, actions, nextSteps: [] };
  }
  runCommands(plan.deactivate, run, actions, dryRun);
  for (const file of present) {
    if (dryRun) actions.push(action("scheduler-file", "planned", `remove ${file.path}`));
    else {
      rmSync(file.path, { force: true });
      actions.push(action("scheduler-file", "removed", file.path));
    }
  }
  runCommands(plan.afterRemoval, run, actions, dryRun);
  return { dryRun, platform: plan.platform, identity: plan.identity, actions, nextSteps: [] };
}
