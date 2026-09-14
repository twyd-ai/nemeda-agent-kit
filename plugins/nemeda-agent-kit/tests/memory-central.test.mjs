// Phase 3 (docs/memory-plan.md): the client side of the central memory
// service — config validation, token lookup, promotion through POST
// /promote, the Streamable HTTP MCP client, doctor rows, the CLI, and the
// MCP proxy — against a local node:http stub of the service. No network.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appendEntry, createEntry, reviseEntry } from "../scripts/lib/memory.mjs";
import {
  CentralError,
  callCentralTool,
  centralDoctorChecks,
  centralOfflineChecks,
  centralSettings,
  resolveCentralToken,
  serviceBaseUrl,
  toolResultJson
} from "../scripts/lib/memory-central.mjs";
import { describeSyncError, readSyncState, syncStatePath, syncToCentral } from "../scripts/lib/memory-sync.mjs";
import { validateConfig } from "../scripts/lib/workspace.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "cli.mjs");
const serverPath = path.join(pluginRoot, "scripts", "mcp-server.mjs");
const execFileAsync = promisify(execFile);
const TOKEN = "stub-secret-token";

// A stand-in for nemeda-memory-service: /health, /whoami, /promote, and a
// Streamable HTTP /mcp that assigns a session id and answers in JSON or SSE.
function startStub({ projects = ["acme"], sse = false } = {}) {
  const state = { rows: new Map(), requests: [] };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    state.requests.push({ method: request.method, url: request.url, auth: request.headers.authorization, headers: request.headers, body });
    const reply = (status, payload, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (request.url === "/health") return reply(200, { service: "stub", version: "0.0.1", contractVersion: 1, embeddings: { status: "ok", pending: 0 } });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { detail: "invalid token" });
    if (request.url === "/whoami") return reply(200, { email: "ana@example.com", projects: ["*"], canPromote: true });
    if (request.url === "/promote" && request.method === "POST") {
      const inserted = [];
      const existing = [];
      const errors = [];
      for (const row of body.entries) {
        if (!projects.includes(row.project_id)) {
          errors.push({ id: row.id, revision: row.revision, code: "unknown-project", message: `no project ${row.project_id}` });
          continue;
        }
        const key = `${row.id}:${row.revision}`;
        if (state.rows.has(key)) existing.push({ id: row.id, revision: row.revision });
        else {
          state.rows.set(key, row);
          inserted.push({ id: row.id, revision: row.revision });
        }
      }
      return reply(200, { entries: { inserted, existing }, digests: { inserted: [], existing: [] }, errors });
    }
    if (request.url === "/mcp") {
      if (request.method === "DELETE") return reply(200, {});
      if (body.method === "initialize") {
        return reply(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub" } } }, { "mcp-session-id": "session-1" });
      }
      if (body.method === "notifications/initialized") {
        response.writeHead(202);
        return response.end();
      }
      if (body.method === "tools/call") {
        if (request.headers["mcp-session-id"] !== "session-1") return reply(400, { detail: "missing session" });
        const payload = body.params.name === "memory_central_projects"
          ? { projects: projects.map((id) => ({ id, active: true })) }
          : { tool: body.params.name, arguments: body.params.arguments, results: [] };
        const message = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } };
        if (sse) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          return response.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        }
        return reply(200, message);
      }
    }
    return reply(404, { detail: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        })
      });
    });
  });
}

function baseConfig(central) {
  return {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "backend", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    memory: { project: { path: "memory" }, central }
  };
}

