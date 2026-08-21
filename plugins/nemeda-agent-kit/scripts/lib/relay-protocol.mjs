// Shared protocol pieces for the Slack relay: pairing codes, runner tokens,
// SSE parsing, the Slack method whitelist, and the routing decision. Pure
// functions only, so the whole protocol surface is unit-testable.

import { createHash, randomBytes, randomInt } from "node:crypto";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const RELAY_VERSION = 1;

// Short, phone-dictation-friendly: a color word plus four digits.
const CODE_WORDS = ["AZUL", "ROJO", "VERDE", "NEGRO", "BLANCO", "GRIS", "ROSA", "LILA", "CIAN", "ORO"];

export function generatePairingCode() {
  return `${CODE_WORDS[randomInt(CODE_WORDS.length)]}-${String(randomInt(10000)).padStart(4, "0")}`;
}

export function generateRunnerToken() {
  return `nrt_${randomBytes(32).toString("hex")}`;
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

// "vincular AZUL-7291" (or "link AZUL-7291") in a DM claims a pairing code.
export function parsePairingText(text) {
  const match = String(text || "").trim().match(/^(?:vincular|link|pair)\s+([A-ZÑ]+-\d{4})\s*$/i);
  return match ? match[1].toUpperCase() : null;
}

export function isUnlinkCommand(text) {
  return /^(?:desvincular|unlink)\s*$/i.test(String(text || "").trim());
}

// Only what the runner actually needs. Anything else is refused by the relay,
// so a compromised runner token cannot manage the workspace, invite users, or
// read channels it was never routed.
export const ALLOWED_SLACK_METHODS = new Set([
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.delete",
  "reactions.add",
  "reactions.remove",
  "conversations.history",
  "conversations.replies",
  "conversations.info"
]);

// Decides what the relay does with one Slack event. `connections` maps Slack
// user id -> runner profile ({ guests: [...] }); pairedUsers is the set of user
// ids with a stored pairing (connected or not).
export function decideRelayRoute({ event, botUserId, pairedUsers, connections }) {
  if (!event || typeof event !== "object") return { action: "ignore", reason: "not an event" };
  if (event.bot_id || event.user === botUserId || !event.user) return { action: "ignore", reason: "bot or missing author" };
  if (event.subtype) return { action: "ignore", reason: `subtype ${event.subtype}` };

  const isDirectMessage = event.channel_type === "im";
  const isMention = event.type === "app_mention";

  if (connections.has(event.user)) return { action: "forward", target: event.user };

  // Guest sponsorship: someone without a runner is answered by a connected
  // runner that explicitly lists them.
  for (const [userId, profile] of connections) {
    if (profile.guests?.includes(event.user)) return { action: "forward", target: userId, sponsored: true };
  }

  // Nobody can answer. Stay silent unless the person clearly addressed the
  // bot; unprompted thread chatter never earns a reply.
  if (!isDirectMessage && !isMention) return { action: "ignore", reason: "unaddressed and unpaired" };
  return pairedUsers.has(event.user)
    ? { action: "offline", reason: "runner paired but not connected" }
    : { action: "instructions", reason: "user has no runner" };
}
