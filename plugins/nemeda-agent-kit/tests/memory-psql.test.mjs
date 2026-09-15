// Phase 3c (docs/memory-plan.md): `memory sync --via psql` and the
// memory-psql / memory-grants doctor rows, against a stub `psql` that
// records what it receives and answers like the contract database would.
// One optional test runs against a real database when NEMEDA_PSQL_TEST_URL
// points at a writer role on a database with the contract migrations
// applied and a registered project "acme".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appendEntry, createEntry, reviseEntry } from "../scripts/lib/memory.mjs";
import { createDigest, writeDigest } from "../scripts/lib/memory-digest.mjs";
import { connectionEnvironment, describeConnection, dollarQuote, psqlDoctorChecks } from "../scripts/lib/memory-psql.mjs";
import { readSyncState, syncToCentral } from "../scripts/lib/memory-sync.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "scripts", "cli.mjs");
const SECRET = "s3cret-pass";
const DB_URL = `postgresql://ana_admin:${SECRET}@db.example.ts.net:5433/memoria_central?sslmode=require`;

// A CommonJS stub `psql`: logs each call (args, stdin, the PG* variables it
// got) and answers the version, schema_version, grants, and promote
// queries. Rows for project "ghost" come back as unknown; ids listed in
// STUB_EXISTING are treated as already present.
function stubPsql({ schemaVersion = "1", grants } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "nemeda-stub-psql-"));
  const log = path.join(dir, "calls.jsonl");
  const file = path.join(dir, "psql");
  const defaultGrants = { user: "ana_admin", superuser: false, missingSelect: [], missingInsert: [], broader: [], insertRegistry: [], createInSchema: false };
  writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("psql (PostgreSQL) 16.4"); process.exit(0); }