function workspace(mcpUrl, { projectId, email = "ana@example.com" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-central-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  const config = baseConfig({ mcpUrl, ...(projectId ? { projectId } : {}) });
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", email], { cwd: root });
  return root;
}

function readConfig(root) {
  return JSON.parse(readFileSync(path.join(root, ".nemeda", "agent-kit.json"), "utf8"));
}

function emptyHome() {
  return mkdtempSync(path.join(tmpdir(), "nemeda-home-"));
}

function tokenEnvironment() {
  return { NEMEDA_HOME: emptyHome(), NEMEDA_MEMORY_TOKEN: TOKEN };
}

// One pending and one reviewed entry by ana, one reviewed entry by bob.
function seed(root) {
  const memoryRoot = path.join(root, "memory");
  appendEntry(memoryRoot, createEntry({ project: "acme", type: "decision", title: "Pending idea", author: "ana@example.com", summary: "Not reviewed yet." }));
  const draft = appendEntry(memoryRoot, createEntry({ project: "acme", type: "decision", title: "Use bge-m3", author: "ana@example.com", summary: "We chose bge-m3.", ai: { tool: "Claude Code", model: "claude-opus-5" } }));
  const reviewed = appendEntry(memoryRoot, reviseEntry(draft, { status: "reviewed" }));
  const bobDraft = appendEntry(memoryRoot, createEntry({ project: "acme", type: "finding", title: "Bob's finding", author: "bob@example.com", summary: "Found it." }));
  const foreign = appendEntry(memoryRoot, reviseEntry(bobDraft, { status: "reviewed" }));
  return { reviewed, foreign };
}

test("memory.central validation: mcpUrl or urlVariable, https only, variable names only", () => {
  const errors = (central) =>
    validateConfig(baseConfig(central))
      .filter((issue) => issue.code === "invalid-memory" && issue.level === "error")
      .map((issue) => issue.message)
      .join(" | ");
  assert.equal(errors({ mcpUrl: "https://memory.example.ts.net/mcp", tokenVariable: "NEMEDA_MEMORY_TOKEN" }), "");
  assert.equal(errors({ mcpUrl: "http://localhost:8080/mcp" }), "");
  assert.equal(errors({ urlVariable: "NEMEDA_MEMORY_DB_URL" }), "");
  assert.match(errors({ mcpUrl: "http://memory.example.ts.net/mcp" }), /mcpUrl must use https/);
  assert.match(errors({ mcpUrl: "https://memory.example.ts.net/mcp?token=x" }), /query string/);
  assert.match(errors({ mcpUrl: "https://user:pass@memory.example.ts.net/mcp" }), /must not embed credentials/);
  assert.match(errors({ promote: "reviewed" }), /needs mcpUrl .* or urlVariable/);
  assert.match(errors({ mcpUrl: "https://memory.example.ts.net/mcp", tokenVariable: "my-token" }), /tokenVariable must be an environment variable name/);
});

test("the HTTP endpoints sit next to the MCP endpoint", () => {
  assert.equal(serviceBaseUrl("https://memory.example.ts.net/mcp"), "https://memory.example.ts.net");
  assert.equal(serviceBaseUrl("https://example.com/memory/mcp/"), "https://example.com/memory");
  const settings = centralSettings(baseConfig({ mcpUrl: "https://memory.example.ts.net/mcp" }));
  assert.equal(settings.tokenVariable, "NEMEDA_MEMORY_TOKEN");
  assert.equal(settings.projectId, "acme");
  assert.equal(settings.promote, "reviewed");
});

test("the token comes from the environment, then ~/.nemeda/.env.local, then the workspace .env.local", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-token-"));
  const home = emptyHome();
  const settings = { tokenVariable: "NEMEDA_MEMORY_TOKEN" };
  assert.equal(resolveCentralToken(root, settings, { NEMEDA_HOME: home }).token, null);
  writeFileSync(path.join(root, ".env.local"), "NEMEDA_MEMORY_TOKEN=from-workspace\n");
  assert.equal(resolveCentralToken(root, settings, { NEMEDA_HOME: home }).token, "from-workspace");
  writeFileSync(path.join(home, ".env.local"), "NEMEDA_MEMORY_TOKEN=from-home\n");
  const personal = resolveCentralToken(root, settings, { NEMEDA_HOME: home });
  assert.equal(personal.token, "from-home");
  assert.equal(personal.source, path.join(home, ".env.local"));
  assert.equal(resolveCentralToken(root, settings, { NEMEDA_HOME: home, NEMEDA_MEMORY_TOKEN: "from-env" }).source, "environment");
});

