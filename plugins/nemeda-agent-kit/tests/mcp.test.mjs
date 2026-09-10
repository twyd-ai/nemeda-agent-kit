import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Spawns a fresh MCP server, sends every request in `requests` (each an
// object with an `id`), and resolves once a response with that id has been
// seen for all of them, in a map keyed by id.
async function callServer(requests) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "mcp-server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
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

  const ids = requests.map((request) => request.id);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP server timed out")), 2000);
    const poll = setInterval(() => {
      if (ids.every((id) => responses.has(id))) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 10);
  });
  child.kill();
  return responses;
}

function toolCallResult(responses, id) {
  const payload = responses.get(id).result;
  return JSON.parse(payload.content[0].text);
}

test("MCP server initializes and lists its tools", async () => {
  const responses = await callServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  ]);

  assert.equal(responses.get(1).result.serverInfo.name, "nemeda-agent-kit");
  assert.deepEqual(
    responses.get(2).result.tools.map((tool) => tool.name),
    ["workspace_context", "workspace_doctor", "workspace_config_schema", "workspace_meetings", "memory_search", "memory_recent", "memory_get"]
  );
});

function configuredMemoryWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-mcp-memory-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  writeFileSync(
    path.join(root, ".nemeda", "agent-kit.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: "acme", name: "Acme" },
      repository: { id: "acme", role: "backend", profiles: [] },
      context: { instructions: ["AGENTS.md"] },
      tools: { required: [], optional: [] },
      policies: { protectSecrets: true },
      memory: { project: { path: "memory" } }
    })
  );
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  return root;
}

test("memory_search, memory_recent, and memory_get read the project's journals", async () => {
  const workspaceRoot = configuredMemoryWorkspace();
  execFileSync(process.execPath, [path.join(root, "scripts", "cli.mjs"), "memory", "add", "--type", "decision", "--title", "Ship OneDrive", "--cwd", workspaceRoot], {
    input: "We decided to ship OneDrive support this week."
  });
  execFileSync(process.execPath, [path.join(root, "scripts", "cli.mjs"), "memory", "add", "--type", "finding", "--title", "Unrelated", "--cwd", workspaceRoot], {
    input: "Something about lunch."
  });

  const responses = await callServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { cwd: workspaceRoot, query: "onedrive" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_recent", arguments: { cwd: workspaceRoot, limit: 1 } } }
  ]);

  const searchResult = toolCallResult(responses, 2);
  assert.equal(searchResult.results.length, 1);
  assert.equal(searchResult.results[0].title, "Ship OneDrive");

  const recentResult = toolCallResult(responses, 3);
  assert.equal(recentResult.results.length, 1);
  const entryId = recentResult.results[0].id;

  const getResponses = await callServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_get", arguments: { cwd: workspaceRoot, id: entryId } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_get", arguments: { cwd: workspaceRoot, id: "not-a-real-id" } } }
  ]);
  assert.equal(toolCallResult(getResponses, 2).id, entryId);
  const missing = getResponses.get(3).result;
  assert.equal(missing.isError, true);
  assert.match(JSON.parse(missing.content[0].text).error, /No memory entry/);
});

test("memory tools report a clear error when the repository has no memory section", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "nemeda-mcp-nomemory-"));
  mkdirSync(path.join(workspaceRoot, ".nemeda"), { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, ".nemeda", "agent-kit.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: "x", name: "X" },
      repository: { id: "x", role: "backend", profiles: [] },
      context: { instructions: [] },
      tools: { required: [], optional: [] },
      policies: { protectSecrets: true }
    })
  );
  writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# X\n");

  const responses = await callServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { cwd: workspaceRoot, query: "anything" } } }
  ]);
  const result = responses.get(2).result;
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /No `memory` section/);
});
