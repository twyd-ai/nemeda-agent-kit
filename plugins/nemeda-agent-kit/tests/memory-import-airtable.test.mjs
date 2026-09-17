// Phase 1b-iv (docs/memory-plan.md): `memory import-airtable` against a local
// node:http stand-in for the Airtable REST API — field mapping, Person →
// Team.Email, pagination, 429 retries, re-runs, the import journal, and a
// teammate reviewing an imported entry from their own journal.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { latestRevisions, readAllJournals } from "../scripts/lib/memory.mjs";
import { importAirtableKnowledgeLog, importJournalPath, mapKnowledgeLogRecord } from "../scripts/lib/memory-import-airtable.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "cli.mjs");
const execFileAsync = promisify(execFile);
const BASE = "appAcmeKnowLog123";
const TABLE_ID = "tblAcmeKnowLog123";
const KEY = "pat-test-key-never-printed";

const KNOWLEDGE_LOG = [
  {
    id: "recEntryOne000001",
    createdTime: "2026-08-24T10:00:00.000Z",
    fields: { Entry: "Claude Code (Opus 5) — 24/08/2026", Type: "AI Interaction", Status: "Reviewed", Person: ["recTeamAna0000001"], "AI Tool": "Claude Code", "AI Model": "claude-opus-5", Tags: ["architecture"], Summary: "Blockers of the pilot.", "Client Summary": "N/A — internal session.", Date: "2026-08-24" }
  },
  {
    id: "recEntryTwo000002",
    createdTime: "2026-07-21T09:00:00.000Z",
    fields: { Entry: "Widget baseline", Type: "Code / PR", Status: "Incorporated", "AI Tool": "N/A", Summary: "Frontend widget baseline.", "Client Summary": "Widget base ready.", "GitHub Link": "https://github.com/acme/app/pull/7", "Visible to Acme": true, Date: "2026-07-21" }
  },
  {
    id: "recEntryThree0003",
    createdTime: "2026-07-22T18:30:00.000Z",
    fields: { Entry: "Motor session", Type: "Code / PR", Status: "Pending", Person: ["recTeamBob0000002"], "AI Tool": "Claude Code", Summary: "Retrieval tuning, four levers ruled out." }
  },
  {
    id: "recEntryFour00004",
    createdTime: "2026-08-01T08:00:00.000Z",
    fields: { Entry: "Kick-off", Type: "Meeting", Status: "Reviewed", Person: ["recTeamGone000009"], Summary: "Kick-off with the client." }
  },
  {
    id: "recEntryFive00005",
    createdTime: "2026-08-02T08:00:00.000Z",
    fields: { Entry: "Empty decision", Type: "Decision", Status: "Reviewed" }
  }
];
const TEAM = [
  { id: "recTeamAna0000001", createdTime: "2026-07-01T00:00:00.000Z", fields: { Name: "Ana", Email: " Ana@Acme.io " } },
  { id: "recTeamBob0000002", createdTime: "2026-07-01T00:00:00.000Z", fields: { Name: "Bob", Email: "bob@acme.io" } }
];

