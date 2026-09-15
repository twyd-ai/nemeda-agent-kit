// A stand-in for nemeda-memory-service, shared by the central-memory tests:
// /health, /whoami, /promote (entries and digests, per-row errors for an
// unregistered project), and a Streamable HTTP /mcp that assigns a session
// id and answers in JSON or SSE. It is the kit's executable reading of the
// contract in docs/memory-plan.md, "Service endpoints the kit uses".
import http from "node:http";

export const STUB_TOKEN = "stub-secret-token";

export function startStub({ projects = ["acme"], sse = false, token = STUB_TOKEN } = {}) {
  const state = { rows: new Map(), digests: new Map(), requests: [] };
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
    if (request.headers.authorization !== `Bearer ${token}`) return reply(401, { detail: "invalid token" });
    if (request.url === "/whoami") return reply(200, { email: "ana@example.com", projects: ["*"], canPromote: true });
    if (request.url === "/promote" && request.method === "POST") {
      const entries = { inserted: [], existing: [] };
      const digests = { inserted: [], existing: [] };
      const errors = [];
      for (const row of body.entries || []) {
        if (!projects.includes(row.project_id)) {
          errors.push({ id: row.id, revision: row.revision, code: "unknown-project", message: `no project ${row.project_id}` });
          continue;
        }
        const key = `${row.id}:${row.revision}`;
        if (state.rows.has(key)) entries.existing.push({ id: row.id, revision: row.revision });
        else {
          state.rows.set(key, row);
          entries.inserted.push({ id: row.id, revision: row.revision });
        }
      }
      for (const row of body.digests || []) {
        if (!projects.includes(row.project_id)) {
          errors.push({ id: row.id, code: "unknown-project", message: `no project ${row.project_id}` });
          continue;
        }
        if (state.digests.has(row.id)) digests.existing.push(row.id);
        else {
          state.digests.set(row.id, row);
          digests.inserted.push(row.id);
        }
      }
      return reply(200, { entries, digests, errors });
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
