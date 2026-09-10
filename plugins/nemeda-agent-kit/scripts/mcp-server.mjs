#!/usr/bin/env node
import { listTranscripts } from "./lib/meetings-core.mjs";
import { queryEntries } from "./lib/memory-index.mjs";
import {
  defaultWorkspaceDirectory,
  loadSchema,
  readWorkspaceContext,
  workspaceDoctor
} from "./lib/workspace.mjs";

const SERVER_INFO = { name: "nemeda-agent-kit", version: "0.3.0" };

const memoryFilterProperties = {
  type: { type: "string", enum: ["ai-interaction", "decision", "finding", "meeting"], description: "Restrict to one entry type." },
  author: { type: "string", description: "Restrict to one author's email." },
  status: { type: "string", enum: ["pending", "reviewed"], description: "Restrict to one review status." },
  since: { type: "string", description: "Only entries on or after this date (YYYY-MM-DD)." }
};

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
  },
  {
    name: "workspace_meetings",
    description: "List transcribed meetings (newest first) with title, date, duration, engine, the notes file when it exists, and a short excerpt. Use it to answer \"what did we discuss / decide in the meeting on …\" before searching the drive by hand; read the transcript or notes file it points at for the details.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Current repository or subdirectory." },
        query: { type: "string", description: "Case-insensitive text that must appear in the title or transcript." },
        since: { type: "string", description: "Only meetings recorded on or after this date (YYYY-MM-DD)." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 }
      },
      additionalProperties: false
    }
  },
  {
    name: "memory_search",
    description: "Full-text search this project's memory (session summaries, decisions, findings, meeting outcomes) across every author's journal. Search before proposing something that may already have been decided or found.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Current repository or subdirectory." },
        query: { type: "string", description: "Search text; omit or leave empty to just apply the filters." },
        ...memoryFilterProperties
      },
      additionalProperties: false
    }
  },
  {
    name: "memory_recent",
    description: "The most recent project memory entries, newest first, optionally filtered.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Current repository or subdirectory." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
        ...memoryFilterProperties
      },
      additionalProperties: false
    }
  },
  {
    name: "memory_get",
    description: "Read one project memory entry by id (its latest revision).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Current repository or subdirectory." },
        id: { type: "string", description: "Entry id, as returned by memory_search, memory_recent, or `nemeda-agent memory list`." }
      },
      required: ["id"],
      additionalProperties: false
    }
  }
];

// Shared by every memory_* tool: answers through the machine-local index
// (scripts/lib/memory-index.mjs), which rebuilds itself from the journals
// when they change and falls back to reading them directly if the index
// engine fails. The journals are never written here — same read-only trust
// boundary as workspace_context/doctor (the index cache under
// .nemeda/state/ is local, disposable state, not project content). Returns a
// clear `error` string, not a thrown exception, when memory is not
// configured, so a tool call always gets a JSON answer.
function loadMemoryEntries(cwd, request = {}) {
  const context = readWorkspaceContext(cwd);
  if (context.mode !== "configured" || !context.config?.memory) {
    return { error: "No `memory` section in .nemeda/agent-kit.json for this repository; see docs/memory-plan.md." };
  }
  const answer = queryEntries(context.root, context.config, request);
  return { entries: answer.entries, engine: answer.engine, ...(answer.fallback ? { fallback: answer.fallback } : {}) };
}

function memoryFilters(args) {
  return { type: args.type, author: args.author, status: args.status, since: args.since };
}

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
  if (name === "workspace_meetings") {
    const context = readWorkspaceContext(cwd);
    if (context.mode !== "configured" || !context.config?.meetings) {
      return textResult({ error: "No `meetings` section in .nemeda/agent-kit.json for this repository; see docs/meeting-capture.md." }, true);
    }
    const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 20;
    return textResult({ transcripts: listTranscripts(context.root, context.config.meetings, { limit, since: args.since || null, query: args.query || "" }) });
  }
  if (name === "memory_search") {
    const { entries, error, engine, fallback } = loadMemoryEntries(cwd, { query: args.query || "", filters: memoryFilters(args) });
    if (error) return textResult({ error }, true);
    return textResult({ results: entries, engine, ...(fallback ? { fallback } : {}) });
  }
  if (name === "memory_recent") {
    const { entries, error, engine, fallback } = loadMemoryEntries(cwd, { filters: memoryFilters(args) });
    if (error) return textResult({ error }, true);
    const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 20;
    return textResult({ results: entries.slice(0, limit), engine, ...(fallback ? { fallback } : {}) });
  }
  if (name === "memory_get") {
    const { entries, error } = loadMemoryEntries(cwd);
    if (error) return textResult({ error }, true);
    const entry = entries.find((candidate) => candidate.id === args.id);
    return entry ? textResult(entry) : textResult({ error: `No memory entry with id ${args.id}.` }, true);
  }
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
