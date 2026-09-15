// The administrators' transport to central memory (docs/memory-plan.md,
// phase 3c): `memory sync --via psql` writes the contract tables directly
// through the `psql` CLI — for backfills, and for when the service is down.
// Zero dependencies, like every other external binary the kit drives.
//
// Secrets: the connection string never reaches a command line, where `ps`
// would show it; it is split into libpq's PG* variables for the child
// process only, and no message ever repeats it.
// Data: rows travel on stdin as one JSON document inside a dollar-quoted
// literal whose tag is checked absent from the payload, and are unpacked
// server-side with jsonb_to_recordset — values are never interpolated.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CENTRAL_CONTRACT_MAJOR, CentralError, centralSettings, resolvePersonalVariable } from "./memory-central.mjs";

export const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const LIBPQ_QUERY_PARAMETERS = {
  sslmode: "PGSSLMODE",
  sslrootcert: "PGSSLROOTCERT",
  sslcert: "PGSSLCERT",
  sslkey: "PGSSLKEY",
  connect_timeout: "PGCONNECT_TIMEOUT",
  application_name: "PGAPPNAME",
  target_session_attrs: "PGTARGETSESSIONATTRS"
};

export function psqlBinary(environment = process.env) {
  return environment.NEMEDA_PSQL_BIN || "psql";
}

function parseConnectionString(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || !["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new CentralError("psql-config", "The connection string is not a postgres:// or postgresql:// URL.");
  }
  return parsed;
}

// libpq environment variables for one connection string.
export function connectionEnvironment(url) {
  const parsed = parseConnectionString(url);
  const environment = {};
  if (parsed.hostname) environment.PGHOST = decodeURIComponent(parsed.hostname).replace(/^\[|\]$/g, "");
  if (parsed.port) environment.PGPORT = parsed.port;
  if (parsed.username) environment.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) environment.PGPASSWORD = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database) environment.PGDATABASE = database;
  for (const [key, value] of parsed.searchParams) {
    if (LIBPQ_QUERY_PARAMETERS[key]) environment[LIBPQ_QUERY_PARAMETERS[key]] = value;
  }
  return environment;
}

// user@host:port/database — for messages; never the password.
export function describeConnection(url) {
  const parsed = parseConnectionString(url);
  const user = parsed.username ? `${decodeURIComponent(parsed.username)}@` : "";
  return `${user}${parsed.hostname || "localhost"}${parsed.port ? `:${parsed.port}` : ""}/${decodeURIComponent(parsed.pathname.replace(/^\//, ""))}`;
}

// The connection for `--via psql`: the administrator's connection string
// from the variable named by memory.central.urlVariable.
export function psqlConnection(root, settings, environment = process.env) {
  if (!settings?.urlVariable) {
    throw new CentralError("psql-config", "memory.central.urlVariable is not set; `--via psql` needs the name of the variable holding an administrator's connection string.");
  }
  if (!SCHEMA_NAME_PATTERN.test(settings.schema)) throw new CentralError("psql-config", "memory.central.schema must be a plain lower-case identifier.");
  const { value } = resolvePersonalVariable(root, settings.urlVariable, environment);
  if (!value) throw new CentralError("psql-config", `No connection string: set ${settings.urlVariable} in .env.local (administrators only; never committed).`);
  return { schema: settings.schema, environment: connectionEnvironment(value), label: describeConnection(value) };
}

export function dollarQuote(text) {
  let tag;
  do tag = `nemeda_${randomBytes(6).toString("hex")}`;
  while (text.includes(`$${tag}$`));
  return `$${tag}$${text}$${tag}$`;
}

// Runs one SQL script (on stdin) and returns its trimmed output: -X skips
// ~/.psqlrc, -A -t print bare values, ON_ERROR_STOP turns any SQL error into
// a non-zero exit. Inherited PG* variables are dropped so a stray PGSERVICE
// or PGOPTIONS cannot redirect the connection.
export function runPsql(connection, sql, { environment = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const childEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^PG[A-Z_]+$/.test(key)));
  Object.assign(childEnvironment, { PGAPPNAME: "nemeda-agent-kit" }, connection.environment);
  const result = spawnSync(psqlBinary(environment), ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: childEnvironment
  });
  if (result.error) {
    throw new CentralError("psql-missing", `psql could not be started (${result.error.message}); install it (brew install libpq, apt install postgresql-client, or the Windows installer) or set NEMEDA_PSQL_BIN.`);
  }
  if (result.signal === "SIGTERM" && result.status === null) throw new CentralError("psql-failed", `psql timed out after ${timeoutMs}ms on ${connection.label}.`);
  if (result.status !== 0) throw new CentralError("psql-failed", `psql failed on ${connection.label}: ${String(result.stderr || "").trim().slice(0, 500)}`);
  return String(result.stdout || "").trim();
}

function table(connection, name) {
  return `"${connection.schema}".${name}`;
}

