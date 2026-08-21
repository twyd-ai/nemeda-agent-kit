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
import { resolveActiveServer } from "../lib/slack-servers.mjs";
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

// Relay-mode Slack access: the laptop holds no Slack tokens, so every Web API
// call travels to the relay, which enforces a method whitelist.
async function relayApi(relayUrl, relayToken, method, body) {
  const response = await fetch(`${relayUrl}/runner/slack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${relayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ method, body })
  });
  const payload = await response.json().catch(() => ({ ok: false, error: "invalid_json" }));
  if (!payload.ok) throw new Error(`relay slack ${method}: ${payload.error}`);
  return payload;
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
  constructor(environment = process.env, serverName = "") {
    this.environment = environment;
    this.serverName = serverName;
    this.recentEvents = new Set();
    this.knownThreads = new Set();
    this.dmProjects = {};
    this.busy = new Set();
  }

  call(method, body) {
    return this.relayMode ? relayApi(this.relayUrl, this.relayToken, method, body) : slackApi(this.botToken, method, body);
  }

  try(method, body) {
    return this.call(method, body).catch((error) => {
      log("warn", error.message);
      return null;
    });
  }

  load() {
    loadEnvLocal(homeDirectory(this.environment), this.environment);
    this.botToken = this.environment.SLACK_BOT_TOKEN || "";
    this.appToken = this.environment.SLACK_APP_TOKEN || "";
    const server = resolveActiveServer(this.environment, this.serverName);
    this.relayUrl = server?.url || "";
    this.relayToken = server?.token || "";
    this.relayName = server?.name || "";
    this.relayMode = Boolean(this.relayUrl && this.relayToken);
    const registry = loadRegistry(this.environment);
    if (registry.error) throw new Error(registry.error);
    this.registry = registry;
    this.rebuildRoutes(registry);
    if (!this.relayMode && (!this.botToken || !this.appToken)) {
      throw new Error(
        `Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in ${path.join(homeDirectory(this.environment), ".env.local")}, or join a relay with \`nemeda-agent slack join <url>\`.`
      );
    }
    // In relay mode the paired Slack identity arrives with the hello, so an
    // empty registry owner is not fatal yet: `slack join` alone must be enough
    // to onboard someone.
    if (this.projects.length === 0 && !this.relayMode) {
      throw new Error("The registry routes no projects. List at least one configured repository in it.");
    }
    if (this.routes.size === 0 && !this.relayMode) log("warn", "no channels are routed; answering in DMs only.");
    this.loadState();
  }

  // Two runners on one machine (production and development) must not share
  // bookkeeping, so relay-mode state is namespaced by profile.
  stateFile(base) {
    return this.relayMode && this.relayName ? `slack-${this.relayName}-${base}.json` : `slack-${base}.json`;
  }

  loadState() {
    this.knownThreads = new Set(readState(this.stateFile("threads"), [], this.environment));
    this.dmProjects = readState(this.stateFile("dm"), {}, this.environment);
    this.rates = readState(this.stateFile("rate"), {}, this.environment);
  }

  rebuildRoutes(registry) {
    const { routes, projects, issues } = buildRoutes(registry.repos, registry);
    this.routes = routes;
    this.projects = projects;
    for (const issue of issues) log(issue.level === "error" ? "error" : "warn", issue.message);
  }

  // The relay vouches for who this runner belongs to, so that identity becomes
  // the owner unless the registry already named one.
  applyRelayIdentity(userId) {
    if (!userId) return;
    this.userId = userId;
    this.rebuildRoutes({ ...this.registry, owner: this.registry.owner || userId });
    if (this.projects.length === 0) {
      log("error", "no projects: add repository paths to ~/.nemeda/runner.json");
    }
  }

  rememberThread(key) {
    this.knownThreads.add(key);
    if (this.knownThreads.size > 2000) {
      this.knownThreads = new Set([...this.knownThreads].slice(-1000));
    }
    writeState(this.stateFile("threads"), [...this.knownThreads], this.environment);
  }

  // Slack retries anything not acked within three seconds, so the envelope is
  // acked first and the (slow) agent runs afterwards.
  async onEnvelope(socket, message) {
    if (message.envelope_id) socket.send(JSON.stringify({ envelope_id: message.envelope_id }));
    if (message.type !== "events_api") return;
    const eventId = message.payload?.event_id;
    if (eventId) {
      if (this.recentEvents.has(eventId)) return;
      this.recentEvents.add(eventId);
      if (this.recentEvents.size > RECENT_EVENT_CAP) {
        this.recentEvents = new Set([...this.recentEvents].slice(-RECENT_EVENT_CAP / 2));
      }
    }
    await this.handleEvent(message.payload?.event);
  }

  async handleEvent(event) {
    if (event?.channel_type === "im") {
      await this.onDirectMessage(event);
      return;
    }
    const route = this.routes.get(event?.channel);
    const decision = classifyEvent({ event, botUserId: this.botUserId, route, knownThreads: this.knownThreads });
    if (decision.action === "ignore") return;

    if (decision.action === "unrouted") {
      await this.try("chat.postMessage", {
        channel: event.channel,
        thread_ts: decision.threadTs,
        text: this.projects.length
          ? `This channel is not routed to a repository. I cover: ${this.projects.map((project) => project.projectName).join(", ")}.`
          : "No repositories are configured yet."
      });
      return;
    }

    if (decision.action === "deny") {
      audit({ kind: "deny", channel: event.channel, user: event.user, project: route.projectId }, this.environment);
      if (route.slack.onUnauthorized === "ephemeral") {
        await this.try("chat.postEphemeral", {
          channel: event.channel,
          user: event.user,
          thread_ts: decision.threadTs,
          text: `This agent belongs to <@${route.slack.owner}>. Mention your own and it will answer on your plan.`
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
      const page = await this.try(isDM ? "conversations.history" : "conversations.replies", {
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
      if (await this.try("chat.delete", { channel: event.channel, ts })) deleted += 1;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return deleted;
  }

  async runPurge(event, threadTs) {
    await this.try("reactions.add", { channel: event.channel, timestamp: event.ts, name: "eyes" });
    const deleted = await this.purgeOwnMessages(event, threadTs);
    await this.try("reactions.remove", { channel: event.channel, timestamp: event.ts, name: "eyes" });
    await this.try("reactions.add", { channel: event.channel, timestamp: event.ts, name: "white_check_mark" });
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
    const say = (text) => this.try("chat.postMessage", { channel: event.channel, text });

    if (isPurgeCommand(stripMentions(event.text))) {
      if (this.isOwner(event.user)) await this.runPurge(event);
      else await say("Only the owner of this agent can ask it to delete messages.");
      return;
    }

    const resolution = resolveDmRoute({
      text: event.text,
      projects: this.projects,
      activeProjectId: this.dmProjects[event.channel]
    });
    const menu = this.projects.map((project) => `\`${project.projectId}\``).join(", ");

    if (resolution.kind === "unknown-project") {
      await say(`I do not cover a project called "${resolution.token}". I have: ${menu}.`);
      return;
    }
    if (resolution.kind === "choose") {
      await say(`Which project? I have: ${menu}. Say \`use <project>\` or start with \`<project>: your question\`.`);
      return;
    }

    const route = resolution.route;
    if (!this.isAllowed(route, event.user)) {
      audit({ kind: "deny", channel: event.channel, user: event.user, project: route.projectId }, this.environment);
      if (route.slack.onUnauthorized === "ephemeral") {
        await say(`This agent belongs to <@${route.slack.owner}>. Mention your own and it will answer on your plan.`);
      }
      return;
    }

    if (this.dmProjects[event.channel] !== route.projectId) {
      this.dmProjects[event.channel] = route.projectId;
      writeState(this.stateFile("dm"), this.dmProjects, this.environment);
    }
    if (resolution.kind === "switch") {
      await say(`Done — now we are talking about *${route.projectName}*.`);
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
    writeState(this.stateFile("rate"), this.rates, this.environment);
    if (!limit.allowed) {
      await this.try("chat.postMessage", {
        channel: event.channel,
        ...(decision.isDirectMessage ? {} : { thread_ts: decision.threadTs }),
        text: `That is my limit of ${route.slack.maxQuestionsPerHour} questions an hour. Try again in ${limit.retryAfterMinutes} min.`
      });
      return;
    }

    const started = Date.now();
    await this.try("reactions.add", { channel: event.channel, timestamp: event.ts, name: "eyes" });

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
      await this.try("chat.postMessage", {
        channel: event.channel,
        ...(decision.isDirectMessage ? {} : { thread_ts: decision.threadTs }),
        text: `I could not answer: ${result.error || "no response"}.`
      });
    } else {
      for (const chunk of chunks) {
        await this.try("chat.postMessage", {
          channel: event.channel,
          ...(decision.isDirectMessage ? {} : { thread_ts: decision.threadTs }),
          text: chunk,
          unfurl_links: false,
          unfurl_media: false
        });
      }
      this.rememberThread(threadKey);
    }
    await this.try("reactions.remove", { channel: event.channel, timestamp: event.ts, name: "eyes" });
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

  // Long polling: each request returns a complete HTTP response, which no CDN
  // or corporate proxy buffers. An open stream would be at the mercy of every
  // hop's flush heuristics — measured at 19s of delay through a Cloudflare
  // tunnel, which is unusable for a chat bot.
  async relayRegister() {
    const response = await fetch(`${this.relayUrl}/runner/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.relayToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        guests: [...new Set(this.projects.flatMap((project) => project.slack.guests))],
        projects: this.projects.map((project) => ({ id: project.projectId, name: project.projectName }))
      })
    });
    if (response.status === 401) throw new Error("the relay rejected the runner token; run `nemeda-agent slack join <url>` again.");
    if (!response.ok) throw new Error(`relay register failed: HTTP ${response.status}`);
    const identity = await response.json();
    this.botUserId = identity.botUserId;
    this.botName = identity.botName;
    this.teamId = identity.teamId;
    this.applyRelayIdentity(identity.userId);
    return identity;
  }

  async relayPollOnce() {
    const response = await fetch(`${this.relayUrl}/runner/poll`, {
      headers: { Authorization: `Bearer ${this.relayToken}` }
    });
    if (response.status === 401) throw new Error("the relay rejected the runner token; run `nemeda-agent slack join <url>` again.");
    if (!response.ok) throw new Error(`relay poll failed: HTTP ${response.status}`);
    const payload = await response.json();
    for (const message of payload.events || []) {
      if (message.type === "unlinked") {
        log("this runner was unlinked from the relay; stopping.");
        process.exit(0);
      }
      if (message.type === "slack_event") {
        // Deliberately not awaited: a slow answer must not stall the next poll.
        this.handleEvent(message.event).catch((error) => log("error", error.message));
      }
    }
  }

  async start() {
    this.load();
    if (this.relayMode) {
      log(`relay mode: ${this.relayName} -> ${this.relayUrl}`);
      let backoff = RECONNECT_BASE_MS;
      let registered = false;
      for (;;) {
        try {
          if (!registered) {
            await this.relayRegister();
            registered = true;
            log(`ready via relay as ${this.botName} for ${this.projects.length} project(s)`);
          }
          await this.relayPollOnce();
          backoff = RECONNECT_BASE_MS;
          continue;
        } catch (error) {
          log("error", error.message);
          // Re-register on the way back: the relay may have restarted and
          // forgotten this runner's guests and projects.
          registered = false;
          backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    // The rest of the CLI runs on Node 20; only the direct runner needs the
    // global WebSocket, so the requirement is enforced here rather than in
    // engines.
    if (typeof WebSocket === "undefined") {
      throw new Error(`The Slack runner needs Node 22 or newer for its built-in WebSocket; this is Node ${process.versions.node}.`);
    }
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

export async function runSlackRunner(environment = process.env, serverName = "") {
  const runner = new Runner(environment, serverName);
  await runner.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSlackRunner().catch((error) => {
    console.error(`nemeda-agent slack: ${error.message}`);
    process.exit(1);
  });
}
