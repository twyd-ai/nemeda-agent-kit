import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildBackendCommand,
  buildRoutes,
  classifyEvent,
  isPurgeCommand,
  loadRegistry,
  parseBackendOutput,
  rateLimit,
  resolveDmRoute,
  sessionRetryMode,
  splitForSlack,
  stripMentions,
  threadSessionId,
  toMrkdwn,
  withSlackDefaults
} from "../scripts/lib/slack.mjs";
import { validateConfig } from "../scripts/lib/workspace.mjs";

function baseConfig(extra = {}) {
  return {
    schemaVersion: 1,
    project: { id: "demo", name: "Demo" },
    repository: { id: "demo", role: "app", profiles: ["javascript"] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    ...extra
  };
}

function makeRepo(slack) {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-slack-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(baseConfig(slack ? { slack } : {}), null, 2));
  writeFileSync(path.join(root, "AGENTS.md"), "# Demo\n\nBe brief.\n");
  return root;
}

const route = { root: "/repo", projectId: "demo", projectName: "Demo", slack: withSlackDefaults({ channels: ["C01ABCDEF"], owner: "U01OWNER", guests: ["U02GUEST"] }) };

test("validateConfig accepts a well-formed slack section", () => {
  const issues = validateConfig(baseConfig({ slack: { channels: ["C01ABCDEF"], owner: "U01ABCDEF", guests: ["U02ABCDEF"], backend: "codex" } }));
  assert.deepEqual(issues, []);
});

test("validateConfig rejects bad slack ids, unknown keys, and out-of-range numbers", () => {
  const codes = validateConfig(baseConfig({ slack: { channels: ["nope"], owner: "marc", backend: "gpt", maxAnswerChars: 99, surprise: true } }))
    .map((issue) => issue.code);
  assert.ok(codes.every((code) => code === "invalid-slack" || code === "unknown-field"));
  assert.ok(codes.length >= 4);
});

test("classifyEvent answers a mention from the owner and a guest", () => {
  for (const user of ["U01OWNER", "U02GUEST"]) {
    const decision = classifyEvent({
      event: { type: "app_mention", user, text: "<@U09BOTXX> ¿qué hace orders?", channel: "C01ABCDEF", ts: "1.0" },
      botUserId: "U09BOTXX",
      route
    });
    assert.equal(decision.action, "answer");
    assert.equal(decision.question, "¿qué hace orders?");
  }
});

test("classifyEvent denies a stranger and ignores bots, subtypes, and itself", () => {
  const deny = classifyEvent({ event: { type: "app_mention", user: "U03OTHER", text: "<@U09BOTXX> hola", channel: "C01ABCDEF", ts: "1.0" }, botUserId: "U09BOTXX", route });
  assert.equal(deny.action, "deny");
  for (const event of [
    { type: "app_mention", bot_id: "B1", user: "U01OWNER", channel: "C01ABCDEF", ts: "1.0" },
    { type: "message", subtype: "message_changed", user: "U01OWNER", channel: "C01ABCDEF", ts: "1.0" },
    { type: "app_mention", user: "U09BOTXX", channel: "C01ABCDEF", ts: "1.0" }
  ]) {
    assert.equal(classifyEvent({ event, botUserId: "U09BOTXX", route }).action, "ignore");
  }
});

test("classifyEvent follows a known thread without a new mention, but ignores unrelated chatter", () => {
  const event = { type: "message", user: "U01OWNER", text: "¿y el rate limit?", channel: "C01ABCDEF", ts: "3.0", thread_ts: "2.0" };
  assert.equal(classifyEvent({ event, botUserId: "U09BOTXX", route, knownThreads: new Set(["C01ABCDEF:2.0"]) }).action, "answer");
  assert.equal(classifyEvent({ event, botUserId: "U09BOTXX", route, knownThreads: new Set() }).action, "ignore");
  const loose = { type: "message", user: "U01OWNER", text: "buenos días", channel: "C01ABCDEF", ts: "4.0" };
  assert.equal(classifyEvent({ event: loose, botUserId: "U09BOTXX", route, knownThreads: new Set(["C01ABCDEF:2.0"]) }).action, "ignore");
});