// Refuses to write to a database whose contract major version this kit
// does not know — the same rule as the service's /health check.
export function checkSchemaVersion(connection, options = {}) {
  const output = runPsql(connection, `select value from ${table(connection, "meta")} where key = 'schema_version';\n`, options);
  const major = Number.parseInt(output, 10);
  if (!Number.isInteger(major)) throw new CentralError("psql-contract", `${connection.label}: ${connection.schema}.meta has no schema_version; is this the central memory database?`);
  if (major !== CENTRAL_CONTRACT_MAJOR) {
    throw new CentralError("psql-contract", `${connection.label} is at contract version ${major}; this kit knows ${CENTRAL_CONTRACT_MAJOR}. Update the plugin before syncing.`);
  }
  return major;
}

function parseAnswer(output, what) {
  try {
    return JSON.parse(output.split("\n").pop());
  } catch {
    throw new CentralError("psql-failed", `${what}: psql answered with something that is not JSON.`);
  }
}

// One batch of entry rows (the contract columns, as memory-sync.mjs builds
// them) plus promoted_by. Rows for a project missing from the registry are
// not inserted and come back as per-row errors, like the service does,
// instead of one foreign-key violation aborting the batch.
function promoteEntries(connection, rows, promotedBy, options) {
  const payload = dollarQuote(JSON.stringify(rows.map((row) => ({ ...row, promoted_by: promotedBy }))));
  const known = `exists (select 1 from ${table(connection, "projects")} p where p.id = incoming.project_id)`;
  const sql = `with incoming as (
  select * from jsonb_to_recordset(${payload}::jsonb) as r(
    id text, revision integer, project_id text, repository_id text, type text, title text,
    entry_date date, author_email text, ai_tool text, ai_model text, tags jsonb, summary text,
    client_summary text, status text, source jsonb, language text, created_at timestamptz, promoted_by text)
), inserted as (
  insert into ${table(connection, "entries")} (id, revision, project_id, repository_id, type, title, entry_date, author_email,
    ai_tool, ai_model, tags, summary, client_summary, status, source, language, created_at, promoted_by)
  select id, revision, project_id, repository_id, type, title, entry_date, author_email,
    ai_tool, ai_model, array(select jsonb_array_elements_text(coalesce(tags, '[]'::jsonb))), summary, client_summary, status,
    coalesce(source, '{}'::jsonb), language, created_at, promoted_by
  from incoming
  where ${known}
  on conflict (id, revision) do nothing
  returning id, revision
)
select json_build_object(
  'inserted', coalesce((select json_agg(json_build_object('id', id, 'revision', revision)) from inserted), '[]'::json),
  'unknown', coalesce((select json_agg(json_build_object('id', id, 'revision', revision, 'project', project_id)) from incoming where not ${known}), '[]'::json)
);
`;
  return parseAnswer(runPsql(connection, sql, options), "entries");
}

function promoteDigests(connection, rows, options) {
  const payload = dollarQuote(JSON.stringify(rows));
  const known = `exists (select 1 from ${table(connection, "projects")} p where p.id = incoming.project_id)`;
  const sql = `with incoming as (
  select * from jsonb_to_recordset(${payload}::jsonb) as r(
    id text, scope text, project_id text, period text, body text, generated_by text, kind text, created_at timestamptz)
), inserted as (
  insert into ${table(connection, "digests")} (id, scope, project_id, period, body, generated_by, kind, created_at)
  select id, scope, project_id, period, body, generated_by, kind, coalesce(created_at, now())
  from incoming
  where ${known}
  on conflict (id) do nothing
  returning id
)
select json_build_object(
  'inserted', coalesce((select json_agg(id) from inserted), '[]'::json),
  'unknown', coalesce((select json_agg(json_build_object('id', id, 'project', project_id)) from incoming where not ${known}), '[]'::json)
);
`;
  return parseAnswer(runPsql(connection, sql, options), "digests");
}

function unknownProjectError(item) {
  return {
    id: item.id,
    ...(item.revision ? { revision: item.revision } : {}),
    code: "unknown-project",
    message: `project ${item.project} is not registered; run scripts/register-projects.sh ${item.project} in nemeda-memory-service`
  };
}

