# Knowledge memory plan

Status: design, not implemented. Target release: 0.4.0 (project layer),
0.5.0 (central layer). Supersedes `airtable.knowledgeLog`.

Goal: replace the Airtable Knowledge Log with a memory layer the kit owns end
to end, usable in environments where Airtable does not exist, and split it in
two levels:

- **Project memory** — what one project learned: AI session summaries,
  decisions, findings, meeting outcomes. Shared by the project team through
  the project's shared drive, queryable from every agent session.
- **Central memory** — the company-wide layer: reviewed entries promoted from
  every project plus periodic recaps, stored in PostgreSQL, exposed through
  MCP, and designed so a RAG service can be put on top of it later without a
  second migration.

Airtable task sync (`airtable.tasks`, the PR reconciler) is a separate concern
and is *not* touched by this plan; see "Open questions".

## Today

- The reviewed flow is a Drive command (`commands/klog.md`, per project) that
  asks the agent to segment the session by model, propose one entry per
  segment, wait for confirmation, then create records through the Airtable
  MCP with hard-coded base, table, and person ids.
- The unattended flow is the Stop hook `session-log.mjs`
  (`KNOWLEDGE_LOG_AUTO=true`): one `Pending` record per session with git
  context, to be completed later in Airtable.
- Meeting notes go through a second Drive command (`meeting-summary.md`) that
  produces an entry by hand.
- Fields, as provisioned by `airtable-provision.mjs`: Entry, Date, Type
  (AI Interaction | Decision | Finding | Meeting), AI Tool, AI Model, Status
  (Pending | Reviewed), Summary, Person (link to Team). Projects add Tags,
  Workstream, and Client Summary on their own.

What works and must survive: the reviewed, confirm-before-write flow; one
entry per model segment; the internal/client summary split; the `Pending`
inbox for unattended entries; the per-person attribution.

What must go: Airtable ids in config and commands, the people table, the
per-project fork of the command, the dependency on the Airtable MCP.

## Constraints

1. Zero dependencies, as everywhere in the kit. No SQLite or PostgreSQL
   driver in `package.json`.
2. The kit's MCP server stays read-only (trust model in `architecture.md`).
   Writes happen through the CLI and skills the operator runs and confirms.
3. Project memory must work offline and on a fresh machine after
   `nemeda-agent setup`; central memory is optional and degrades to "not
   configured", never to an error.
4. No secrets in `.nemeda/agent-kit.json`: connection strings and tokens live
   in `.env.local`, config only names the variable.
5. Same entry shape at both levels so promotion is a copy, not a mapping.

## Storage design

### Project memory: journals on the drive, SQLite as the index

The obvious layout — one `project.sqlite` file in a Drive folder that every
teammate opens read/write — does not survive cloud sync clients. Google Drive
for desktop and OneDrive sync whole files, do not honour SQLite's byte-range
locks across machines, and either produce "conflicted copy" duplicates or
corrupt the database when two people write in the same sync window; WAL mode
makes it worse (`-wal`/`-shm` side files get synced out of order). The same
warning applies to any file two machines write concurrently.

So the source of truth is **append-only, per-author journals**, which sync
clients handle perfectly because each file has exactly one writer:

```text
<shared drive>/memory/
├── README.md                       # filing conventions, written by setup
├── journal/
│   ├── miquel@nemeda.io.jsonl      # one line per entry or revision
│   ├── artur.cot@nemeda.io.jsonl
│   └── ...
└── digests/                        # optional recaps (see central layer)
    └── 2026-Q3.md
```

- One JSONL file per `git config user.email`; the kit only ever appends to
  the file of the person running it. Revisions (review, tag change) are new
  lines with the same `id` and a later `revision`; the newest wins.
- **SQLite is the query layer**, rebuilt from the journals on demand and kept
  in the machine-local `.nemeda/state/memory.sqlite` (never on the drive):
  full-text search (FTS5), filters by type/author/date/tag, and the
  `pending` inbox. Rebuild is incremental (journal file size + mtime, like
  the hook throttles) and takes milliseconds for thousands of entries.
