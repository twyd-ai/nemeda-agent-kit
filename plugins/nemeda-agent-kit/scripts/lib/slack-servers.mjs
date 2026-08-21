// Named relay profiles, so one machine can move between a production relay and
// a local one without re-pairing or hand-editing env files.
//
// Switching which relay YOUR runner talks to is safe for everyone else. What is
// not safe is pointing a second relay at the same Slack app: both would hold a
// Socket Mode connection and Slack would split events between them. A dev relay
// needs its own Slack app.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvLocal } from "./env.mjs";
import { homeDirectory } from "./slack.mjs";

export const SERVERS_FILE = "servers.json";

export function serversPath(environment = process.env) {
  return path.join(homeDirectory(environment), SERVERS_FILE);
}

// The relay pair may live in ~/.nemeda/.env.local rather than the shell, and
// the management commands do not otherwise read it. Merging here keeps
// migrateFromEnv itself pure and testable.
export function effectiveEnvironment(environment = process.env) {
  const scratch = { ...environment };
  loadEnvLocal(homeDirectory(environment), scratch);
  return scratch;
}

function empty() {
  return { active: "", servers: {} };
}

export function loadServers(environment = process.env) {
  const file = serversPath(environment);
  if (!existsSync(file)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      active: typeof parsed.active === "string" ? parsed.active : "",
      servers: parsed.servers && typeof parsed.servers === "object" ? parsed.servers : {}
    };
  } catch {
    return empty();
  }
}

export function saveServers(value, environment = process.env) {
  const home = homeDirectory(environment);
  mkdirSync(home, { recursive: true });
  // Runner tokens live here, so this file is a credential store.
  writeFileSync(serversPath(environment), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function normalizeUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

export function upsertServer(state, name, entry) {
  return {
    active: name,
    servers: { ...state.servers, [name]: { ...state.servers[name], ...entry } }
  };
}

export function removeServer(state, name) {
  const servers = { ...state.servers };
  delete servers[name];
  return { active: state.active === name ? "" : state.active, servers };
}

// A pre-profiles setup keeps working: the env pair is adopted as a profile the
// first time servers are touched, so it shows up in the list like any other.
export function migrateFromEnv(state, environment = process.env) {
  const url = normalizeUrl(environment.NEMEDA_RELAY_URL);
  const token = environment.NEMEDA_RELAY_TOKEN;
  if (!url || !token) return state;
  const existing = Object.entries(state.servers).find(([, entry]) => normalizeUrl(entry.url) === url);
  if (existing) return state.active ? state : { ...state, active: existing[0] };
  const name = Object.keys(state.servers).length === 0 ? "default" : new URL(url).hostname.split(".")[0];
  return upsertServer(state, name, { url, token });
}

// What the runner should connect to: the active profile, or the bare env pair
// when no profiles exist at all.
// `name` overrides the active profile, so one machine can run a runner per
// relay at once — keeping production answering while you test a local relay.
export function resolveActiveServer(environment = process.env, name = "") {
  const merged = effectiveEnvironment(environment);
  const state = migrateFromEnv(loadServers(environment), merged);
  if (name) {
    const chosen = state.servers[name];
    if (!chosen?.url || !chosen?.token) {
      const known = Object.keys(state.servers).join(", ") || "ninguno";
      throw new Error(`Unknown server "${name}". Known: ${known}.`);
    }
    return { name, url: normalizeUrl(chosen.url), token: chosen.token };
  }
  const entry = state.servers[state.active];
  if (entry?.url && entry?.token) {
    return { name: state.active, url: normalizeUrl(entry.url), token: entry.token };
  }
  const url = normalizeUrl(merged.NEMEDA_RELAY_URL);
  const token = merged.NEMEDA_RELAY_TOKEN;
  return url && token ? { name: "env", url, token } : null;
}