// Same answer shape as the service's POST /promote, so memory-sync.mjs
// treats both transports identically. "existing" is whatever was sent,
// known, and not inserted — ON CONFLICT DO NOTHING skipped it.
export function promoteViaPsql(connection, { entries = [], digests = [], promotedBy }, options = {}) {
  const answer = { entries: { inserted: [], existing: [] }, digests: { inserted: [], existing: [] }, errors: [] };
  if (entries.length) {
    const result = promoteEntries(connection, entries, promotedBy, options);
    const inserted = new Set(result.inserted.map((item) => `${item.id}:${item.revision}`));
    const unknown = new Set(result.unknown.map((item) => `${item.id}:${item.revision}`));
    answer.entries.inserted = result.inserted;
    answer.entries.existing = entries
      .filter((row) => !inserted.has(`${row.id}:${row.revision}`) && !unknown.has(`${row.id}:${row.revision}`))
      .map((row) => ({ id: row.id, revision: row.revision }));
    answer.errors.push(...result.unknown.map(unknownProjectError));
  }
  if (digests.length) {
    const result = promoteDigests(connection, digests, options);
    const inserted = new Set(result.inserted);
    const unknown = new Set(result.unknown.map((item) => item.id));
    answer.digests.inserted = result.inserted;
    answer.digests.existing = digests.map((row) => row.id).filter((id) => !inserted.has(id) && !unknown.has(id));
    answer.errors.push(...result.unknown.map(unknownProjectError));
  }
  return answer;
}

// What the connected role may do on the contract tables. The kit needs
// SELECT on the four tables and INSERT on entries and digests, nothing more.
export function checkGrants(connection, options = {}) {
  const schema = `'${connection.schema}'`;
  const on = (tableName, privilege) => `has_table_privilege(format('%I.%I', ${schema}, ${tableName}), '${privilege}')`;
  const sql = `select json_build_object(
  'user', current_user,
  'superuser', (select rolsuper from pg_roles where rolname = current_user),
  'missingSelect', coalesce((select json_agg(t) from unnest(array['meta', 'projects', 'entries', 'digests']) t where not ${on("t", "SELECT")}), '[]'::json),
  'missingInsert', coalesce((select json_agg(t) from unnest(array['entries', 'digests']) t where not ${on("t", "INSERT")}), '[]'::json),
  'broader', coalesce((select json_agg(t || ' ' || p) from unnest(array['meta', 'projects', 'entries', 'digests']) t
      cross join unnest(array['UPDATE', 'DELETE', 'TRUNCATE']) p where has_table_privilege(format('%I.%I', ${schema}, t), p)), '[]'::json),
  'insertRegistry', coalesce((select json_agg(t) from unnest(array['meta', 'projects']) t where ${on("t", "INSERT")}), '[]'::json),
  'createInSchema', has_schema_privilege(${schema}, 'CREATE')
);
`;
  return parseAnswer(runPsql(connection, sql, options), "grants");
}

// memory-psql and memory-grants rows for `nemeda-agent memory doctor`, only
// when memory.central.urlVariable is set. Never throws.
export function psqlDoctorChecks(root, config, { environment = process.env } = {}) {
  const settings = centralSettings(config);
  if (!settings?.urlVariable) return [];
  const checks = [];
  const version = spawnSync(psqlBinary(environment), ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (version.error || version.status !== 0) {
    checks.push({ status: "fail", code: "memory-psql", message: `psql is not available (${version.error?.message || `exit ${version.status}`}); install it (brew install libpq, apt install postgresql-client) or set NEMEDA_PSQL_BIN.` });
    return checks;
  }
  let connection;
  try {
    connection = psqlConnection(root, settings, environment);
  } catch (error) {
    checks.push({ status: "warn", code: "memory-psql", message: `${String(version.stdout).trim()} found, but ${error.message}` });
    return checks;
  }
  try {
    const major = checkSchemaVersion(connection, { environment });
    checks.push({ status: "pass", code: "memory-psql", message: `${String(version.stdout).trim()}; connected to ${connection.label}, contract ${major}.` });
  } catch (error) {
    checks.push({ status: "fail", code: "memory-psql", message: error.message });
    return checks;
  }
  try {
    const grants = checkGrants(connection, { environment });
    if (grants.missingSelect.length || grants.missingInsert.length) {
      const missing = [...grants.missingSelect.map((name) => `SELECT on ${name}`), ...grants.missingInsert.map((name) => `INSERT on ${name}`)];
      checks.push({ status: "fail", code: "memory-grants", message: `${grants.user} lacks ${missing.join(", ")}; it needs to be in nemeda_memory_writer.` });
    } else if (grants.superuser || grants.broader.length || grants.insertRegistry.length || grants.createInSchema) {
      const extra = [
        ...(grants.superuser ? ["superuser"] : []),
        ...grants.broader,
        ...grants.insertRegistry.map((name) => `INSERT ${name}`),
        ...(grants.createInSchema ? [`CREATE in ${connection.schema}`] : [])
      ];
      checks.push({ status: "warn", code: "memory-grants", message: `${grants.user} can also ${extra.join(", ")}; the kit needs only SELECT and INSERT on entries/digests, so use a personal role in nemeda_memory_writer.` });
    } else {
      checks.push({ status: "pass", code: "memory-grants", message: `${grants.user} has exactly what the kit needs: SELECT on the contract, INSERT on entries and digests.` });
    }
  } catch (error) {
    checks.push({ status: "fail", code: "memory-grants", message: error.message });
  }
  return checks;
}
