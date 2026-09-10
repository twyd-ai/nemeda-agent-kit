// Phase 5 of docs/meeting-capture-plan.md: the unattended mode. `meeting
// watch` polls the folders this machine's role cares about and runs the
// pipeline; `meeting install` registers that loop as a user service
// (launchd on macOS, a systemd user unit on Linux, a Task Scheduler command
// on Windows) so it starts at login. Polling, not fs.watch: large files
// still being written and cloud-synced folders make change events
// unreliable, and a directory listing every 30 s costs nothing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processRecordings } from "./meetings.mjs";
import { stateDirectory } from "./slack.mjs";
import { readWorkspaceContext } from "./workspace.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_INTERVAL_SECONDS = 30;
export const SERVICE_LABEL_PREFIX = "io.nemeda.agent-kit.meetings";

function action(kind, status, message, extra = {}) {
  return { kind, status, message, ...extra };
}

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// One tick = one `meeting process` run for this machine's role. Errors are
// logged and the loop keeps going: a transient Drive hiccup must not stop
// the service. Returns the report so tests and `--once` can inspect it.
export function watchTick(start, options = {}, log = console.log) {
  try {
    const report = processRecordings(start, { environment: options.environment, engine: options.engine, skipNotes: options.skipNotes });
    const interesting = report.actions.filter((entry) => !["discover", "inbox"].includes(entry.kind) || entry.status !== "ok");
    for (const entry of interesting) log(`${stamp()} [${entry.status}] ${entry.kind}: ${entry.message}`);
    if (report.processed.length || report.handedOff.length) {
      log(`${stamp()} ${report.role}: ${report.processed.length} transcribed, ${report.handedOff.length} handed off.`);
    }
    return report;
  } catch (error) {
    log(`${stamp()} [error] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function runMeetingWatch(start, { intervalSeconds = DEFAULT_INTERVAL_SECONDS, once = false, environment = process.env, engine, skipNotes, log = console.log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const interval = Math.max(5, Number(intervalSeconds) || DEFAULT_INTERVAL_SECONDS);
  const context = readWorkspaceContext(start);
  if (context.mode !== "configured" || !context.config?.meetings) {
    throw new Error("No `meetings` section in .nemeda/agent-kit.json; nothing to watch.");
  }
  let running = true;
  const stop = () => {
    running = false;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log(`${stamp()} watching ${context.root} every ${interval}s (Ctrl-C to stop)`);
  let ticks = 0;
  try {
    while (running) {
      watchTick(context.root, { environment, engine, skipNotes }, log);
      ticks += 1;
      if (once) break;
      await sleep(interval * 1000);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return { root: context.root, ticks };
}

// ---------------------------------------------------------------------------
// Service registration. One service per workspace (label carries the
// project id), running `node cli.mjs meeting watch --cwd <root>`.
// ---------------------------------------------------------------------------

export function serviceLabel(projectId) {
  return `${SERVICE_LABEL_PREFIX}.${String(projectId).replace(/[^A-Za-z0-9.-]+/g, "-")}`;
}

export function servicePaths(projectId, environment = process.env, platform = process.platform) {
  const home = environment.HOME || os.homedir();
  const label = serviceLabel(projectId);
  const logFile = path.join(stateDirectory(environment), `meetings-${projectId}.log`);
  if (platform === "darwin") return { platform, label, file: path.join(home, "Library", "LaunchAgents", `${label}.plist`), logFile };
  if (platform === "linux") return { platform, label, file: path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", `${label}.service`), logFile };
  return { platform, label, file: null, logFile };
}

function watchCommand(root, intervalSeconds) {
  return [process.execPath, path.join(PLUGIN_ROOT, "scripts", "cli.mjs"), "meeting", "watch", "--cwd", root, "--interval", String(intervalSeconds)];
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function launchdPlist(label, command, logFile) {
  const nodeDirectory = path.dirname(process.execPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((part) => `    <string>${escapeXml(part)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(`${nodeDirectory}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
  </dict>
</dict>
</plist>
`;
}

function systemdUnit(label, command, logFile) {
  const quote = (part) => (/[\s"]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part);
  return `[Unit]
Description=Nemeda Agent Kit meeting capture (${label})
After=default.target

[Service]
ExecStart=${command.map(quote).join(" ")}
Restart=always
RestartSec=10
StandardOutput=append:${logFile}
StandardError=append:${logFile}
Environment=PATH=${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

export function installMeetingService(start, { environment = process.env, platform = process.platform, intervalSeconds = DEFAULT_INTERVAL_SECONDS, dryRun = false } = {}) {
  const context = readWorkspaceContext(start);
  if (context.mode !== "configured" || !context.config?.meetings) {
    throw new Error("No `meetings` section in .nemeda/agent-kit.json; nothing to install.");
  }
  const paths = servicePaths(context.config.project.id, environment, platform);
  const command = watchCommand(context.root, intervalSeconds);
  const actions = [];
  const nextSteps = [];
  if (platform === "win32") {
    const taskCommand = `schtasks /Create /SC ONLOGON /TN "${paths.label}" /TR "\\"${command[0]}\\" \\"${command[1]}\\" meeting watch --cwd \\"${context.root}\\" --interval ${intervalSeconds}" /F`;
    actions.push(action("service", "manual", `Register the watch loop with Task Scheduler (runs at logon): ${taskCommand}`));
    nextSteps.push(`Remove it later with: schtasks /Delete /TN "${paths.label}" /F`);
    return { root: context.root, dryRun, actions, nextSteps, service: paths };
  }
  if (existsSync(paths.file)) {
    actions.push(action("service", "kept", `${paths.file} already exists; run \`nemeda-agent meeting uninstall\` first to regenerate it.`));
    nextSteps.push(platform === "darwin" ? `launchctl kickstart -k gui/$(id -u)/${paths.label}` : `systemctl --user restart ${paths.label}`);
    return { root: context.root, dryRun, actions, nextSteps, service: paths };
  }
  const content = platform === "darwin" ? launchdPlist(paths.label, command, paths.logFile) : systemdUnit(paths.label, command, paths.logFile);
  if (dryRun) {
    actions.push(action("service", "planned", `write ${paths.file}`));
  } else {
    mkdirSync(path.dirname(paths.file), { recursive: true });
    mkdirSync(path.dirname(paths.logFile), { recursive: true });
    writeFileSync(paths.file, content);
    actions.push(action("service", "created", paths.file));
  }
  if (platform === "darwin") {
    nextSteps.push(`launchctl bootstrap gui/$(id -u) ${paths.file}`, `Logs: ${paths.logFile}`, `Stop it with: nemeda-agent meeting uninstall`);
  } else {
    nextSteps.push(`systemctl --user daemon-reload && systemctl --user enable --now ${paths.label}`, `Logs: ${paths.logFile}`, `Stop it with: nemeda-agent meeting uninstall`);
  }
  return { root: context.root, dryRun, actions, nextSteps, service: paths };
}

export function uninstallMeetingService(start, { environment = process.env, platform = process.platform, dryRun = false } = {}) {
  const context = readWorkspaceContext(start);
  if (context.mode !== "configured" || !context.config?.meetings) {
    throw new Error("No `meetings` section in .nemeda/agent-kit.json; nothing to uninstall.");
  }
  const paths = servicePaths(context.config.project.id, environment, platform);
  const actions = [];
  const nextSteps = [];
  if (platform === "win32") {
    actions.push(action("service", "manual", `Remove the scheduled task: schtasks /Delete /TN "${paths.label}" /F`));
    return { root: context.root, dryRun, actions, nextSteps, service: paths };
  }
  if (!existsSync(paths.file)) {
    actions.push(action("service", "kept", `${paths.file} does not exist; nothing to remove.`));
    return { root: context.root, dryRun, actions, nextSteps, service: paths };
  }
  if (dryRun) {
    actions.push(action("service", "planned", `remove ${paths.file}`));
  } else {
    // Unload first so the running loop stops; failures here only mean it was not loaded.
    try {
      if (platform === "darwin") execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${paths.label}`], { stdio: "ignore" });
      else execFileSync("systemctl", ["--user", "disable", "--now", paths.label], { stdio: "ignore" });
      actions.push(action("service", "ok", `${paths.label} stopped.`));
    } catch {
      actions.push(action("service", "ok", `${paths.label} was not running.`));
    }
    rmSync(paths.file, { force: true });
    actions.push(action("service", "created", `Removed ${paths.file}.`));
  }
  return { root: context.root, dryRun, actions, nextSteps, service: paths };
}

// For doctor: is the service file there, and (macOS/Linux) is it loaded?
export function meetingServiceStatus(projectId, environment = process.env, platform = process.platform) {
  const paths = servicePaths(projectId, environment, platform);
  if (!paths.file) return { ...paths, installed: null, loaded: null };
  const installed = existsSync(paths.file);
  let loaded = null;
  if (installed) {
    try {
      if (platform === "darwin") {
        execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${paths.label}`], { stdio: "ignore" });
        loaded = true;
      } else if (platform === "linux") {
        loaded = execFileSync("systemctl", ["--user", "is-active", paths.label], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "active";
      }
    } catch {
      loaded = false;
    }
  }
  return { ...paths, installed, loaded };
}
