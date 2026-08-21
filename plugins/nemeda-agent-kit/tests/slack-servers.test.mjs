import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadServers,
  migrateFromEnv,
  normalizeUrl,
  removeServer,
  resolveActiveServer,
  saveServers,
  upsertServer
} from "../scripts/lib/slack-servers.mjs";

function home() {
  return { NEMEDA_HOME: mkdtempSync(path.join(tmpdir(), "nemeda-servers-")) };
}

test("normalizeUrl drops trailing slashes so the same relay is one profile", () => {
  assert.equal(normalizeUrl("https://relay.example.com/"), "https://relay.example.com");
  assert.equal(normalizeUrl("https://relay.example.com///"), "https://relay.example.com");
});

test("upsertServer makes the touched profile active and merges fields", () => {
  let state = { active: "", servers: {} };
  state = upsertServer(state, "prod", { url: "https://a", token: "nrt_a" });
  assert.equal(state.active, "prod");
  state = upsertServer(state, "dev", { url: "http://localhost:8787", token: "nrt_b" });
  assert.equal(state.active, "dev");
  state = upsertServer(state, "prod", { pairedAs: "U1" });
  assert.deepEqual(state.servers.prod, { url: "https://a", token: "nrt_a", pairedAs: "U1" });
});

test("removeServer clears active only when it removed the active one", () => {
  const state = { active: "dev", servers: { prod: { url: "https://a" }, dev: { url: "https://b" } } };
  assert.equal(removeServer(state, "dev").active, "");
  assert.equal(removeServer(state, "prod").active, "dev");
});

test("migrateFromEnv adopts a pre-profiles setup once, without duplicating it", () => {
  const environment = { NEMEDA_RELAY_URL: "https://relay.example.com/", NEMEDA_RELAY_TOKEN: "nrt_x" };
  const first = migrateFromEnv({ active: "", servers: {} }, environment);
  assert.equal(first.active, "default");
  assert.equal(first.servers.default.url, "https://relay.example.com");
  // Same relay again: adopted, not duplicated.
  const second = migrateFromEnv(first, environment);
  assert.deepEqual(Object.keys(second.servers), ["default"]);
});

test("migrateFromEnv leaves an existing profile set alone when the env is empty", () => {
  const state = { active: "prod", servers: { prod: { url: "https://a", token: "t" } } };
  assert.deepEqual(migrateFromEnv(state, {}), state);
});

test("saveServers writes owner-only, since it stores runner tokens", () => {
  const environment = home();
  saveServers({ active: "prod", servers: { prod: { url: "https://a", token: "nrt_a" } } }, environment);
  const file = path.join(environment.NEMEDA_HOME, "servers.json");
  assert.equal(oct(statSync(file).mode), "600");
  assert.equal(loadServers(environment).active, "prod");
  assert.match(readFileSync(file, "utf8"), /nrt_a/);
});

test("loadServers survives a corrupt file instead of throwing", () => {
  const environment = home();
  saveServers({ active: "prod", servers: {} }, environment);
  writeFileSync(path.join(environment.NEMEDA_HOME, "servers.json"), "{ not json");
  assert.deepEqual(loadServers(environment), { active: "", servers: {} });
});

test("resolveActiveServer prefers the active profile and falls back to bare env", () => {
  const environment = home();
  assert.equal(resolveActiveServer(environment), null);
  assert.deepEqual(resolveActiveServer({ ...environment, NEMEDA_RELAY_URL: "https://x/", NEMEDA_RELAY_TOKEN: "nrt_e" }), {
    name: "default",
    url: "https://x",
    token: "nrt_e"
  });
  saveServers({ active: "prod", servers: { prod: { url: "https://a", token: "nrt_a" } } }, environment);
  assert.deepEqual(resolveActiveServer(environment), { name: "prod", url: "https://a", token: "nrt_a" });
});

function oct(mode) {
  return (mode & 0o777).toString(8);
}
