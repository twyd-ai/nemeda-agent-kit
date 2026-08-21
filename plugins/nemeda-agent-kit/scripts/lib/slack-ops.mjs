// `nemeda-agent slack init | doctor | install` — the machine-local side of the
// Slack bridge. Create-if-absent only, like `setup`: existing files are
// reported and left untouched.

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "./env.mjs";
import {
  buildBackendCommand,
  buildRoutes,
  homeDirectory,
  loadRegistry,
  manifestPath,
  parseBackendOutput,
  registryPath,
  splitForSlack,
  stateDirectory,
  systemPrompt,
  toMrkdwn,
  withSlackDefaults
} from "./slack.mjs";
import { readWorkspaceContext } from "./workspace.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCH_AGENT_LABEL = "io.nemeda.agent-kit.slack";

const ENV_TEMPLATE = `# Slack bridge secrets for this machine. Never commit, never upload to Drive.
# Both tokens come from your own Slack app (one app per person).
# App-level token, "connections:write" scope, created under Basic Information:
SLACK_APP_TOKEN=
# Bot token from OAuth & Permissions, after installing the app:
SLACK_BOT_TOKEN=
`;

function action(kind, status, message) {
  return { kind, status, message };
}

export function initSlack(environment = process.env) {
  const home = homeDirectory(environment);
  const actions = [];
  mkdirSync(home, { recursive: true });
  mkdirSync(stateDirectory(environment), { recursive: true });

  const registry = registryPath(environment);
  if (existsSync(registry)) {
    actions.push(action("registry", "kept", `${registry} already exists.`));
  } else {
    writeFileSync(
      registry,
      `${JSON.stringify(
        // owner set here means no repository needs a slack section at all;
        // channels maps channel ids to project ids, also machine-locally.
        { owner: "", repos: [process.cwd()], channels: {} },
        null,
        2
      )}\n`
    );
    actions.push(action("registry", "created", `${registry} (listing ${process.cwd()}; fill owner with your Slack member ID).`));
  }

  const envPath = path.join(home, ".env.local");
  if (existsSync(envPath)) {
    actions.push(action("env", "kept", `${envPath} already exists.`));
  } else {
    writeFileSync(envPath, ENV_TEMPLATE, { mode: 0o600 });
    actions.push(action("env", "created", `${envPath} (fill SLACK_APP_TOKEN and SLACK_BOT_TOKEN).`));
  }

  return {
    home,
    actions,
    nextSteps: [
      `Create your own Slack app from ${manifestPath()} at https://api.slack.com/apps (From a manifest), replacing NAME with yours.`,
      "Enable Socket Mode, generate an app-level token with connections:write, then install the app to the workspace.",
      `Put both tokens in ${envPath}.`,
      "Set `owner` (your Slack member ID) and list your repositories in the registry; map channels there too if you want channel answers, DMs need nothing else.",
      "Run `nemeda-agent slack doctor`, then `nemeda-agent slack run`."
    ]
  };
}

function executableAvailable(name) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [name] : ["-v", name], {
      stdio: "ignore",
      shell: process.platform !== "win32"
    });
    return true;
  } catch {
    return false;
  }
}

async function slackApi(token, method, body = {}) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
  return response.json().catch(() => ({ ok: false, error: "invalid_json" }));
}

