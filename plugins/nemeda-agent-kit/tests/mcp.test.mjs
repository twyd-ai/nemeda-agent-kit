import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP server initializes and lists its tools", async () => {
  const child = spawn(process.execPath, [path.join(root, "scripts", "mcp-server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const responses = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) responses.push(JSON.parse(line));
      newline = buffer.indexOf("\n");
    }
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP server timed out")), 2000);
    const poll = setInterval(() => {
      if (responses.length >= 2) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 10);
  });
  child.kill();

  assert.equal(responses[0].result.serverInfo.name, "nemeda-agent-kit");
  assert.deepEqual(
    responses[1].result.tools.map((tool) => tool.name),
    ["workspace_context", "workspace_doctor", "workspace_config_schema"]
  );
});