- Engine: `node:sqlite` when the runtime is Node ≥ 22.5, else the `sqlite3`
  CLI through `child_process` (present by default on macOS and most Linux;
  on Windows `doctor` explains how to get it). When neither exists the kit
  falls back to scanning the journals in memory — slower, same results —
  so the feature never hard-fails. `doctor` reports which engine is in use.
- `memory.project.store: "sqlite-file"` remains available as an explicit
  opt-in for a team of one (a single `memory/project.sqlite` on the drive,
  rollback journal mode, no WAL). Not the default; the validator warns when
  it is combined with more than one `journal/` author.

`memory/` is provisioned by `nemeda-agent setup` exactly like `docs/` (folder
+ README, create-if-absent) and reached through a `drive.links` entry
(`".nemeda/memory": "memory"`), so the pipeline never touches provider paths
and works identically on Google Drive and OneDrive (`onedrive-plan.md`).

### Central memory: PostgreSQL behind an MCP service

The central layer is a small service the company hosts once, in the spirit
of `deploy/relay/`:

```text
deploy/memory/
├── Dockerfile            # Node service, `pg` + pgvector, MCP over HTTP
├── schema.sql            # entries, digests, projects, tokens, embeddings
└── README.md             # Azure / any Docker host recipe
```

- **Why a service, not a driver in the kit**: zero-dep rules out `pg`; the
  `psql` CLI is not on every machine and would push the connection string
  into every laptop. A single endpoint with per-person tokens keeps the
  database private, centralises access control, and is the natural home for
  the future RAG endpoint (embeddings are computed server-side, once).
- **Protocol**: MCP streamable HTTP, so any host (Claude Code, Codex, Cursor,
  Claude Desktop) connects directly with one `mcpServers` entry, and the
  kit's CLI talks to the same endpoint with `fetch` for sync. Auth: bearer
  token from `.env.local` (`NEMEDA_MEMORY_TOKEN`), one token per person,
  scoped to the projects they belong to.
- **Schema** (`schema.sql`, versioned in this repository):
  - `projects(id, name, client, active)`;
  - `entries(id ULID, project_id, revision, type, title, date, author,
    ai_tool, ai_model, tags text[], summary, client_summary, status, source
    jsonb, created_at, updated_at, promoted_at)`, primary key `(id,
    revision)`, plus a `search tsvector` generated column and a GIN index;
  - `digests(id, scope, period, body, generated_by, created_at)`;
  - `embeddings(entry_id, revision, model, vector)` with the `pgvector`
    extension — created from day one, populated by the RAG phase.
- **Tools** exposed by the service: `memory_search` (hybrid: full text now,
  vector later; filters by project, type, tags, date), `memory_get`,
  `memory_recent`, `memory_digests` — all read-only — and `memory_promote`
  (write: accepts an entry batch from a project's journal, idempotent by
  `(id, revision)`).

### One entry shape for both levels

```json
{
  "id": "01J9Z7M4K3ABCDEFGHJKMNPQRS",
  "revision": 1,
  "project": "milence",
  "repository": "milence-core",
  "type": "ai-interaction",
  "title": "Claude Code (Opus) — 2026-09-09",
  "date": "2026-09-09",
  "author": "miquel@nemeda.io",
  "ai": { "tool": "Claude Code", "model": "claude-opus-4-8" },
  "tags": ["architecture", "deployment"],
  "summary": "Internal summary, may be long.",
  "clientSummary": "Sanitised version, or null.",
  "status": "pending",
  "source": { "kind": "session", "sessionId": "…", "branch": "main", "commit": "588dcdf" },
  "createdAt": "2026-09-09T10:41:00Z"
}
```

`type` ∈ `ai-interaction | decision | finding | meeting`; `status` ∈
`pending | reviewed`; `source.kind` ∈ `session | meeting | pr | manual`.
Tags are free text, with a per-project suggested list in config so the skill
proposes consistent ones.

## Configuration