test("memory sync promotes your latest reviewed revisions once, idempotently", async () => {
  const stub = await startStub();
  try {
    const root = workspace(stub.url);
    const config = readConfig(root);
    const { reviewed, foreign } = seed(root);
    const environment = tokenEnvironment();

    const dry = await syncToCentral(root, config, { environment, dryRun: true });
    assert.deepEqual(dry.candidates.map((candidate) => candidate.id), [reviewed.id]);
    assert.equal(stub.state.requests.length, 0);

    const first = await syncToCentral(root, config, { environment });
    assert.deepEqual(first.inserted, [{ id: reviewed.id, revision: 2 }]);
    const promotes = stub.state.requests.filter((request) => request.url === "/promote");
    assert.equal(promotes.length, 1);
    assert.equal(promotes[0].auth, `Bearer ${TOKEN}`);
    const row = promotes[0].body.entries[0];
    assert.equal(row.project_id, "acme");
    assert.equal(row.revision, 2);
    assert.equal(row.status, "reviewed");
    assert.equal(row.entry_date, reviewed.date);
    assert.equal(row.author_email, "ana@example.com");
    assert.equal(row.ai_model, "claude-opus-5");
    assert.equal("promoted_by" in row, false);
    assert.deepEqual(promotes[0].body.digests, []);
    assert.equal(readSyncState(root).promoted[reviewed.id], 2);

    const second = await syncToCentral(root, config, { environment });
    assert.equal(second.candidates.length, 0);
    assert.equal(stub.state.requests.filter((request) => request.url === "/promote").length, 1);

    // Losing the acknowledgement file only re-sends; the service reports it.
    rmSync(syncStatePath(root));
    const third = await syncToCentral(root, config, { environment });
    assert.deepEqual(third.existing, [{ id: reviewed.id, revision: 2 }]);
    assert.deepEqual(third.inserted, []);

    const everyone = await syncToCentral(root, config, { environment, all: true });
    assert.deepEqual(everyone.inserted, [{ id: foreign.id, revision: 2 }]);
  } finally {
    await stub.close();
  }
});

test("memory sync keeps refused rows for the next run and explains an unregistered project", async () => {
  const stub = await startStub();
  try {
    const root = workspace(stub.url, { projectId: "ghost" });
    const { reviewed } = seed(root);
    const report = await syncToCentral(root, readConfig(root), { environment: tokenEnvironment() });
    assert.deepEqual(report.inserted, []);
    assert.equal(report.errors[0].code, "unknown-project");
    assert.equal(report.errors[0].id, reviewed.id);
    assert.match(describeSyncError(report.errors[0], "ghost"), /register-projects\.sh ghost/);
    const state = readSyncState(root);
    assert.deepEqual(state.promoted, {});
    assert.match(state.lastError, /refused/);
  } finally {
    await stub.close();
  }
});

test("memory sync stops on a missing or rejected token without leaking it", async () => {
  const stub = await startStub();
  try {
    const root = workspace(stub.url);
    seed(root);
    const config = readConfig(root);
    await assert.rejects(syncToCentral(root, config, { environment: { NEMEDA_HOME: emptyHome() } }), (error) => error instanceof CentralError && error.code === "no-token");
    await assert.rejects(
      syncToCentral(root, config, { environment: { NEMEDA_HOME: emptyHome(), NEMEDA_MEMORY_TOKEN: "wrong-secret" } }),
      (error) => error instanceof CentralError && error.code === "unauthenticated" && !error.message.includes("wrong-secret")
    );
    assert.match(readSyncState(root).lastError, /401/);
  } finally {
    await stub.close();
  }
});

test("callCentralTool speaks Streamable HTTP with a session id, over JSON or SSE", async () => {
  for (const sse of [false, true]) {
    const stub = await startStub({ sse });
    try {
      const settings = centralSettings(baseConfig({ mcpUrl: stub.url }));
      const result = await callCentralTool(settings, TOKEN, "memory_central_search", { query: "bge" });
      assert.deepEqual(toolResultJson(result).arguments, { query: "bge" });
      const posts = stub.state.requests.filter((request) => request.url === "/mcp" && request.method === "POST");
      assert.deepEqual(posts.map((request) => request.body.method), ["initialize", "notifications/initialized", "tools/call"]);
      assert.ok(posts.every((request) => request.auth === `Bearer ${TOKEN}`));
      assert.equal(posts[2].headers["mcp-protocol-version"], "2025-06-18");
    } finally {
      await stub.close();
    }
  }
});

