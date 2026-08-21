import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_SLACK_METHODS,
  createSseParser,
  decideRelayRoute,
  generatePairingCode,
  generateRunnerToken,
  hashToken,
  isUnlinkCommand,
  parsePairingText
} from "../scripts/lib/relay-protocol.mjs";

test("pairing codes and tokens have the expected shapes", () => {
  assert.match(generatePairingCode(), /^[A-ZÑ]+-\d{4}$/);
  const token = generateRunnerToken();
  assert.match(token, /^nrt_[0-9a-f]{64}$/);
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), hashToken(generateRunnerToken()));
});

test("parsePairingText accepts vincular/link and rejects noise", () => {
  assert.equal(parsePairingText("vincular AZUL-7291"), "AZUL-7291");
  assert.equal(parsePairingText("  link rojo-0042 "), "ROJO-0042");
  assert.equal(parsePairingText("vincular mi agente"), null);
  assert.equal(parsePairingText("¿cómo vinculo AZUL-7291?"), null);
  assert.equal(isUnlinkCommand("desvincular"), true);
  assert.equal(isUnlinkCommand("desvincular a Juan"), false);
});

test("decideRelayRoute forwards to the asker's runner first", () => {
  const connections = new Map([["U1", { guests: [] }]]);
  const decision = decideRelayRoute({
    event: { type: "message", channel_type: "im", user: "U1", text: "hola" },
    botUserId: "UBOT",
    pairedUsers: new Set(["U1"]),
    connections
  });
  assert.deepEqual(decision, { action: "forward", target: "U1" });
});

test("decideRelayRoute sponsors guests through a connected runner", () => {
  const connections = new Map([["U1", { guests: ["U9"] }]]);
  const decision = decideRelayRoute({
    event: { type: "app_mention", user: "U9", channel: "C1", text: "<@UBOT> hola" },
    botUserId: "UBOT",
    pairedUsers: new Set(["U1"]),
    connections
  });
  assert.equal(decision.action, "forward");
  assert.equal(decision.target, "U1");
  assert.equal(decision.sponsored, true);
});

test("decideRelayRoute distinguishes offline from never-paired, only when addressed", () => {
  const base = { botUserId: "UBOT", pairedUsers: new Set(["U2"]), connections: new Map() };
  assert.equal(decideRelayRoute({ ...base, event: { type: "message", channel_type: "im", user: "U2", text: "hola" } }).action, "offline");
  assert.equal(decideRelayRoute({ ...base, event: { type: "message", channel_type: "im", user: "U3", text: "hola" } }).action, "instructions");
  assert.equal(decideRelayRoute({ ...base, event: { type: "message", user: "U3", channel: "C1", text: "hola" } }).action, "ignore");
  assert.equal(decideRelayRoute({ ...base, event: { type: "app_mention", user: "U3", channel: "C1", text: "<@UBOT> hola" } }).action, "instructions");
});

test("decideRelayRoute ignores bots, subtypes, and the bot itself", () => {
  const base = { botUserId: "UBOT", pairedUsers: new Set(), connections: new Map() };
  for (const event of [
    { type: "message", channel_type: "im", bot_id: "B1", user: "U1" },
    { type: "message", channel_type: "im", user: "UBOT" },
    { type: "message", channel_type: "im", user: "U1", subtype: "message_changed" },
    { type: "message", channel_type: "im" }
  ]) {
    assert.equal(decideRelayRoute({ ...base, event }).action, "ignore");
  }
});

test("the Slack method whitelist covers what the runner uses and nothing dangerous", () => {
  for (const method of ["chat.postMessage", "chat.delete", "reactions.add", "conversations.replies"]) {
    assert.ok(ALLOWED_SLACK_METHODS.has(method), method);
  }
  for (const method of ["admin.users.remove", "users.list", "chat.update", "files.upload", "auth.test"]) {
    assert.ok(!ALLOWED_SLACK_METHODS.has(method), method);
  }
});

test("createSseParser reassembles events across chunk boundaries", () => {
  const parse = createSseParser();
  assert.deepEqual(parse('data: {"a":1}\n\ndata: {"b'), ['{"a":1}']);
  assert.deepEqual(parse('":2}\n\n: ping\n\n'), ['{"b":2}']);
  assert.deepEqual(parse("data: uno\ndata: dos\n\n"), ["uno\ndos"]);
});