test("classifyEvent reports an unrouted channel instead of guessing", () => {
  const decision = classifyEvent({ event: { type: "app_mention", user: "U01OWNER", text: "<@U09BOTXX> hola", channel: "C99ZZZZZZ", ts: "1.0" }, botUserId: "U09BOTXX", route: null });
  assert.equal(decision.action, "unrouted");
});

test("stripMentions removes every user and bot mention", () => {
  assert.equal(stripMentions("<@U09BOTXX> mira <@U123> esto"), "mira esto");
});

test("buildRoutes indexes channels and flags a channel claimed twice", () => {
  const first = makeRepo({ channels: ["C01ABCDEF"], owner: "U01ABCDEF" });
  const second = makeRepo({ channels: ["C01ABCDEF"], owner: "U01ABCDEF" });
  const third = makeRepo(null);
  const { routes, projects, issues } = buildRoutes([first, second, third]);
  assert.equal(routes.size, 1);
  assert.equal(projects.length, 2);
  assert.ok(issues.some((issue) => issue.level === "error" && issue.message.includes("claimed by both")));
  assert.ok(issues.some((issue) => issue.level === "warning" && issue.message.includes("no slack section")));
});

test("loadRegistry reports a missing registry instead of throwing", () => {
  const home = mkdtempSync(path.join(tmpdir(), "nemeda-home-"));
  const registry = loadRegistry({ NEMEDA_HOME: home });
  assert.equal(registry.repos.length, 0);
  assert.match(registry.error, /does not exist/);
});

test("rateLimit allows up to the cap in a rolling hour", () => {
  const now = Date.now();
  let state = {};
  for (let index = 0; index < 3; index += 1) {
    const result = rateLimit(state, "demo:U1", 3, now);
    assert.equal(result.allowed, true);
    state = result.state;
  }
  const blocked = rateLimit(state, "demo:U1", 3, now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMinutes >= 1);
  assert.equal(rateLimit(state, "demo:U1", 3, now + 61 * 60 * 1000).allowed, true);
});

test("toMrkdwn converts Markdown but leaves code fences alone", () => {
  const converted = toMrkdwn("## Título\n\n**negrita** y [link](https://x.com)\n\n- uno\n- dos");
  assert.equal(converted, "*Título*\n\n*negrita* y <https://x.com|link>\n\n• uno\n• dos");
  const fenced = "```\n**not bold** and [not](https://x.com)\n```";
  assert.equal(toMrkdwn(fenced), fenced);
});