```json
"memory": {
  "project": {
    "store": "journal",
    "path": ".nemeda/memory",
    "tags": ["architecture", "api", "mobile", "backend", "data-model", "deployment", "scope"]
  },
  "central": {
    "url": "https://memory.nemeda.io/mcp",
    "tokenVariable": "NEMEDA_MEMORY_TOKEN",
    "promote": "reviewed"
  }
}
```

- `project.store`: `journal` (default) or `sqlite-file`. `project.path` is
  workspace-relative and must resolve through a `drive.links` entry;
  `doctor` warns when it does not (memory would stay on one laptop).
- `central` is optional. `promote` ∈ `reviewed` (default: only reviewed
  entries leave the project) or `all`. The token variable is a *name*; the
  value lives in `.env.local`.
- `airtable.knowledgeLog` stays accepted for one release with a validator
  `warn` ("deprecated: run `nemeda-agent memory import-airtable`") and is
  removed in 0.5.0.

Machine-local (`.env.local`): `NEMEDA_MEMORY_TOKEN`, `MEMORY_LOG_AUTO=true`
(replaces `KNOWLEDGE_LOG_AUTO`, same semantics), `NEMEDA_SQLITE_BIN`
(override for the CLI engine).

## Flows

1. **Reviewed session log** — skill `memory-log`, portable replacement of
   the Drive `klog.md` commands. Same five steps (segment by model, analyse,
   preview one entry per segment with internal + client summary, wait for
   explicit confirmation, write), but the write is `nemeda-agent memory add
   --json` on stdin, the author comes from git, the project from config, and
   the suggested tags from `memory.project.tags`. No ids anywhere.
2. **Unattended session log** — Stop hook, opt-in via `MEMORY_LOG_AUTO`,
   same dedupe-by-session state as today, appends a `pending` entry to the
   author's journal (a local append, sub-second, so the hook budget holds).
3. **Meeting entries** — the meeting pipeline (`meeting-capture-plan.md`,
   step 6) appends a `meeting` entry with the notes summary and a `source`
   pointing at the transcript folder.
4. **Review inbox** — `nemeda-agent memory review` lists `pending` entries
   for the current author (or `--all`), opens each for completion through
   the local agent (same backend invocation as the Slack bridge and the
   meeting notes), and appends the `reviewed` revision.
5. **Query from any session** — the kit's MCP server gains read-only tools
   backed by the local index: `memory_search`, `memory_recent`, `memory_get`,
   and, when `central` is configured, forwards the same query to the central
   service and merges results with a `scope: project | central` label.
   `workspace-context` tells the agent these exist and when to use them
   ("before proposing an architecture decision, search memory for prior
   resolutions").
6. **Promotion** — `nemeda-agent memory sync` pushes journal revisions that
   match `central.promote` and are not yet acknowledged (`promotedAt` kept in
   `.nemeda/state/memory-sync.json`). Idempotent; safe to run from a
   SessionStart hook with the 12 h throttle already used by the PR
   reconciler, or by hand.
7. **Recaps** — `nemeda-agent memory recap --period 2026-Q3` (project) or,
   on the service, a scheduled job per project and company-wide: the local
   agent reads the period's reviewed entries and writes a digest (what was
   decided, what was learned, what is still open), stored in
   `memory/digests/` and promoted like an entry. This is the "unir y
   recapitular" step that makes central memory readable, not just
   searchable.
8. **Migration** — `nemeda-agent memory import-airtable` reads the existing
   Knowledge Log base(s) once with `AIRTABLE_API_KEY`, maps fields to the
   entry shape (Person → email via the Team table), writes them into the
   importing person's journal with `source.kind = "airtable"` and the record
   id, and reports counts. Re-runnable: existing `source.recordId` values
   are skipped.

## CLI surface (`nemeda-agent memory`)