export async function slackDoctor(environment = process.env) {
  const checks = [];
  const home = homeDirectory(environment);
  const envPath = path.join(home, ".env.local");
  const scratch = { ...environment };
  if (existsSync(envPath)) loadEnvLocal(home, scratch);

  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    typeof WebSocket === "undefined"
      ? { status: "fail", code: "slack-node", message: `The runner needs Node 22 or newer for its built-in WebSocket; this is Node ${process.versions.node}.` }
      : { status: "pass", code: "slack-node", message: `Node ${major} provides the built-in WebSocket the runner needs.` }
  );

  const registry = loadRegistry(environment);
  if (registry.error) {
    checks.push({ status: "fail", code: "slack-registry", message: registry.error });
    return { checks };
  }
  checks.push({ status: "pass", code: "slack-registry", message: `${registry.path} lists ${registry.repos.length} repository path(s).` });

  const { routes, projects, issues } = buildRoutes(registry.repos, registry);
  for (const issue of issues) {
    checks.push({ status: issue.level === "error" ? "fail" : "warn", code: "slack-routes", message: issue.message });
  }
  if (projects.length === 0) {
    checks.push({ status: "fail", code: "slack-projects", message: "The registry routes no projects; list at least one configured repository, and set the registry owner (or a repo slack section)." });
  } else {
    checks.push({ status: "pass", code: "slack-projects", message: `${projects.length} project(s) answerable in DMs: ${projects.map((project) => project.projectId).join(", ")}.` });
  }
  checks.push(
    routes.size > 0
      ? { status: "pass", code: "slack-channels", message: `${routes.size} channel(s) routed: ${[...routes.keys()].join(", ")}.` }
      : { status: "warn", code: "slack-channels", message: "No channel is routed; the bridge will answer in DMs only. Map channels in the registry or a repo slack section." }
  );

  for (const project of projects) {
    const backend = project.slack.backend;
    checks.push({
      status: executableAvailable(backend) ? "pass" : "fail",
      code: `slack-backend-${project.projectId}`,
      message: executableAvailable(backend)
        ? `${project.projectId} answers with ${backend}, which is on PATH.`
        : `${project.projectId} is configured for ${backend}, which is not on PATH.`
    });
    if (project.slack.sourceRef) {
      let refKnown = false;
      try {
        execFileSync("git", ["rev-parse", "--verify", "--quiet", project.slack.sourceRef], { cwd: project.root, stdio: "ignore" });
        refKnown = true;
      } catch {
        refKnown = false;
      }
      checks.push({
        status: refKnown ? "pass" : "warn",
        code: `slack-ref-${project.projectId}`,
        message: refKnown
          ? `${project.projectId} answers from ${project.slack.sourceRef} through a mirror worktree.`
          : `${project.projectId} declares sourceRef ${project.slack.sourceRef}, which git cannot resolve; answers fall back to the working tree.`
      });
    }
  }

  if (!scratch.SLACK_APP_TOKEN || !scratch.SLACK_BOT_TOKEN) {
    checks.push({
      status: "fail",
      code: "slack-tokens",
      message: `SLACK_APP_TOKEN and SLACK_BOT_TOKEN must both be set in ${envPath}.`
    });
    return { checks };
  }
  checks.push({ status: "pass", code: "slack-tokens", message: `${envPath} provides both tokens.` });

  const identity = await slackApi(scratch.SLACK_BOT_TOKEN, "auth.test");
  if (!identity.ok) {
    checks.push({ status: "fail", code: "slack-auth", message: `auth.test failed: ${identity.error}.` });
    return { checks };
  }
  checks.push({ status: "pass", code: "slack-auth", message: `Bot token authenticates as ${identity.user} in ${identity.team}.` });

  const connection = await slackApi(scratch.SLACK_APP_TOKEN, "apps.connections.open");
  checks.push(
    connection.ok
      ? { status: "pass", code: "slack-socket", message: "App token can open a Socket Mode connection." }
      : { status: "fail", code: "slack-socket", message: `apps.connections.open failed: ${connection.error}. The app token needs connections:write and Socket Mode must be enabled.` }
  );

  for (const [channel, route] of routes) {
    const info = await slackApi(scratch.SLACK_BOT_TOKEN, "conversations.info", { channel });
    if (info.error === "missing_scope") {
      // conversations.info needs channels:read / groups:read, which the manifest
      // leaves out to keep the install minimal. The bridge works without them;
      // only this convenience check does not.
      checks.push({
        status: "warn",
        code: `slack-channel-${channel}`,
        message: `${channel} -> ${route.projectId}: cannot verify membership without the channels:read scope. Make sure you ran /invite @${identity.user} there.`
      });
    } else if (!info.ok) {
      checks.push({
        status: "fail",
        code: `slack-channel-${channel}`,
        message: `${channel} (${route.projectId}): ${info.error}. Invite the bot with /invite @${identity.user}.`
      });
    } else {
      checks.push({
        status: info.channel?.is_member ? "pass" : "fail",
        code: `slack-channel-${channel}`,
        message: info.channel?.is_member
          ? `#${info.channel.name} -> ${route.projectId}.`
          : `#${info.channel.name} is routed to ${route.projectId} but the bot is not a member; run /invite @${identity.user} there.`
      });
    }
  }
  return { checks };
}