test("splitForSlack keeps a short answer whole and splits a long one on boundaries", () => {
  assert.deepEqual(splitForSlack("corto"), ["corto"]);
  assert.deepEqual(splitForSlack("   "), []);
  const chunks = splitForSlack(`${"a".repeat(400)}\n\n${"b".repeat(400)}`, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(chunks.join("").replace(/\s/g, "").length, 800);
});

test("threadSessionId is a stable uuid per thread", () => {
  const first = threadSessionId("T1", "C1", "123.45");
  assert.equal(first, threadSessionId("T1", "C1", "123.45"));
  assert.notEqual(first, threadSessionId("T1", "C1", "123.46"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("buildBackendCommand stays read-only and resumes an existing thread", () => {
  const fresh = buildBackendCommand(route, { question: "¿y esto?", cwd: "/repo", sessionId: "abc", resume: false, prompt: "voice" });
  assert.equal(fresh.command, "claude");
  assert.ok(fresh.args.includes("--session-id"));
  assert.ok(!fresh.args.includes("--resume"));
  const tools = fresh.args[fresh.args.indexOf("--tools") + 1];
  assert.equal(tools, "Read,Grep,Glob");
  const denied = fresh.args[fresh.args.indexOf("--disallowed-tools") + 1];
  for (const tool of ["Bash", "Write", "Edit", "WebFetch"]) assert.ok(denied.includes(tool));
  const resumed = buildBackendCommand(route, { question: "y?", cwd: "/repo", sessionId: "abc", resume: true, prompt: "voice" });
  assert.ok(resumed.args.includes("--resume"));
  assert.ok(!resumed.args.includes("--session-id"));
});

test("buildBackendCommand sandboxes the codex backend", () => {
  const codexRoute = { ...route, slack: withSlackDefaults({ channels: ["C01ABCDEF"], owner: "U01OWNER", backend: "codex" }) };
  const command = buildBackendCommand(codexRoute, { question: "¿y esto?", cwd: "/repo", sessionId: "abc", prompt: "voice" });
  assert.equal(command.command, "codex");
  assert.deepEqual(command.args.slice(0, 4), ["exec", "--sandbox", "read-only", "--skip-git-repo-check"]);
});

test("parseBackendOutput unwraps claude json, surfaces its error, and survives plain text", () => {
  assert.deepEqual(parseBackendOutput("claude", JSON.stringify({ result: " hola " })), { text: "hola", error: null });
  assert.deepEqual(parseBackendOutput("claude", JSON.stringify({ is_error: true, result: "OAuth token expired" })), {
    text: "",
    error: "OAuth token expired"
  });
  assert.equal(parseBackendOutput("claude", "not json").text, "not json");
  assert.equal(parseBackendOutput("codex", " respuesta ").text, "respuesta");
  assert.match(parseBackendOutput("codex", "").error, /nothing/);
});

test("buildRoutes lets the registry cover section-less repos and map channels", () => {
  const bare = makeRepo(null);
  const registry = { owner: "U01ABCDEF", guests: ["U05GUESTX"], channels: { C07MAPPED1: "demo" } };
  const { routes, projects, issues } = buildRoutes([bare], registry);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].slack.owner, "U01ABCDEF");
  assert.deepEqual(projects[0].slack.guests, ["U05GUESTX"]);
  assert.equal(routes.get("C07MAPPED1")?.projectId, "demo");
  assert.ok(!issues.some((issue) => issue.level === "error"));
  const bad = buildRoutes([bare], { owner: "U01ABCDEF", channels: { C07MAPPED1: "nope" } });
  assert.ok(bad.issues.some((issue) => issue.message.includes('unknown project "nope"')));
});

test("resolveDmRoute picks by switch, prefix, stickiness, and only-one", () => {
  const projects = [
    { projectId: "milence", projectName: "Milence" },
    { projectId: "agent-kit", projectName: "Nemeda Agent Kit" }
  ];
  assert.equal(resolveDmRoute({ text: "usa milence", projects }).kind, "switch");
  assert.equal(resolveDmRoute({ text: "use Nemeda Agent Kit", projects }).route.projectId, "agent-kit");
  const prefixed = resolveDmRoute({ text: "agent-kit: ¿qué hace el doctor?", projects });
  assert.equal(prefixed.route.projectId, "agent-kit");
  assert.equal(prefixed.question, "¿qué hace el doctor?");
  assert.equal(resolveDmRoute({ text: "hola", projects }).kind, "choose");
  assert.equal(resolveDmRoute({ text: "hola", projects, activeProjectId: "milence" }).route.projectId, "milence");
  assert.equal(resolveDmRoute({ text: "usa scharlab", projects }).kind, "unknown-project");
  assert.equal(resolveDmRoute({ text: "cualquier cosa", projects: [projects[0]] }).route.projectId, "milence");
});

test("sessionRetryMode flips create/resume only on the matching mismatch", () => {
  assert.equal(sessionRetryMode("Error: Session ID abc is already in use.", false), "resume");
  assert.equal(sessionRetryMode("No conversation found with session ID: abc", true), "create");
  assert.equal(sessionRetryMode("Error: Session ID abc is already in use.", true), null);
  assert.equal(sessionRetryMode("OAuth token expired", false), null);
  assert.equal(sessionRetryMode(null, false), null);
});

test("isPurgeCommand matches short imperatives and rejects questions and prose", () => {
  for (const text of ["borra tus mensajes", "Limpia el chat", "elimina tu historial", "delete your messages", "clear chat"]) {
    assert.equal(isPurgeCommand(text), true, text);
  }
  for (const text of [
    "¿puedo borrar mensajes del chat con la API?",
    "borra los mensajes de error que aparecen en el log cuando arranca el runner",
    "qué hace chat.delete",
    ""
  ]) {
    assert.equal(isPurgeCommand(text), false, text || "(empty)");
  }
});
