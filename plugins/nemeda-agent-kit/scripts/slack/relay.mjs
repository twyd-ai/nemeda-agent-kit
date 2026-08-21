#!/usr/bin/env node
// The Slack relay: ONE Slack app for the whole team, hosted anywhere, doing no
// AI work. It pairs Slack users to their own laptops (identity proven by
// DMing a code to the bot — Slack itself vouches for the sender), then routes
// each question to the asker's runner over an SSE stream the laptop opened
// outbound. Answers come back as whitelisted Slack Web API calls. The relay
// never sees a repository, a Claude credential, or a stored conversation.
//
// State on disk: pairings only (token hashes, no content), in
// $NEMEDA_RELAY_HOME/pairings.json. Slack tokens live in
// $NEMEDA_RELAY_HOME/.env.local or the process environment.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvLocal } from "../lib/env.mjs";
import {
  ALLOWED_SLACK_METHODS,
  PAIRING_TTL_MS,
  RELAY_VERSION,
  decideRelayRoute,
  generatePairingCode,
  generateRunnerToken,
  hashToken,
  isUnlinkCommand,
  parsePairingText
} from "../lib/relay-protocol.mjs";

const POLL_TIMEOUT_MS = 25000;
const ONLINE_WINDOW_MS = 70000;
const MAX_QUEUE = 20;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

export function relayHome(environment = process.env) {
  return environment.NEMEDA_RELAY_HOME || path.join(os.homedir(), ".nemeda", "relay");
}

async function slackApi(token, method, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({ ok: false, error: "invalid_json" }));
  return payload;
}