// Serves the Knowledge Log under both its name and TABLE_ID in two pages, the
// Team table in one, and optionally a 429 before the first page.
function startAirtable({ rateLimitOnce = false } = {}) {
  const state = { requests: [], limited: false };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://stub");
    state.requests.push({ path: url.pathname, offset: url.searchParams.get("offset"), auth: request.headers.authorization });
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${KEY}`) return reply(401, { error: { type: "AUTHENTICATION_REQUIRED" } });
    const [, version, base, table] = url.pathname.split("/");
    if (version !== "v0" || base !== BASE) return reply(404, { error: { type: "NOT_FOUND" } });
    const name = decodeURIComponent(table);
    if (name === "Team") return reply(200, { records: TEAM });
    if (name !== "Knowledge Log" && name !== TABLE_ID) return reply(404, { error: { type: "TABLE_NOT_FOUND" } });
    if (rateLimitOnce && !state.limited) {
      state.limited = true;
      return reply(429, { error: { type: "RATE_LIMIT" } });
    }
    return url.searchParams.get("offset") === "page2"
      ? reply(200, { records: KNOWLEDGE_LOG.slice(3) })
      : reply(200, { records: KNOWLEDGE_LOG.slice(0, 3), offset: "page2" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        })
      });
    });
  });
}

function workspace(extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-import-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  const config = {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "backend", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    memory: { project: { path: "memory" } },
    ...extra
  };
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "importer@acme.io"], { cwd: root });
  return { root, config };
}

const fast = { retryDelayMs: 5 };

test("a Knowledge Log record maps to an entry: type, status, author, AI, client summary, links", () => {
  const emailsByPersonId = new Map([["recTeamAna0000001", "ana@acme.io"]]);
  const context = { baseId: BASE, table: "Knowledge Log", project: "acme", emailsByPersonId, fallbackAuthor: "importer@acme.io" };
  const one = mapKnowledgeLogRecord(KNOWLEDGE_LOG[0], context).entry;
  assert.equal(one.type, "ai-interaction");
  assert.equal(one.status, "reviewed");
  assert.equal(one.author, "ana@acme.io");
  assert.deepEqual(one.ai, { tool: "Claude Code", model: "claude-opus-5" });
  assert.equal(one.clientSummary, null, "N/A client summaries are dropped");
  assert.equal(one.createdAt, "2026-08-24T10:00:00.000Z");
  assert.deepEqual(one.source, { kind: "airtable", baseId: BASE, table: "Knowledge Log", recordId: "recEntryOne000001", airtableType: "AI Interaction", airtableStatus: "Reviewed" });

  const two = mapKnowledgeLogRecord(KNOWLEDGE_LOG[1], context).entry;
  assert.equal(two.type, "finding", "Code / PR without an AI tool is a human finding");
  assert.equal(two.status, "reviewed", "Incorporated counts as reviewed");
  assert.equal(two.author, "importer@acme.io");
  assert.equal(two.ai, undefined);
  assert.equal(two.clientSummary, "Widget base ready.");
  assert.equal(two.source.prUrl, "https://github.com/acme/app/pull/7");
  assert.equal(two.source.clientVisible, true);
  assert.equal(two.source.personUnresolved, true);

  const three = mapKnowledgeLogRecord(KNOWLEDGE_LOG[2], context).entry;
  assert.equal(three.type, "ai-interaction", "Code / PR with an AI tool is an AI session");
  assert.equal(three.status, "pending");
  assert.equal(three.date, "2026-07-22", "no Date falls back to the record's creation day");

  assert.deepEqual(mapKnowledgeLogRecord(KNOWLEDGE_LOG[4], context), { skipped: "no Summary" });
  assert.match(mapKnowledgeLogRecord(KNOWLEDGE_LOG[1], { ...context, fallbackAuthor: "" }).skipped, /no Person with an Email/);
});

test("import-airtable reads every page and the Team table, writes one import journal, and re-runs import nothing", async () => {
  const airtable = await startAirtable({ rateLimitOnce: true });
  try {
    const { root, config } = workspace();
    const options = { baseId: BASE, apiKey: KEY, fallbackAuthor: "importer@acme.io", apiUrl: airtable.url, ...fast };

    const dry = await importAirtableKnowledgeLog(root, config, { ...options, dryRun: true });
    assert.equal(dry.fetched, 5);
    assert.equal(dry.imported.length, 4);
    assert.equal(existsSync(importJournalPath(path.join(root, "memory"), BASE)), false, "a dry run writes nothing");
    assert.ok(airtable.state.limited, "the 429 was retried");

    const report = await importAirtableKnowledgeLog(root, config, options);
    assert.deepEqual(report.imported.map((item) => item.recordId), ["recEntryTwo000002", "recEntryThree0003", "recEntryFour00004", "recEntryOne000001"], "oldest first");
    assert.deepEqual(report.skipped, [{ recordId: "recEntryFive00005", reason: "no Summary" }]);
    assert.deepEqual(report.unresolvedAuthors.sort(), ["recEntryFour00004", "recEntryTwo000002"]);
    assert.deepEqual(report.counts, { reviewed: 3, pending: 1, byAuthor: { "importer@acme.io": 2, "bob@acme.io": 1, "ana@acme.io": 1 } });
    const journalLines = readFileSync(report.journal, "utf8").trim().split("\n");
    assert.equal(journalLines.length, 4);
    assert.equal(path.basename(report.journal), `import-airtable-${BASE}.jsonl`);
    assert.ok(airtable.state.requests.every((request) => request.auth === `Bearer ${KEY}`));
    assert.ok(airtable.state.requests.some((request) => request.offset === "page2"), "pagination followed the offset");

    const again = await importAirtableKnowledgeLog(root, config, options);
    assert.equal(again.imported.length, 0);
    assert.equal(again.alreadyImported, 4);
    assert.equal(readFileSync(report.journal, "utf8").trim().split("\n").length, 4);
  } finally {
    await airtable.close();
  }
});

test("import-airtable takes the base and table from airtable.knowledgeLog, and refuses a bad key without printing it", async () => {
  const airtable = await startAirtable();
  try {
    const { root, config } = workspace({ airtable: { baseId: BASE, knowledgeLog: { tableId: TABLE_ID } } });
    const report = await importAirtableKnowledgeLog(root, config, { apiKey: KEY, fallbackAuthor: "importer@acme.io", apiUrl: airtable.url, ...fast });
    assert.equal(report.table, TABLE_ID);
    assert.equal(report.imported.length, 4);
    await assert.rejects(
      importAirtableKnowledgeLog(root, config, { apiKey: "wrong-secret-key", fallbackAuthor: "importer@acme.io", apiUrl: airtable.url, ...fast }),
      (error) => /rejected AIRTABLE_API_KEY/.test(error.message) && !error.message.includes("wrong-secret-key")
    );
    await assert.rejects(importAirtableKnowledgeLog(workspace().root, workspace().config, { apiKey: KEY, apiUrl: airtable.url }), /Which Airtable base/);
  } finally {
    await airtable.close();
  }
});

test("through the CLI, and a teammate reviews an imported entry from their own journal", async () => {
  const airtable = await startAirtable();
  try {
    const { root } = workspace();
    const env = { ...process.env, AIRTABLE_API_KEY: KEY, NEMEDA_AIRTABLE_API_URL: airtable.url };
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "memory", "import-airtable", "--base", BASE, "--json", "--cwd", root], { env, encoding: "utf8" });
    const report = JSON.parse(stdout);
    assert.equal(report.imported.length, 4);
    assert.equal(stdout.includes(KEY), false);

    const bobsEntry = report.imported.find((item) => item.author === "bob@acme.io");
    const reviewed = JSON.parse(execFileSync(process.execPath, [cliPath, "memory", "review", bobsEntry.id, "--json", "--cwd", root], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, NEMEDA_MEMORY_AUTHOR: "bob@acme.io" }
    }));
    assert.equal(reviewed.revision, 2);
    const memoryRoot = path.join(root, "memory");
    assert.ok(existsSync(path.join(memoryRoot, "journal", "bob@acme.io.jsonl")), "the revision lands in Bob's own journal");
    const latest = latestRevisions(readAllJournals(memoryRoot).entries).find((entry) => entry.id === bobsEntry.id);
    assert.equal(latest.status, "reviewed");
    assert.equal(latest.source.recordId, "recEntryThree0003");
  } finally {
    await airtable.close();
  }
});