const sql = fs.readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PG")));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, sql, env }) + "\\n");
if (sql.includes("schema_version")) { console.log(${JSON.stringify(schemaVersion)}); process.exit(0); }
if (sql.includes("has_table_privilege")) { console.log(${JSON.stringify(JSON.stringify(grants || defaultGrants))}); process.exit(0); }
const match = /\\$(nemeda_[0-9a-f]+)\\$([\\s\\S]*?)\\$\\1\\$/.exec(sql);
const rows = JSON.parse(match[2]);
const existing = new Set((process.env.STUB_EXISTING || "").split(",").filter(Boolean));
const known = rows.filter((row) => row.project_id !== "ghost");
const unknown = rows.filter((row) => row.project_id === "ghost");
if (sql.includes(".entries")) {
  console.log(JSON.stringify({ inserted: known.filter((row) => !existing.has(row.id)).map((row) => ({ id: row.id, revision: row.revision })), unknown: unknown.map((row) => ({ id: row.id, revision: row.revision, project: row.project_id })) }));
} else {
  console.log(JSON.stringify({ inserted: known.filter((row) => !existing.has(row.id)).map((row) => row.id), unknown: unknown.map((row) => ({ id: row.id, project: row.project_id })) }));
}
`);
  chmodSync(file, 0o755);
  return { file, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []) };
}

function workspace(central) {
  const root = mkdtempSync(path.join(tmpdir(), "nemeda-psql-"));
  mkdirSync(path.join(root, ".nemeda"), { recursive: true });
  const config = {
    schemaVersion: 1,
    project: { id: "acme", name: "Acme" },
    repository: { id: "acme", role: "backend", profiles: [] },
    context: { instructions: ["AGENTS.md"] },
    tools: { required: [], optional: [] },
    policies: { protectSecrets: true },
    memory: { project: { path: "memory" }, central: { urlVariable: "NEMEDA_MEMORY_DB_URL", ...central } }
  };
  writeFileSync(path.join(root, ".nemeda", "agent-kit.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "AGENTS.md"), "# Acme\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "ana@example.com"], { cwd: root });
  return { root, config };
}

function seed(root) {
  const memoryRoot = path.join(root, "memory");
  const draft = appendEntry(memoryRoot, createEntry({ project: "acme", type: "decision", title: "Use bge-m3", author: "ana@example.com", summary: "It's the one: $$ and quotes ' survive.", tags: ["rag"] }));
  const reviewed = appendEntry(memoryRoot, reviseEntry(draft, { status: "reviewed" }));
  const digest = createDigest({ project: "acme", period: "2026-Q3", body: "## Decided\nUse bge-m3.", generatedBy: "ana@example.com" });
  writeDigest(memoryRoot, digest);
  return { reviewed, digest };
}

function environmentWith(stub, extra = {}) {
  return { ...process.env, NEMEDA_HOME: mkdtempSync(path.join(tmpdir(), "nemeda-home-")), NEMEDA_PSQL_BIN: stub.file, NEMEDA_MEMORY_DB_URL: DB_URL, PGSERVICE: "stray", ...extra };
}

test("a connection string becomes libpq variables, and descriptions never show the password", () => {
  const environment = connectionEnvironment("postgresql://ana%40x:p%3Ass@db.example.ts.net:5433/memoria_central?sslmode=require&application_name=kit");
  assert.deepEqual(environment, { PGHOST: "db.example.ts.net", PGPORT: "5433", PGUSER: "ana@x", PGPASSWORD: "p:ss", PGDATABASE: "memoria_central", PGSSLMODE: "require", PGAPPNAME: "kit" });
  assert.equal(describeConnection(DB_URL), "ana_admin@db.example.ts.net:5433/memoria_central");
  assert.throws(() => connectionEnvironment("mysql://x@y/z"), /postgres:\/\//);
  const quoted = dollarQuote("a $nemeda_x$ b");
  const tag = /^\$(nemeda_[0-9a-f]+)\$/.exec(quoted)[1];
  assert.ok(quoted.endsWith(`$${tag}$`));
  assert.equal(quoted.slice(tag.length + 2, -(tag.length + 2)), "a $nemeda_x$ b");
});

test("memory sync --via psql writes entries then digests, with the secret only in the child's environment", async () => {
  const stub = stubPsql();
  const { root, config } = workspace();
  const { reviewed, digest } = seed(root);
  const report = await syncToCentral(root, config, { via: "psql", environment: environmentWith(stub) });
  assert.equal(report.via, "psql");
  assert.deepEqual(report.inserted, [{ id: reviewed.id, revision: 2 }]);
  assert.deepEqual(report.digests.inserted, [digest.id]);
  assert.equal(readSyncState(root).promoted[reviewed.id], 2);

  const calls = stub.calls();
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /schema_version/);
  assert.match(calls[1].sql, /insert into "nemeda_memory"\.entries/);
  assert.match(calls[2].sql, /insert into "nemeda_memory"\.digests/);
  for (const call of calls) {
    assert.equal(call.args.join(" ").includes(SECRET), false, "the password never reaches the command line");
    assert.equal(call.sql.includes(SECRET), false, "nor the SQL");
    assert.equal(call.env.PGPASSWORD, SECRET);
    assert.equal(call.env.PGSERVICE, undefined, "inherited PG* variables are dropped");
    assert.equal(call.env.PGAPPNAME, "nemeda-agent-kit");
  }
  const row = JSON.parse(/\$(nemeda_[0-9a-f]+)\$([\s\S]*?)\$\1\$/.exec(calls[1].sql)[2])[0];
  assert.equal(row.promoted_by, "ana@example.com");
  assert.equal(row.summary, "It's the one: $$ and quotes ' survive.");

  const again = await syncToCentral(root, config, { via: "psql", environment: environmentWith(stub) });
  assert.equal(again.candidates.length + again.digests.candidates.length, 0);
});

test("--via psql reports unregistered projects per row, counts existing rows, and refuses an unknown contract", async () => {
  const stub = stubPsql();
  const ghost = workspace({ projectId: "ghost" });
  seed(ghost.root);
  const refused = await syncToCentral(ghost.root, ghost.config, { via: "psql", environment: environmentWith(stub) });
  assert.deepEqual(refused.inserted, []);
  assert.deepEqual(refused.errors.map((error) => error.code), ["unknown-project", "unknown-project"]);
  assert.match(refused.errors[0].message, /register-projects\.sh ghost/);

  const { root, config } = workspace();
  const { reviewed } = seed(root);
  const existing = await syncToCentral(root, config, { via: "psql", environment: environmentWith(stub, { STUB_EXISTING: reviewed.id }) });
  assert.deepEqual(existing.existing, [{ id: reviewed.id, revision: 2 }]);

  const future = workspace();
  seed(future.root);
  await assert.rejects(syncToCentral(future.root, future.config, { via: "psql", environment: environmentWith(stubPsql({ schemaVersion: "2" })) }), /contract version 2/);
  await assert.rejects(syncToCentral(future.root, future.config, { via: "psql", environment: { ...environmentWith(stub), NEMEDA_MEMORY_DB_URL: "" } }), /No connection string: set NEMEDA_MEMORY_DB_URL/);
  await assert.rejects(syncToCentral(future.root, future.config, { environment: environmentWith(stub) }), /administrators can use `--via psql`/);
});

test("memory doctor's psql rows: version and contract, then exactly the grants the kit needs", () => {
  const { root, config } = workspace();
  const rows = (stub) => psqlDoctorChecks(root, config, { environment: environmentWith(stub) }).map((check) => [check.code, check.status]);
  assert.deepEqual(rows(stubPsql()), [["memory-psql", "pass"], ["memory-grants", "pass"]]);
  assert.deepEqual(rows(stubPsql({ grants: { user: "postgres", superuser: true, missingSelect: [], missingInsert: [], broader: ["entries UPDATE"], insertRegistry: ["projects"], createInSchema: true } })), [["memory-psql", "pass"], ["memory-grants", "warn"]]);
  assert.deepEqual(rows(stubPsql({ grants: { user: "reader", superuser: false, missingSelect: [], missingInsert: ["entries", "digests"], broader: [], insertRegistry: [], createInSchema: false } })), [["memory-psql", "pass"], ["memory-grants", "fail"]]);
  const missing = psqlDoctorChecks(root, config, { environment: { ...environmentWith(stubPsql()), NEMEDA_PSQL_BIN: path.join(tmpdir(), "no-such-psql") } });
  assert.equal(missing[0].status, "fail");
  assert.match(missing[0].message, /psql is not available/);
});

test("memory sync --via psql through the real CLI", () => {
  const stub = stubPsql();
  const { root } = workspace();
  const { reviewed } = seed(root);
  const output = JSON.parse(execFileSync(process.execPath, [cliPath, "memory", "sync", "--via", "psql", "--json", "--cwd", root], { env: environmentWith(stub), encoding: "utf8" }));
  assert.deepEqual(output.inserted, [{ id: reviewed.id, revision: 2 }]);
  assert.match(output.endpoint, /psql \(NEMEDA_MEMORY_DB_URL\)/);
});

test("memory sync --via psql against a real contract database", { skip: !process.env.NEMEDA_PSQL_TEST_URL && "set NEMEDA_PSQL_TEST_URL to a writer role on a migrated database" }, async () => {
  const { root, config } = workspace();
  const { reviewed, digest } = seed(root);
  const environment = { ...process.env, NEMEDA_HOME: mkdtempSync(path.join(tmpdir(), "nemeda-home-")), NEMEDA_MEMORY_DB_URL: process.env.NEMEDA_PSQL_TEST_URL };
  const first = await syncToCentral(root, config, { via: "psql", environment });
  assert.deepEqual(first.inserted, [{ id: reviewed.id, revision: 2 }]);
  assert.deepEqual(first.digests.inserted, [digest.id]);
  assert.deepEqual(first.errors, []);

  // Forget the acknowledgements: the database itself must report the rows
  // as existing (ON CONFLICT DO NOTHING), never duplicate them.
  writeFileSync(path.join(root, ".nemeda", "state", "memory-sync.json"), "{}\n");
  const second = await syncToCentral(root, config, { via: "psql", environment });
  assert.deepEqual(second.inserted, []);
  assert.deepEqual(second.existing, [{ id: reviewed.id, revision: 2 }]);
  assert.deepEqual(second.digests.existing, [digest.id]);

  const ghost = workspace({ projectId: "ghost-project" });
  seed(ghost.root);
  const refused = await syncToCentral(ghost.root, ghost.config, { via: "psql", environment });
  assert.deepEqual(refused.errors.map((error) => error.code), ["unknown-project", "unknown-project"]);

  const checks = psqlDoctorChecks(root, config, { environment });
  assert.deepEqual(checks.map((check) => [check.code, check.status]), [["memory-psql", "pass"], ["memory-grants", "pass"]]);
});