test("memory doctor's online checks pass on a healthy service and flag an unregistered project or a dead one", async () => {
  const stub = await startStub();
  try {
    const root = workspace(stub.url);
    const checks = await centralDoctorChecks(root, readConfig(root), { environment: tokenEnvironment() });
    assert.deepEqual(checks.map((check) => [check.code, check.status]), [
      ["memory-central", "pass"],
      ["memory-central-token", "pass"],
      ["memory-central-project", "pass"]
    ]);
    const ghost = workspace(stub.url, { projectId: "ghost" });
    const ghostChecks = await centralDoctorChecks(ghost, readConfig(ghost), { environment: tokenEnvironment() });
    assert.equal(ghostChecks.find((check) => check.code === "memory-central-project").status, "warn");
  } finally {
    await stub.close();
  }
  const dead = workspace("http://127.0.0.1:9/mcp");
  const down = await centralDoctorChecks(dead, readConfig(dead), { environment: tokenEnvironment() });
  assert.equal(down[0].status, "fail");
  assert.match(down[0].message, /Cannot reach the memory service/);
});

test("the offline doctor row reports configuration and token presence, never the token", () => {
  const root = workspace("https://memory.example.ts.net/mcp");
  const home = emptyHome();
  assert.equal(centralOfflineChecks(root, readConfig(root), { NEMEDA_HOME: home })[0].status, "warn");
  writeFileSync(path.join(home, ".env.local"), "NEMEDA_MEMORY_TOKEN=very-secret\n");
  const [row] = centralOfflineChecks(root, readConfig(root), { NEMEDA_HOME: home });
  assert.equal(row.status, "pass");
  assert.equal(row.message.includes("very-secret"), false);
});

test("memory add --json accepts status reviewed, so a confirmed memory-log entry is promotable", () => {
  const root = workspace("https://memory.example.ts.net/mcp");
  const stdout = execFileSync(process.execPath, [cliPath, "memory", "add", "--json", "--cwd", root], {
    input: JSON.stringify({ type: "decision", title: "Confirmed", summary: "Seen and confirmed.", status: "reviewed" }),
    encoding: "utf8"
  });
  assert.equal(JSON.parse(stdout).status, "reviewed");
});

test("memory sync, search --central, and doctor work through the real CLI", async () => {
  const stub = await startStub();
  try {
    const root = workspace(stub.url);
    const { reviewed } = seed(root);
    const env = { ...process.env, ...tokenEnvironment() };
    const run = (args) => execFileAsync(process.execPath, [cliPath, ...args, "--cwd", root], { env, encoding: "utf8" });

    const sync = JSON.parse((await run(["memory", "sync", "--json"])).stdout);
    assert.deepEqual(sync.inserted, [{ id: reviewed.id, revision: 2 }]);

    const search = JSON.parse((await run(["memory", "search", "bge", "--central", "--json"])).stdout);
    assert.equal(search.arguments.query, "bge");

    const doctor = JSON.parse((await run(["memory", "doctor", "--json"])).stdout);
    const codes = Object.fromEntries(doctor.checks.map((check) => [check.code, check.status]));
    assert.equal(codes["memory-central"], "pass");
    assert.equal(codes["memory-central-project"], "pass");
    assert.equal(codes["memory-sync"], "pass");

    await assert.rejects(run(["memory", "sync", "--via", "psql"]), (error) => /not implemented yet/.test(error.stderr));
  } finally {
    await stub.close();
  }
});

async function callMcp(args, env, requests) {
  const child = spawn(process.execPath, [serverPath, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const parsed = JSON.parse(line);
        responses.set(parsed.id, parsed);
      }
      newline = buffer.indexOf("\n");
    }
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP server timed out")), 5000);
    const poll = setInterval(() => {
      if (requests.every((request) => responses.has(request.id))) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 10);
  });
  child.kill();
  return responses;
}

test("the MCP server proxies the read-only central tools only with --central-proxy", async () => {
  const stub = await startStub();
  try {
    const root = workspace(stub.url);
    const env = { ...process.env, ...tokenEnvironment() };
    delete env.NEMEDA_MEMORY_CENTRAL_PROXY;
    const proxied = await callMcp(["--central-proxy"], env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_central_search", arguments: { cwd: root, query: "bge", k: 3 } } }
    ]);
    const names = proxied.get(2).result.tools.map((tool) => tool.name);
    assert.ok(names.includes("memory_central_search"));
    assert.ok(names.includes("memory_central_whoami"));
    assert.equal(names.includes("memory_central_promote"), false);
    assert.deepEqual(JSON.parse(proxied.get(3).result.content[0].text).arguments, { query: "bge", k: 3 });

    const plain = await callMcp([], env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    ]);
    assert.equal(plain.get(2).result.tools.some((tool) => tool.name.startsWith("memory_central_")), false);
  } finally {
    await stub.close();
  }
});
