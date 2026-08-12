#!/usr/bin/env node
import {
  defaultWorkspaceDirectory,
  loadSchema,
  readWorkspaceContext,
  workspaceDoctor
} from "./lib/workspace.mjs";

const SERVER_INFO = { name: "nemeda-agent-kit", version: "0.1.0" };

const tools = [
  {
    name: "workspace_context",
    description: "Read normalized Nemeda Agent Kit configuration and safe instruction files for a repository.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "Current repository or subdirectory." } },
      additionalProperties: false
    }
  },
  {
    name: "workspace_doctor",
    description: "Run read-only checks for configuration validity, instruction drift, duplicated MCP config, hosts, and required tools.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "Current repository or subdirectory." } },
      additionalProperties: false
    }
  },
  {
    name: "workspace_config_schema",
    description: "Return the JSON Schema for .nemeda/agent-kit.json.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

function toolResult(name, args = {}) {
  const cwd = args.cwd || defaultWorkspaceDirectory();
  if (name === "workspace_context") return textResult(readWorkspaceContext(cwd));
  if (name === "workspace_doctor") return textResult(workspaceDoctor(cwd));
  if (name === "workspace_config_schema") return textResult(loadSchema());
  return textResult({ error: `Unknown tool: ${name}` }, true);
}

function resourceContext() {
  return readWorkspaceContext(defaultWorkspaceDirectory());
}

function handle(request) {
  const { id, method, params = {} } = request;
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO
      }
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    send({ jsonrpc: "2.0", id, result: toolResult(params.name, params.arguments || {}) });
    return;
  }
  if (method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        resources: [
          {
            uri: "nemeda://workspace/context",
            name: "Current workspace context",
            description: "Normalized Agent Kit context for the configured project directory.",
            mimeType: "application/json"
          },
          {
            uri: "nemeda://workspace/schema",
            name: "Agent Kit configuration schema",
            mimeType: "application/schema+json"
          }
        ]
      }
    });
    return;
  }
  if (method === "resources/read") {
    const resources = {
      "nemeda://workspace/context": resourceContext,
      "nemeda://workspace/schema": loadSchema
    };
    if (!resources[params.uri]) {
      send({ jsonrpc: "2.0", id, error: { code: -32002, message: `Resource not found: ${params.uri}` } });
      return;
    }
    const value = resources[params.uri]();
    send({
      jsonrpc: "2.0",
      id,
      result: { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] }
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } });
      }
    }
    newline = buffer.indexOf("\n");
  }
});