function readBody(request, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

class Relay {
  constructor(environment = process.env) {
    this.environment = environment;
    this.home = relayHome(environment);
    this.pairingsPath = path.join(this.home, "pairings.json");
    this.pairings = new Map(); // userId -> { tokenHash, name, pairedAt }
    this.pending = new Map(); // code -> { name, createdAt, result }
    this.runners = new Map(); // userId -> { queue, waiter, timer, guests, projects, lastSeen }
    this.recentEvents = new Set();
  }

  loadState() {
    mkdirSync(this.home, { recursive: true });
    if (existsSync(this.pairingsPath)) {
      try {
        for (const [userId, record] of Object.entries(JSON.parse(readFileSync(this.pairingsPath, "utf8")))) {
          this.pairings.set(userId, record);
        }
      } catch (error) {
        log("warn", `could not read ${this.pairingsPath}: ${error.message}`);
      }
    }
  }

  saveState() {
    // Only token hashes live here, never a usable credential, but the file
    // still maps Slack users to machines: keep it owner-only.
    writeFileSync(this.pairingsPath, JSON.stringify(Object.fromEntries(this.pairings), null, 2), { mode: 0o600 });
  }

  authenticate(request) {
    const header = String(request.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return null;
    const tokenHash = hashToken(header.slice(7));
    for (const [userId, record] of this.pairings) {
      if (record.tokenHash === tokenHash) return userId;
    }
    return null;
  }

  sweepPending() {
    const now = Date.now();
    for (const [code, entry] of this.pending) {
      if (now - entry.createdAt > PAIRING_TTL_MS) this.pending.delete(code);
    }
  }

  // --- HTTP: pairing + runner transport -----------------------------------

  async handleHttp(request, response) {
    const url = new URL(request.url, "http://relay");
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, { ok: true, relayVersion: RELAY_VERSION, connected: this.onlineRunners().size });
        return;
      }
      if (request.method === "POST" && url.pathname === "/pair/start") {
        this.sweepPending();
        if (this.pending.size >= 20) {
          json(response, 429, { error: "too many pending pairings" });
          return;
        }
        const body = JSON.parse((await readBody(request)) || "{}");
        const code = generatePairingCode();
        this.pending.set(code, { name: String(body.name || "runner").slice(0, 60), createdAt: Date.now(), result: null });
        log(`pairing code issued: ${code}`);
        json(response, 200, { code, expiresInSeconds: PAIRING_TTL_MS / 1000, hint: `Envía por DM al bot: vincular ${code}` });
        return;
      }
      if (request.method === "GET" && url.pathname === "/pair/wait") {
        const entry = this.pending.get(String(url.searchParams.get("code") || "").toUpperCase());
        if (!entry) {
          json(response, 410, { error: "unknown or expired code" });
          return;
        }
        if (entry.result) {
          this.pending.delete(String(url.searchParams.get("code")).toUpperCase());
          json(response, 200, entry.result);
          return;
        }
        json(response, 204, {});
        return;
      }
      if (
        url.pathname === "/runner/poll" ||
        url.pathname === "/runner/slack" ||
        url.pathname === "/runner/register" ||
        url.pathname === "/runner/whoami"
      ) {
        const userId = this.authenticate(request);
        if (!userId) {
          json(response, 401, { error: "invalid runner token" });
          return;
        }
        // Read-only identity check, so `slack doctor` can verify a token
        // without clobbering the live runner's registered guests and projects.
        if (request.method === "GET" && url.pathname === "/runner/whoami") {
          const record = this.runners.get(userId);
          json(response, 200, {
            ok: true,
            userId,
            botName: this.botName,
            botUserId: this.botUserId,
            teamId: this.teamId,
            online: this.isOnline(userId),
            projects: record?.projects || [],
            relayVersion: RELAY_VERSION
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/runner/poll") {
          this.handlePoll(userId, response);
          return;
        }
        if (request.method === "POST" && url.pathname === "/runner/register") {
          const body = JSON.parse((await readBody(request)) || "{}");
          const record = this.runnerRecord(userId);
          const wasOffline = !this.isOnline(userId);
          record.lastSeen = Date.now();
          if (wasOffline) log(`runner online: ${userId} (${this.onlineRunners().size} online)`);
          record.guests = Array.isArray(body.guests) ? body.guests.slice(0, 50).map(String) : [];
          record.projects = Array.isArray(body.projects) ? body.projects.slice(0, 50) : [];
          json(response, 200, {
            ok: true,
            botUserId: this.botUserId,
            botName: this.botName,
            teamId: this.teamId,
            userId,
            relayVersion: RELAY_VERSION
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/runner/slack") {
          const body = JSON.parse((await readBody(request)) || "{}");
          if (!ALLOWED_SLACK_METHODS.has(body.method)) {
            json(response, 403, { ok: false, error: `method not allowed: ${body.method}` });
            return;
          }
          const payload = await slackApi(this.botToken, body.method, body.body || {});
          json(response, 200, payload);
          return;
        }
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  }

  // Long polling instead of SSE. A completed HTTP response is never buffered
  // by a CDN, so events arrive instantly through Cloudflare, Azure, or any
  // corporate proxy; an open stream is at the mercy of each hop's flush
  // heuristics. Cost is one extra round trip per event, which is nothing next
  // to the seconds an agent takes to answer.
  runnerRecord(userId) {
    let record = this.runners.get(userId);
    if (!record) {
      record = { queue: [], waiter: null, timer: null, guests: [], projects: [], lastSeen: 0 };
      this.runners.set(userId, record);
    }
    return record;
  }

  isOnline(userId) {
    const record = this.runners.get(userId);
    return Boolean(record) && Date.now() - record.lastSeen < ONLINE_WINDOW_MS;
  }

  onlineRunners() {
    const online = new Map();
    for (const [userId, record] of this.runners) {
      if (this.isOnline(userId)) online.set(userId, record);
    }
    return online;
  }

  flush(record, events) {
    const waiter = record.waiter;
    record.waiter = null;
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    if (!waiter) return;
    try {
      json(waiter, 200, { events });
    } catch {
      // client vanished mid-write; the events stay queued for the next poll
    }
  }

  handlePoll(userId, response) {
    const record = this.runnerRecord(userId);
    const wasOffline = !this.isOnline(userId);
    record.lastSeen = Date.now();
    if (wasOffline) log(`runner online: ${userId} (${this.onlineRunners().size} online)`);
    // A second poll from the same runner replaces the first; never hold two.
    if (record.waiter) this.flush(record, []);
    if (record.queue.length) {
      const events = record.queue.splice(0, record.queue.length);
      json(response, 200, { events });
      return;
    }
    record.waiter = response;
    record.timer = setTimeout(() => this.flush(record, []), POLL_TIMEOUT_MS);
    response.on("close", () => {
      if (record.waiter === response) {
        record.waiter = null;
        if (record.timer) {
          clearTimeout(record.timer);
          record.timer = null;
        }
      }
    });
  }

  sendTo(userId, message) {
    if (!this.isOnline(userId)) return false;
    const record = this.runnerRecord(userId);
    record.queue.push(message);
    // A runner that stopped polling must not accumulate a backlog to replay.
    if (record.queue.length > MAX_QUEUE) record.queue.splice(0, record.queue.length - MAX_QUEUE);
    if (record.waiter) this.flush(record, record.queue.splice(0, record.queue.length));
    return true;
  }

  // --- Slack side ----------------------------------------------------------

  async completePairing(event, code) {
    this.sweepPending();
    const entry = this.pending.get(code);
    const reply = (text) => slackApi(this.botToken, "chat.postMessage", { channel: event.channel, text });
    if (!entry) {
      await reply("Ese código no existe o ha caducado. Genera otro con `nemeda-agent slack join <url>`.");
      return;
    }
    const token = generateRunnerToken();
    this.pairings.set(event.user, { tokenHash: hashToken(token), name: entry.name, pairedAt: new Date().toISOString() });
    this.saveState();
    const profile = await slackApi(this.botToken, "users.info", { user: event.user });
    entry.result = {
      token,
      userId: event.user,
      userName: profile.ok ? profile.user.real_name || profile.user.name : event.user,
      botUserId: this.botUserId,
      teamId: this.teamId
    };
    log(`paired ${event.user} (${entry.name})`);
    await reply(`Vinculado ✅ — tu agente (*${entry.name}*) responderá tus preguntas en cuanto esté en marcha.`);
  }

  async onSlackEvent(event) {
    if (event?.channel_type === "im" && event.user && !event.bot_id && !event.subtype) {
      const code = parsePairingText(event.text);
      if (code) {
        await this.completePairing(event, code);
        return;
      }
      if (isUnlinkCommand(event.text)) {
        const had = this.pairings.delete(event.user);
        this.saveState();
        const record = this.runners.get(event.user);
        if (record) {
          this.flush(record, [{ type: "unlinked" }]);
          this.runners.delete(event.user);
        }
        await slackApi(this.botToken, "chat.postMessage", {
          channel: event.channel,
          text: had ? "Desvinculado. Tu agente ya no puede conectarse con el token anterior." : "No tenías ningún agente vinculado."
        });
        return;
      }
    }

    const decision = decideRelayRoute({
      event,
      botUserId: this.botUserId,
      pairedUsers: new Set(this.pairings.keys()),
      connections: this.onlineRunners()
    });
    if (decision.action === "ignore") return;

    if (decision.action === "forward") {
      if (!this.sendTo(decision.target, { type: "slack_event", event })) {
        // The stream died between the check and the write; treat as offline.
        await this.replyDirectly(event, "Tu agente se acaba de desconectar. Arráncalo y vuelve a preguntar.");
      }
      return;
    }
    if (decision.action === "offline") {
      await this.replyDirectly(event, "Tu agente no está conectado ahora mismo. Arranca `nemeda-agent slack run` en tu máquina y vuelve a preguntar.");
      return;
    }
    if (decision.action === "instructions") {
      await this.replyDirectly(
        event,
        "No tienes ningún agente vinculado. En tu máquina: `nemeda-agent slack join <url-del-relay>` y mándame por DM el código que te dé. Si no tienes el kit instalado, pide a tu equipo la guía de instalación."
      );
    }
  }

  replyDirectly(event, text) {
    const body = { channel: event.channel, text };
    if (event.channel_type !== "im") body.thread_ts = event.thread_ts || event.ts;
    return slackApi(this.botToken, "chat.postMessage", body);
  }

  async onEnvelope(socket, message) {
    if (message.envelope_id) socket.send(JSON.stringify({ envelope_id: message.envelope_id }));
    if (message.type !== "events_api") return;
    const eventId = message.payload?.event_id;
    if (eventId) {
      if (this.recentEvents.has(eventId)) return;
      this.recentEvents.add(eventId);
      if (this.recentEvents.size > 500) this.recentEvents = new Set([...this.recentEvents].slice(-250));
    }
    await this.onSlackEvent(message.payload?.event || {});
  }

  async connectOnce() {
    const opened = await slackApi(this.appToken, "apps.connections.open", {});
    if (!opened.ok) throw new Error(`apps.connections.open: ${opened.error}`);
    return new Promise((resolve) => {
      const socket = new WebSocket(opened.url);
      let settled = false;
      const done = (reason) => {
        if (!settled) {
          settled = true;
          resolve(reason);
        }
      };
      socket.addEventListener("message", (message) => {
        let parsed;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }
        if (parsed.type === "disconnect") {
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
      socket.addEventListener("open", () => log("slack socket connected"));
      socket.addEventListener("error", () => done("error"));
      socket.addEventListener("close", () => done("close"));
    });
  }

  async start(port) {
    this.loadState();
    loadEnvLocal(this.home, this.environment);
    this.botToken = this.environment.SLACK_BOT_TOKEN || "";
    this.appToken = this.environment.SLACK_APP_TOKEN || "";
    if (!this.botToken || !this.appToken) {
      throw new Error(`SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in ${path.join(this.home, ".env.local")} or the environment.`);
    }
    const identity = await slackApi(this.botToken, "auth.test", {});
    if (!identity.ok) throw new Error(`auth.test: ${identity.error}`);
    this.botUserId = identity.user_id;
    this.botName = identity.user;
    this.teamId = identity.team_id;

    const server = createServer((request, response) => {
      this.handleHttp(request, response).catch((error) => json(response, 500, { error: error.message }));
    });
    server.listen(port, () => log(`relay listening on :${port} as ${this.botName} (${this.pairings.size} paired)`));

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

export async function runRelay(environment = process.env) {
  // PORT is what App Service, Container Apps, Fly, and Railway all inject.
  const port = Number(environment.RELAY_PORT || environment.PORT || 8787);
  await new Relay(environment).start(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRelay().catch((error) => {
    console.error(`nemeda-agent slack relay: ${error.message}`);
    process.exit(1);
  });
}