export function installLaunchAgent(environment = process.env) {
  if (process.platform !== "darwin") {
    return { actions: [action("launchagent", "error", "Automatic start is only wired for macOS; run `nemeda-agent slack run` from a supervisor of your choice.")], nextSteps: [] };
  }
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  const logDirectory = stateDirectory(environment);
  mkdirSync(logDirectory, { recursive: true });
  if (existsSync(plistPath)) {
    return {
      actions: [action("launchagent", "kept", `${plistPath} already exists; delete it first if you want it regenerated.`)],
      nextSteps: [`launchctl kickstart -k gui/$(id -u)/${LAUNCH_AGENT_LABEL}`]
    };
  }
  const nodePath = process.execPath;
  const runnerPath = path.join(PLUGIN_ROOT, "scripts", "slack", "runner.mjs");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${runnerPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDirectory, "slack-runner.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDirectory, "slack-runner.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path.dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);
  return {
    actions: [action("launchagent", "created", plistPath)],
    nextSteps: [
      `launchctl bootstrap gui/$(id -u) ${plistPath}`,
      `Logs: ${path.join(logDirectory, "slack-runner.log")}`,
      `Stop it with: launchctl bootout gui/$(id -u)/${LAUNCH_AGENT_LABEL}`
    ]
  };
}

export function readManifest() {
  return readFileSync(manifestPath(), "utf8");
}

// `nemeda-agent slack ask` — runs the exact backend path the runner uses, in
// the current repository, and prints what Slack would render. Lets you tune the
// voice and check the read-only sandbox before creating any Slack app.
export async function askLocally(question, cwd = process.cwd()) {
  const context = readWorkspaceContext(cwd);
  if (context.mode !== "configured" || !context.config) {
    throw new Error(`No .nemeda/agent-kit.json found from ${cwd}.`);
  }
  const registry = loadRegistry();
  const slack = withSlackDefaults(context.config.slack || { channels: [], owner: registry.owner });
  const route = {
    root: context.root,
    projectId: context.config.project.id,
    projectName: context.config.project.name,
    slack,
    context
  };
  const { command, args } = buildBackendCommand(route, {
    question,
    cwd: context.root,
    sessionId: randomUUID(),
    resume: false,
    prompt: systemPrompt(route, { channelLabel: "#local-test", askedBy: "local" })
  });
  const started = Date.now();
  const child = spawnSync(command, args, { cwd: context.root, encoding: "utf8", env: { ...process.env, NEMEDA_SLACK_RUNNER: "1" } });
  if (child.error) throw new Error(`${command} could not be started: ${child.error.message}`);
  const { text: answer, error } = parseBackendOutput(slack.backend, child.stdout);
  if (!answer) {
    throw new Error(error || child.stderr.trim().split("\n").slice(-3).join(" ") || `${command} returned no answer.`);
  }
  return {
    project: route.projectId,
    backend: slack.backend,
    ms: Date.now() - started,
    messages: splitForSlack(toMrkdwn(answer), slack.maxAnswerChars)
  };
}