```
nemeda-agent memory add [--type T] [--title …] [--tags a,b] [--json]   # append one entry
nemeda-agent memory list [--pending] [--type T] [--author E] [--since D]
nemeda-agent memory search QUERY [--central] [--json]
nemeda-agent memory review [--all]                                     # complete pending entries
nemeda-agent memory index [--rebuild]                                  # refresh the SQLite index
nemeda-agent memory sync [--dry-run]                                   # promote to central
nemeda-agent memory recap --period P [--scope project|central]
nemeda-agent memory import-airtable [--base app…] [--dry-run]
nemeda-agent memory doctor [--json]
```

## Doctor

| Code | Check |
|---|---|
| `memory-folder` | `memory.project.path` exists and resolves through a Drive link |
| `memory-journal` | this author's journal is writable; no foreign writes detected |
| `memory-engine` | `node:sqlite`, `sqlite3` CLI, or in-memory fallback; which one |
| `memory-index` | index fresh vs. journals; entry counts by status |
| `memory-conflicts` | sync-client conflict copies in `journal/` (`*(1).jsonl`, `*-conflict*`) |
| `memory-central` | endpoint reachable, token valid, projects the token can see |
| `memory-sync` | unpromoted reviewed entries, last successful sync |
| `memory-deprecated` | `airtable.knowledgeLog` still present |

## Tests

`tests/memory.test.mjs`, `node --test`, no network, no real database:

- journal append/parse round-trip, revision precedence, malformed line
  tolerance (skip and report, never throw);
- index rebuild against a temp folder with the CLI engine stubbed
  (`NEMEDA_SQLITE_BIN` pointing at a script) and with the in-memory fallback,
  same results;
- validator: `memory` section rules, `sqlite-file` warning, deprecation warn;
- MCP tools: `memory_search` result shape with and without `central`;
- sync: idempotency against a stubbed central endpoint (local HTTP server in
  the test), throttle state file;
- import: mapping from a canned Airtable payload, re-run skips duplicates;
- hooks: `MEMORY_LOG_AUTO` gating, dedupe by session id, sub-second budget.

Service tests live in `deploy/memory/` with their own `package.json`
(dependencies allowed there, not in the plugin).

## Phases

1. **Project layer, local only** (0.4.0): entry shape, journals, index with
   the three engines, `memory add/list/search/index/review`, validator and
   schema, `setup` provisioning of `memory/`, Stop hook, `memory-log` skill,
   MCP read tools, `import-airtable`, docs. Airtable Knowledge Log becomes
   deprecated but still works.
2. **Meeting integration** (with `meeting-capture-plan.md` phase 3): the
   pipeline writes `meeting` entries; `meeting-summary.md` retired.
3. **Central service** (0.5.0): `deploy/memory/` service, `schema.sql`,
   `memory sync`, central forwarding in the MCP tools, per-person tokens,
   `memory recap`. Remove `airtable.knowledgeLog`.
4. **RAG** (after 0.5.0): embeddings job in the service, `memory_search`
   switches to hybrid ranking, optional `memory_ask` tool that answers with
   citations. No kit changes beyond exposing the new tool.

## Open questions

- **Task tracking after Airtable.** `airtable.tasks` and the PR reconciler
  stay as they are. If Airtable disappears entirely, the natural follow-up
  is a `tasks.provider` (`airtable | jira | github-projects`) with the same
  reconciler; the Jira MCP already used on this machine is the first
  candidate. Separate plan.
- **Who may read central memory.** Per-person tokens scoped to projects is
  the minimum; whether every employee sees every project's *internal*
  summaries is a policy decision, not a technical one. The `clientSummary`
  field exists so a project-restricted reader still gets something.
- **Model for recaps and embeddings.** Recaps run through the operator's own
  subscription (no API key), like the Slack bridge. Embeddings need a
  server-side model choice (and a key) in the service; keep it out of the
  plugin.
- **Journal growth.** JSONL journals grow forever; at a few hundred entries a
  year per person this is irrelevant for a decade. If it ever matters, the
  service is the archive and `memory index` can cap the local window.
- **Sync clients and Files On-Demand.** A teammate's journal may be a
  placeholder until first read (OneDrive) or not yet streamed (Drive);
  `memory index` treats an unreadable journal as "stale, retry" and `doctor`
  names it, instead of silently indexing a partial team memory.
