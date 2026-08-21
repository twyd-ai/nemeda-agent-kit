#!/usr/bin/env node
// Slack Socket Mode runner.
//
// Socket Mode is what removes the infrastructure: the connection is outbound,
// so there is no server, no public URL, and no tunnel. One app per person means
// Slack delivers a mention only to that person's runner, and every answer is
// produced by that person's own agent subscription through the local CLI.
//
// Zero dependencies: Node 22 ships both `fetch` and a global `WebSocket`.

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { loadEnvLocal } from "../lib/env.mjs";
import {
  buildBackendCommand,
  buildRoutes,
  classifyEvent,
  isPurgeCommand,
  resolveDmRoute,
  sessionRetryMode,
  homeDirectory,
  loadRegistry,
  parseBackendOutput,
  rateLimit,
  readState,
  splitForSlack,
  stateDirectory,
  stripMentions,
  systemPrompt,
  threadSessionId,
  toMrkdwn,
  writeState
} from "../lib/slack.mjs";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const RECENT_EVENT_CAP = 500;

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

function audit(entry, environment) {
  try {
    mkdirSync(stateDirectory(environment), { recursive: true });
    appendFileSync(path.join(stateDirectory(environment), "slack-log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Auditing must never take the runner down.
  }
}

// --- Slack Web API --------------------------------------------------------

async function slackApi(token, method, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({ ok: false, error: "invalid_json" }));
  if (!payload.ok) throw new Error(`slack ${method}: ${payload.error}`);
  return payload;
}

function tryApi(token, method, body) {
  return slackApi(token, method, body).catch((error) => {
    log("warn", error.message);
    return null;
  });
}

// --- backend --------------------------------------------------------------

// When `sourceRef` is set the runner answers from a detached mirror worktree
// instead of the operator's working tree. That is what makes two people's
// runners interchangeable, and it keeps a dirty local checkout private.
function answerRoot(route, environment) {
  const ref = route.slack.sourceRef;
  if (!ref) return route.root;
  const worktree = path.join(homeDirectory(environment), "worktrees", route.projectId);
  try {
    execFileSync("git", ["fetch", "--quiet", "--all"], { cwd: route.root, stdio: "ignore", timeout: 60000 });
    if (!existsSync(worktree)) {
      mkdirSync(path.dirname(worktree), { recursive: true });
      execFileSync("git", ["worktree", "add", "--detach", worktree, ref], { cwd: route.root, stdio: "ignore", timeout: 120000 });
    } else {
      execFileSync("git", ["checkout", "--detach", ref], { cwd: worktree, stdio: "ignore", timeout: 120000 });
    }
    return worktree;
  } catch (error) {
    log("warn", `sourceRef ${ref} unavailable for ${route.projectId} (${error.message}); answering from the working tree.`);
    return route.root;
  }
}

function runBackend(route, options) {
  const { command, args } = buildBackendCommand(route, options);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, NEMEDA_SLACK_RUNNER: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), route.slack.timeoutSeconds * 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ text: "", error: `${command} could not be started: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const { text, error } = parseBackendOutput(route.slack.backend, stdout);
      if (text) {
        resolve({ text, error: null });
        return;
      }
      // stderr first: when the CLI dies before producing output, its own
      // message ("OAuth token expired", a crash) beats our generic one.
      const stderrTail = stderr.trim().split("\n").slice(-3).join(" ");
      const detail = stderrTail || error || `${command} exited with ${code}`;
      log("backend failure", `exit=${code}`, detail.slice(0, 500));
      resolve({ text: "", error: detail });
    });
  });
}

// --- runner ---------------------------------------------------------------

class Runner {
  constructor(environment = process.env) {
    this.environment = environment;
    this.recentEvents = new Set();
    this.knownThreads = new Set(readState("slack-threads.json", [], environment));
    this.dmProjects = readState("slack-dm.json", {}, environment);
    this.rates = readState("slack-rate.json", {}, environment);
    this.busy = new Set();
  }

  load() {
    loadEnvLocal(homeDirectory(this.environment), this.environment);
    this.botToken = this.environment.SLACK_BOT_TOKEN || "";
    this.appToken = this.environment.SLACK_APP_TOKEN || "";
    const registry = loadRegistry(this.environment);
    if (registry.error) throw new Error(registry.error);
    const { routes, projects, issues } = buildRoutes(registry.repos, registry);
    this.routes = routes;
    this.projects = projects;
    for (const issue of issues) log(issue.level === "error" ? "error" : "warn", issue.message);
    if (!this.botToken || !this.appToken) {
      throw new Error(`SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in ${path.join(homeDirectory(this.environment), ".env.local")}.`);
    }
    if (projects.length === 0) throw new Error("The registry routes no projects. List at least one configured repository in it.");
    if (routes.size === 0) log("warn", "no channels are routed; answering in DMs only.");
  }

  rememberThread(key) {
    this.knownThreads.add(key);
    if (this.knownThreads.size > 2000) {
      this.knownThreads = new Set([...this.knownThreads].slice(-1000));
    }
    writeState("slack-threads.json", [...this.knownThreads], this.environment);
  }

  // Slack retries anything not acked within three seconds, so the envelope is
  // acked first and the (slow) agent runs afterwards.
  async onEnvelope(socket, message) {
    if (message.envelope_id) socket.send(JSON.stringify({ envelope_id: message.envelope_id }));
    if (message.type !== "events_api") return;
    const event = message.payload?.event;
    const eventId = message.payload?.event_id;
    if (eventId) {
      if (this.recentEvents.has(eventId)) return;
      this.recentEvents.add(eventId);
      if (this.recentEvents.size > RECENT_EVENT_CAP) {
        this.recentEvents = new Set([...this.recentEvents].slice(-RECENT_EVENT_CAP / 2));
      }
    }
    if (event?.channel_type === "im") {
      await this.onDirectMessage(event);
      return;
    }
    const route = this.routes.get(event?.channel);
    const decision = classifyEvent({ event, botUserId: this.botUserId, route, knownThreads: this.knownThreads });
    if (decision.action === "ignore") return;

    if (decision.action === "unrouted") {
      await tryApi(this.botToken, "chat.postMessage", {
        channel: event.channel,
        thread_ts: decision.threadTs,
        text: this.projects.length
          ? `Este canal no está enrutado a ningún repo. Los que llevo son: ${this.projects.map((project) => project.projectName).join(", ")}.`
          : "Todavía no tengo ningún repo configurado."
      });
      return;
    }

    if (decision.action === "deny") {
      audit({ kind: "deny", channel: event.channel, user: event.user, project: route.projectId }, this.environment);
      if (route.slack.onUnauthorized === "ephemeral") {
        await tryApi(this.botToken, "chat.postEphemeral", {
          channel: event.channel,
          user: event.user,
          thread_ts: decision.threadTs,
          text: `Este bot es de <@${route.slack.owner}>. Menciona el tuyo y responderá con tu plan.`
        });
      }
      return;
    }

    if (decision.action === "answer" && isPurgeCommand(decision.question)) {
      if (event.user === route.slack.owner) await this.runPurge(event, decision.threadTs);
      return;
    }

    const busyKey = `${event.channel}:${decision.threadTs}`;
    if (this.busy.has(busyKey)) return;
    this.busy.add(busyKey);
    try {
      await this.answer(event, decision, route);
    } catch (error) {
      log("error", error.message);
    } finally {
      this.busy.delete(busyKey);
    }
  }

  isOwner(user) {
    return this.projects.some((project) => project.slack.owner === user);
  }

  // Deletes the bot's own messages in a DM (whole conversation) or a channel
  // thread. chat.delete only ever works on the bot's own messages, so the
  // blast radius is exactly "what the bot said"; the asker's messages stay.
  async purgeOwnMessages(event, threadTs) {
    const isDM = event.channel_type === "im";
    const mine = [];
    let cursor;
    do {
      const page = await tryApi(this.botToken, isDM ? "conversations.history" : "conversations.replies", {
        channel: event.channel,
        ...(isDM ? {} : { ts: threadTs }),
        limit: 200,
        ...(cursor ? { cursor } : {})
      });
      if (!page) break;
      for (const message of page.messages || []) {
        if (message.user === this.botUserId && message.ts !== threadTs) mine.push(message.ts);
      }
      cursor = page.response_metadata?.next_cursor;
    } while (cursor && mine.length < 300);
    let deleted = 0;
    for (const ts of mine) {
      // chat.delete is heavily rate limited; one per second keeps Slack happy.
      if (await tryApi(this.botToken, "chat.delete", { channel: event.channel, ts })) deleted += 1;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return deleted;
  }

  async runPurge(event, threadTs) {
    await tryApi(this.botToken, "reactions.add", { channel: event.channel, timestamp: event.ts, name: "eyes" });
    const deleted = await this.purgeOwnMessages(event, threadTs);
    await tryApi(this.botToken, "reactions.remove", { channel: event.channel, timestamp: event.ts, name: "eyes" });
    await tryApi(this.botToken, "reactions.add", { channel: event.channel, timestamp: event.ts, name: "white_check_mark" });
    audit({ kind: "purge", channel: event.channel, user: event.user, deleted }, this.environment);
    log(`purged ${deleted} own message(s) in ${event.channel}`);
  }

  isAllowed(route, user) {
    return [route.slack.owner, ...route.slack.guests].includes(user);
  }

  // DMs are the "just talk to it" surface: no mention needed, the whole DM is
  // one ongoing conversation per project, and the project is chosen by saying
  // it ("usa milence"), prefixing it ("milence: ..."), or having only one.
  async onDirectMessage(event) {
    if (event.bot_id || event.user === this.botUserId || event.subtype || !event.user || !stripMentions(event.text)) return;
    const say = (text) => tryApi(this.botToken, "chat.postMessage", { channel: event.channel, text });

    if (isPurgeCommand(stripMentions(event.text))) {
      if (this.isOwner(event.user)) await this.runPurge(event);
      else await say("Borrar mensajes solo puede pedirlo el dueño del bot.");
      return;
    }

    const resolution = resolveDmRoute({
      text: event.text,
      projects: this.projects,
      activeProjectId: this.dmProjects[event.channel]
    });
    const menu = this.projects.map((project) => `\`${project.projectId}\``).join(", ");

    if (resolution.kind === "unknown-project") {
      await say(`No llevo ningún proyecto llamado "${resolution.token}". Tengo: ${menu}.`);
      return;
    }
    if (resolution.kind === "choose") {
      await say(`¿Sobre qué proyecto? Tengo: ${menu}. Dime \`usa <proyecto>\` o empieza con \`<proyecto>: tu pregunta\`.`);
      return;
    }

    const route = resolution.route;
    if (!this.isAllowed(route, event.user)) {
      audit({ kind: "deny", channel: event.channel, user: event.user, project: route.projectId }, this.environment);
      if (route.slack.onUnauthorized === "ephemeral") {
        await say(`Este bot es de <@${route.slack.owner}>. Menciona el tuyo y responderá con tu plan.`);
      }
      return;
    }

    if (this.dmProjects[event.channel] !== route.projectId) {
      this.dmProjects[event.channel] = route.projectId;
      writeState("slack-dm.json", this.dmProjects, this.environment);
    }
    if (resolution.kind === "switch") {
      await say(`Hecho, ahora hablamos de *${route.projectName}*.`);
      return;
    }

    const busyKey = `${event.channel}:${event.ts}`;
    if (this.busy.has(busyKey)) return;
    this.busy.add(busyKey);
    try {
      await this.answer(event, { question: resolution.question, isDirectMessage: true }, route);
    } catch (error) {
      log("error", error.message);
    } finally {
      this.busy.delete(busyKey);
    }
  }

  async answer(event, decision, route) {
    const limit = rateLimit(this.rates, `${route.projectId}:${event.user}`, route.slack.maxQuestionsPerHour, Date.now());
    this.rates = limit.state;
    writeState("slack-rate.json", this.rates, this.environment);
    if (!limit.allowed) {
      await tryApi(this.botToken, "chat.postMessage", {
        channel: event.channel,
        ...(decision.isDirectMessage ? {} : { thread_ts: decision.threadTs }),
        text: `He llegado al límite de ${route.slack.maxQuestionsPerHour} preguntas por hora. Vuelve a intentarlo en ${limit.retryAfterMinutes} min.`
      });
      return;
    }

    const started = Date.now();
    await tryApi(this.botToken, "reactions.add", { channel: event.channel, timestamp: event.ts, name: "eyes" });

    // In a DM the whole conversation is the session (scoped per project); in a
    // channel each thread is. Both resume across runner restarts.
    const sessionScope = decision.isDirectMessage ? `dm:${route.projectId}` : decision.threadTs;
    const sessionId = threadSessionId(this.teamId, event.channel, sessionScope);
    const threadKey = `${event.channel}:${sessionScope}`;
    const cwd = answerRoot(route, this.environment);
    const prompt = systemPrompt(route, { channelLabel: event.channel, askedBy: event.user });
    const resume = this.knownThreads.has(threadKey);
    let result = await runBackend(route, { question: decision.question, cwd, sessionId, resume, prompt });
    const retryMode = result.error ? sessionRetryMode(result.error, resume) : null;
    if (retryMode) {
      log(`session state mismatch for ${threadKey}; retrying as ${retryMode}`);
      result = await runBackend(route, { question: decision.question, cwd, sessionId, resume: retryMode === "resume", prompt });
    }

    const chunks = result.text ? splitForSlack(toMrkdwn(result.text), route.slack.maxAnswerChars) : [];
    if (chunks.length === 0) {
      await tryApi(this.botToken, "chat.postMessage", {
        channel: event.channel,
        ...(decision.isDirectMessage ? {} : { thread_ts: decision.threadTs }),
        text: `No he podido responder: ${result.error || "sin respuesta"}.`
      });
    } else {
      for (const chunk of chunks) {
        await tryApi(this.botToken, "chat.postMessage", {
          channel: event.channel,
          ...(decision.isDirectMessage ? {} : { thread_ts: decision.threadTs }),
          text: chunk,
          unfurl_links: false,
          unfurl_media: false
        });
      }
      this.rememberThread(threadKey);
    }
    await tryApi(this.botToken, "reactions.remove", { channel: event.channel, timestamp: event.ts, name: "eyes" });
    audit(
      {
        kind: "answer",
        channel: event.channel,
        user: event.user,
        project: route.projectId,
        backend: route.slack.backend,
        ms: Date.now() - started,
        chars: result.text.length,
        error: result.error || null
      },
      this.environment
    );
    log(`answered ${route.projectId} in ${event.channel} (${Date.now() - started}ms, ${result.text.length} chars)`);
  }

  async connectOnce() {
    const opened = await slackApi(this.appToken, "apps.connections.open", {});
    return new Promise((resolve) => {
      const socket = new WebSocket(opened.url);
      let settled = false;
      const done = (reason) => {
        if (settled) return;
        settled = true;
        resolve(reason);
      };
      socket.addEventListener("open", () => log("socket connected"));
      socket.addEventListener("message", (message) => {
        let parsed;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }
        if (parsed.type === "hello") {
          log(`ready as ${this.botName} for ${this.routes.size} channel(s)`);
          return;
        }
        if (parsed.type === "disconnect") {
          log(`slack asked to reconnect (${parsed.reason})`);
          try {
            socket.close();
          } catch {
            // already closing
          }
          done("disconnect");
          return;
        }
        this.onEnvelope(socket, parsed).catch((error) => log("error", error.message));
      });
      socket.addEventListener("error", () => done("error"));
      socket.addEventListener("close", () => done("close"));
    });
  }

  async start() {
    // The rest of the CLI runs on Node 20; only the runner needs the global
    // WebSocket, so the requirement is enforced here rather than in engines.
    if (typeof WebSocket === "undefined") {
      throw new Error(`The Slack runner needs Node 22 or newer for its built-in WebSocket; this is Node ${process.versions.node}.`);
    }
    this.load();
    const identity = await slackApi(this.botToken, "auth.test", {});
    this.botUserId = identity.user_id;
    this.botName = identity.user;
    this.teamId = identity.team_id;
    log(`registry: ${this.projects.map((project) => `${project.projectId} -> ${project.slack.channels.join(",")}`).join(" | ")}`);
    let backoff = RECONNECT_BASE_MS;
    for (;;) {
      try {
        const reason = await this.connectOnce();
        backoff = reason === "disconnect" ? RECONNECT_BASE_MS : Math.min(backoff * 2, RECONNECT_MAX_MS);
      } catch (error) {
        log("error", error.message);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

export async function runSlackRunner(environment = process.env) {
  const runner = new Runner(environment);
  await runner.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSlackRunner().catch((error) => {
    console.error(`nemeda-agent slack: ${error.message}`);
    process.exit(1);
  });
}
