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
  every project plus periodic recaps, stored in a PostgreSQL database that is
  **provisioned and operated outside the kit**. The kit only connects to it:
  it never runs DDL, migrations, embeddings, or a service. This document fixes
  the contract (tables, columns, grants, config) that the external
  provisioning must satisfy; the SQL that creates it lives elsewhere.

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
- **SQLite is the query layer**, rebuilt from the journals on demand and
  kept in the machine-local `.nemeda/state/memory.sqlite` — never on the
  drive (confirmed 2026-09-10): each machine builds its own copy, because a
  sync client would reintroduce the cross-machine locking problem the
  journals exist to avoid, and a rebuild costs milliseconds. It holds the
  latest revision of every entry with the same filters as the CLI
  (type/author/status/since/tag). It is rebuilt only when the journal
  fingerprint (each file's name, size, and mtime) changes — a full rebuild
  into a temp file renamed into place, not per-row updates — so a reader in
  another process never sees a half-written index. Search deliberately
  matches the reference engine instead of using FTS5: FTS matches whole
  tokens, so "drive" would stop finding "OneDrive"; storing the same
  lowercased haystack and scoring with `instr()` keeps every engine's
  results and order identical.
- Engine: `node:sqlite` when the runtime has it unflagged (Node 22.13+ /
  23.4+), else the `sqlite3`
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

### Central memory: an existing PostgreSQL database the kit connects to

The central database is created and maintained by a separate provisioning
file (another session, another repository or `deploy/` folder). The kit's
responsibilities are limited to:

- **connecting** with a connection string from `.env.local`;
- **reading** entries and digests for `memory_search` / `memory_recent`;
- **writing** promoted entries, idempotently, through `memory sync`;
- **checking** in `doctor` that the database matches the contract below.

**How it connects, with zero dependencies.** The kit shells out to the `psql`
CLI (`child_process`, exactly like `gh`, `ffmpeg`, or `whisper-cli`): `psql
"$NEMEDA_MEMORY_DB_URL" -At -F $'\x1f' -v ON_ERROR_STOP=1 -c "..."` with
parameters passed through `-v` variables, never string-built. `doctor` checks
`psql` on `PATH` (`brew install libpq`, `apt install postgresql-client`, the
Windows installer) and reports the server version. Hosts that already have a
PostgreSQL MCP connector can query the same tables ad hoc; the kit does not
depend on it.

**Contract the external provisioning must satisfy.** Everything lives in one
schema so the database can be shared with other tools:

```text
schema  nemeda_memory
tables  meta, projects, entries, digests
```

`meta` — one row, lets the kit verify compatibility before doing anything:

| column | type | notes |
|---|---|---|
| `key` | text PK | `schema_version` |
| `value` | text | integer as text; the kit refuses to run when the major version is unknown |

`projects` — registry the kit reads to map `project.id` in
`.nemeda/agent-kit.json` to a central project:

| column | type | notes |
|---|---|---|
| `id` | text PK | same value as `project.id` in the kit config (`milence`) |
| `name` | text not null | display name |
| `client` | text | optional |
| `active` | boolean not null default true | inactive projects are still searchable |

`entries` — the promoted project memory, same shape as the journals:

| column | type | notes |
|---|---|---|
| `id` | text | ULID generated by the kit |
| `revision` | integer | ≥ 1; newest revision per `id` is the current one |
| `project_id` | text not null | FK → `projects.id` |
| `repository_id` | text | `repository.id` from the kit config, nullable |
| `type` | text not null | check in (`ai-interaction`, `decision`, `finding`, `meeting`) |
| `title` | text not null | |
| `entry_date` | date not null | the day the work happened |
| `author_email` | text not null | `git config user.email` of the author |
| `ai_tool` | text | `Claude Code`, `Codex`, `Cursor`, null for meetings |
| `ai_model` | text | |
| `tags` | text[] not null default `{}` | |
| `summary` | text not null | internal summary |
| `client_summary` | text | sanitised version, nullable |
| `status` | text not null | check in (`pending`, `reviewed`) |
| `source` | jsonb not null default `{}` | `{ kind, sessionId | transcript | prUrl | recordId, branch, commit }` |
| `language` | text | ISO code of the summary, optional |
| `created_at` | timestamptz not null | when the revision was written in the journal |
| `promoted_at` | timestamptz not null default now() | when `memory sync` inserted it |
| `promoted_by` | text not null | email of the person who ran the sync |
| `search` | tsvector generated | `to_tsvector('simple', title || summary || client_summary)`, GIN index |

Primary key `(id, revision)`. That key is what makes promotion idempotent:
`memory sync` uses `INSERT ... ON CONFLICT (id, revision) DO NOTHING`.
A view `entries_current` (latest revision per `id`) is recommended so the
search queries stay simple; the kit falls back to a `DISTINCT ON` query when
the view is missing.

`digests` — periodic recaps, written by `memory recap` and read by
`memory_digests`:

| column | type | notes |
|---|---|---|
| `id` | text PK | ULID |
| `scope` | text not null | `project` or `central` |
| `project_id` | text | FK → `projects.id`, null for `central` |
| `period` | text not null | `2026-Q3`, `2026-09`, free but sortable |
| `body` | text not null | Markdown |
| `generated_by` | text not null | email or `service` |
| `created_at` | timestamptz not null default now() | |

Anything else the database holds — embeddings, pgvector, RAG tables,
scheduled jobs — is invisible to the kit and must not be required by it.
The kit only ever touches the four tables above and the optional view.

**Grants.** Two roles, both created by the provisioning file:

- `nemeda_memory_reader`: `USAGE` on the schema, `SELECT` on the four tables
  and the view;
- `nemeda_memory_writer`: reader plus `INSERT` on `entries` and `digests`.
  No `UPDATE`, no `DELETE`: revisions are new rows, and corrections are new
  revisions. The kit never needs more, and `doctor` warns when the connected
  role has more than that.

Each person gets their own database user (or a per-person password on the
writer role, at minimum), so `promoted_by` is trustworthy and access can be
revoked per person. The connection string is personal and never leaves
`.env.local`.

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
    "urlVariable": "NEMEDA_MEMORY_DB_URL",
    "schema": "nemeda_memory",
    "projectId": "milence",
    "promote": "reviewed"
  }
}
```

- `project.store`: `journal` (default) or `sqlite-file`. `project.path` is
  workspace-relative and must resolve through a `drive.links` entry;
  `doctor` warns when it does not (memory would stay on one laptop).
- `central` is optional. `urlVariable` is the *name* of the `.env.local`
  variable holding the personal connection string
  (`postgres://user:pass@host:5432/db?sslmode=require`); the config never
  holds the value. `schema` defaults to `nemeda_memory`; `projectId`
  defaults to `project.id` and must exist in `projects`. `promote` ∈
  `reviewed` (default: only reviewed entries leave the project) or `all`.
- `airtable.knowledgeLog` stays accepted for one release with a validator
  `warn` ("deprecated: run `nemeda-agent memory import-airtable`") and is
  removed in 0.5.0.

Machine-local (`.env.local`): `NEMEDA_MEMORY_DB_URL` (personal),
`MEMORY_HARVEST=true` (replaces `KNOWLEDGE_LOG_AUTO`; see "Unattended capture"),
`NEMEDA_SQLITE_BIN` and `NEMEDA_PSQL_BIN` (overrides for the CLI engines).

## Flows

1. **Reviewed session log** — skill `memory-log`, portable replacement of
   the Drive `klog.md` commands. Same five steps (segment by model, analyse,
   preview one entry per segment with internal + client summary, wait for
   explicit confirmation, write), but the write is `nemeda-agent memory add
   --json` on stdin, the author comes from git, the project from config, and
   the suggested tags from `memory.project.tags`. No ids anywhere.
2. **Unattended session log** — see "Unattended capture" below. Hooks only
   record which sessions happened; a deferred harvester resumes each closed
   session through the host's own CLI, writes the summary, and appends a
   `pending` entry. Opt-in via `MEMORY_HARVEST=true`.
3. **Meeting entries** — the meeting pipeline (`meeting-capture-plan.md`,
   step 6) appends a `meeting` entry with the notes summary and a `source`
   pointing at the transcript folder, through `recordEntry` (see "Cross-
   feature integration" below) rather than the journal primitives directly.
4. **Review inbox** — `nemeda-agent memory review` with no id lists `pending`
   entries (the current author's by default, `--all` for visibility across
   the team); with an id it appends the `reviewed` revision, optionally with
   changes as JSON on stdin. **Only the entry's own author can review it**:
   a journal has exactly one writer by design, so letting a different
   machine append a revision to someone else's journal file would
   reintroduce the concurrent-write problem journals exist to avoid — an
   invariant worth stating once here since it is easy to miss when reading
   only the CLI surface. Opening each entry for completion *through the
   local agent* (an automated first-draft summary, not just a human typing
   one) is not implemented yet; today's version is the confirm-and-write
   primitive, driven by a human or by the `memory-log` skill.
5. **Query from any session** — the kit's MCP server exposes three
   read-only tools backed by the journals directly (no SQLite index yet —
   see phase 1b below): `memory_search` (same `type`/`author`/`status`/
   `since` filters as the CLI), `memory_recent`, and `memory_get` by id.
   `central` scope (merging in `entries_current` when `psql` is available)
   is not implemented yet.
   `workspace-context` tells the agent these exist and when to use them
   ("before proposing an architecture decision, search memory for prior
   resolutions").
6. **Promotion** — `nemeda-agent memory sync` pushes journal revisions that
   match `central.promote` and are not yet acknowledged (`promotedAt` kept in
   `.nemeda/state/memory-sync.json`). Idempotent; safe to run from a
   SessionStart hook with the 12 h throttle already used by the PR
   reconciler, or by hand.
7. **Recaps** — `nemeda-agent memory recap --period 2026-Q3`: the local
   agent reads the period's reviewed entries (project scope from the index,
   central scope from `entries_current`) and writes a digest (what was
   decided, what was learned, what is still open), stored in
   `memory/digests/` and inserted into `digests` by the next sync. This is
   the "unir y recapitular" step that makes central memory readable, not
   just searchable. Company-wide recaps on a schedule belong to the
   database's own tooling, not to the kit.
8. **Migration** — `nemeda-agent memory import-airtable` reads the existing
   Knowledge Log base(s) once with `AIRTABLE_API_KEY`, maps fields to the
   entry shape (Person → email via the Team table), writes them into the
   importing person's journal with `source.kind = "airtable"` and the record
   id, and reports counts. Re-runnable: existing `source.recordId` values
   are skipped.

## Unattended capture

People forget to run the reviewed flow, and a `pending` stub with no summary
(today's `KNOWLEDGE_LOG_AUTO`) is forgotten just the same. The fix is to have
the summary written for them, after the fact, on their own machine, and leave
only a ten-second confirmation. Three facts make this possible on both hosts:

- Claude Code and Codex fire the same plugin hook events the kit already
  ships (`SessionStart`, `Stop`, `PostToolUse`), so capture is one code path.
- Both keep every session on disk with an id: Claude under
  `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, Codex under
  `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl` plus
  `~/.codex/session_index.jsonl`.
- Both can reopen a past session non-interactively and answer one more
  prompt against its full context: `claude -p --resume <id> …` and
  `codex exec resume <id> …`. No transcript parsing, no format coupling.

Neither host's own scheduler fits: Claude Code routines run in the cloud
without access to local transcripts, and Codex has no equivalent. The
scheduler has to be local.

### Three layers

1. **Ledger (hooks, milliseconds, no model).** `SessionStart` and `Stop`
   append `{ sessionId, tool, model, cwd, project, startedAt, lastActivity }`
   to `.nemeda/state/sessions.json`. `Stop` fires after every turn, so
   `lastActivity` keeps moving; a session counts as *closed* when it has been
   idle for `memory.harvest.idleMinutes` (default 30) or its transcript file
   stopped changing. Only sessions whose `cwd` is inside a kit-configured
   repository are recorded: personal sessions never enter the ledger.
2. **Harvester (deferred, unattended).** `nemeda-agent memory harvest`
   takes every closed, unharvested session and runs the matching host CLI
   with the `memory-log` skill in unattended mode:

   ```
   claude -p --resume <id> --output-format json --tools "" \
          --append-system-prompt <memory-log prompt> "Produce the entries."
   codex exec resume <id> --sandbox read-only --skip-git-repo-check \
          -o <tmp>.json "<memory-log prompt>\n\nProduce the entries."
   ```

   The prompt asks for the same output as the reviewed flow (one entry per
   model segment, internal and client summary, tags from
   `memory.project.tags`) as JSON. The kit validates it, appends each entry
   as `pending` with `source = { kind: "session", sessionId, tool }`, and
   marks the session harvested. If the session can no longer be resumed
   (deleted, host upgraded), the fallback reads the transcript JSONL, keeps
   only user and assistant text, and summarises it with a fresh `-p` /
   `exec` call. Runs one session at a time, never inside a hook, and bills
   the person's own subscription like the Slack bridge.
3. **Triggers.** Two, so it works with and without installing anything:
   - **Opportunistic — shipped**: the `SessionStart` hook (hooks.json passes
     `--session-start`; `Stop` fires after every turn and never triggers),
     after writing the ledger, spawns `memory harvest` as a *detached* child
     (`detached: true`, output to `.nemeda/state/harvest.log`, `unref()`)
     when `MEMORY_HARVEST=true` and earlier sessions have closed, so the
     hook returns immediately and yesterday's sessions get summarised while
     today's starts. This alone covers most people: the next session
     harvests the previous ones. A per-machine lock
     (`.nemeda/state/harvest.lock`, taken over when its pid is dead or it
     is over an hour old) keeps this run and a manual one from resuming the
     same session twice.
      - **Scheduled — pending**: `nemeda-agent memory install` registers a local job
     every 30 minutes and at login — launchd on macOS (same code path as
     `slack install`), a systemd user timer on Linux, Task Scheduler on
     Windows — for machines where sessions must be logged the same day even
     if no new session is opened.

      Until the scheduled trigger lands, a machine where nobody opens a new
   session never harvests; `nemeda-agent memory harvest` by hand covers
   that case.

The `SessionStart` context line — shipped — closes the loop: "3 session
entries from this week are pending your review; run
`nemeda-agent memory review`". Reviewing an entry whose summary already
exists is a confirmation, not a writing task, which is what removes the
forgetting.

### Config and switches

```json
"memory": {
  "harvest": { "idleMinutes": 30, "maxSessionsPerRun": 5, "hosts": ["claude", "codex"] }
}
```

Personal, in `.env.local`: `MEMORY_HARVEST=true` (opt-in; nothing is
resumed without it), `MEMORY_HARVEST_MODEL` (cheaper model for summaries,
optional). `doctor` reports the ledger size, harvestable sessions, the
installed scheduler, and whether each host CLI is on `PATH`.

### Limits

- Cursor has neither plugin hooks nor a resumable CLI; its sessions are not
  captured. The reviewed skill still works there by hand.
- A harvested summary is written by the model that resumes the session, not
  necessarily the one that did the work; the entry records both.
- Resuming a long session costs tokens once per session; `maxSessionsPerRun`
  and the idle threshold bound it, and the fallback path truncates
  transcripts to the last N turns when they exceed a size cap.
- Transcripts never leave the machine; only the resulting summary reaches the
  project journal, exactly as with the manual flow today.

## Cross-feature integration

Other kit features that want to log a memory entry — the meeting pipeline
today, the unattended-capture harvester above later — do not need to know
anything about journals, config shape, or author resolution. They call one
function exported by `scripts/lib/memory.mjs`:

```js
recordEntry(root, { type, title, summary, date, author, tags, source, links, clientSummary }) -> { id, path } | null
```

- `root`: any directory inside the configured repository (same argument
  shape as `readWorkspaceContext`).
- `type`: one of `ENTRY_TYPES` (`ai-interaction`, `decision`, `finding`,
  `meeting`), or the string `"session"` as a convenience alias — filed as
  `ai-interaction` with `source.kind` defaulting to `"session"`, since an AI
  session is what usually produces that alias.
- `author`: optional override; defaults to `git config user.email` in
  `root`.
- `source`: a string naming the source kind (`"meeting"`), or an object
  `{ kind, ...anything worth keeping }` (e.g. `{ kind: "meeting", transcript:
  "docs/transcripts/2026-09-10-standup" }`).
- `links`: merged onto the final `source` object — a convenience for a
  caller that would rather keep "what this points at" separate from "what
  kind of source this is" (e.g. `links: { transcript: "..." }`).

Synchronous, and **never throws**: returns `null` whenever `memory` is not
configured for the repository, there is no resolvable author, or the
resulting entry fails validation — the same "never block the caller"
contract the Airtable hooks already follow. A meeting or PR pipeline calling
this can always keep going whether or not it returned an id.

If this name or signature changes, it is a breaking change for every other
feature calling it — say so explicitly rather than changing it quietly.

## CLI surface (`nemeda-agent memory`)

```
nemeda-agent memory add [--type T] [--title …] [--tags a,b] [--json]   # append one entry — shipped
nemeda-agent memory list [--pending] [--type T] [--author E] [--since D]     # shipped
nemeda-agent memory search QUERY [--central] [--json]                       # shipped (no --central yet)
nemeda-agent memory review [ID] [--all] [--json]                            # shipped; ID completes an entry, no ID lists the inbox
nemeda-agent memory harvest [--session ID] [--dry-run] [--json]        # shipped; no flag = every closed session
nemeda-agent memory install | uninstall                                # local scheduler for harvest — pending (1b-iii)
nemeda-agent memory index [--rebuild] [--json]                         # shipped; status, or --rebuild to force
nemeda-agent memory sync [--dry-run]                                   # promote to central — pending (phase 3)
nemeda-agent memory recap --period P [--scope project|central]              # pending (phase 3)
nemeda-agent memory import-airtable [--base app…] [--dry-run]               # pending (1b-iv)
nemeda-agent memory doctor [--json]                                    # pending; today's checks live under `nemeda-agent doctor`
```

## Doctor

| Code | Check |
|---|---|
| `memory-folder` | `memory.project.path` exists and resolves through a Drive link |
| `memory-journal` | this author's journal is writable; no foreign writes detected |
| `memory-engine` | `node:sqlite`, `sqlite3` CLI, or in-memory fallback; which one |
| `memory-index` | index fresh vs. journals; entry counts by status |
| `memory-conflicts` | sync-client conflict copies in `journal/` (`*(1).jsonl`, `*-conflict*`) |
| `memory-psql` | `psql` on `PATH`, version |
| `memory-central` | connection works, `meta.schema_version` compatible, `projectId` exists in `projects` |
| `memory-grants` | connected role can `SELECT` the four tables and `INSERT` on `entries`; warns on `UPDATE`/`DELETE`/DDL rights |
| `memory-sync` | unpromoted reviewed entries, last successful sync |
| `memory-harvest` | opt-in state, host CLIs on `PATH`, closed sessions awaiting harvest, scheduler installed |
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
- sync and central search: `NEMEDA_PSQL_BIN` pointing at a stub script that
  records the SQL it receives and returns canned rows, so idempotency,
  parameter passing, the `entries_current` fallback, and the version check
  are covered without a database;
- import: mapping from a canned Airtable payload, re-run skips duplicates;
- ledger hook: cwd filter, idle detection, sub-second budget, detached spawn
  never blocks;
- harvester: host CLIs stubbed with scripts that emit canned JSON, output
  validation, fallback path on a resume failure, `maxSessionsPerRun`.

The SQL that provisions the database, and its tests, live with the
provisioning file outside the kit. `docs/memory-central-contract.md` (to be
extracted from the tables above when phase 3 starts) is the shared reference
for both sides.

## Phases

1. **Project layer, local only** (0.4.0):
   - **1a, done**: entry shape and journals (`scripts/lib/memory.mjs`),
     `memory add/list/search` reading and writing straight through the
     in-memory reference engine (no SQLite acceleration yet), the `memory`
     config section (validator + schema), `setup` provisioning of the
     `memory` folder README, doctor checks (`memory-folder`,
     `memory-journal`, `memory-conflicts`), the `airtable.knowledgeLog`
     deprecation warning, `recordEntry` for other features to call, and
     docs.
   - **1b-i, done**: `nemeda-agent memory review` (with the single-writer
     safety check above), the `memory-log` skill (portable replacement for
     the Drive `klog.md` commands), and the MCP server's `memory_search`/
     `memory_recent`/`memory_get` tools — all reading straight through the
     in-memory reference engine, no SQLite index yet.
   - **1b-ii, done**: `scripts/lib/memory-index.mjs` — the machine-local
     index with three engines (`node:sqlite`, the `sqlite3` CLI, the
     in-memory reference), automatic rebuild on journal change, fallback to
     the reference engine on any engine failure, `nemeda-agent memory
     index [--rebuild]`, and `memory list`/`search` plus the MCP
     `memory_*` tools answering through it. Verified identical to the
     reference on all three engines (node:sqlite on Node 24, the CLI on
     Node 20 and 24), SQL-hostile and non-ASCII queries included. Still
     pending: the `memory-engine`/`memory-index` doctor rows (wiring them
     into workspace.mjs would create an import cycle through memory.mjs;
     `nemeda-agent memory index` reports the same facts today).
   - **1b-iii, mostly done**: the unattended-capture ledger hooks
     (`scripts/hooks/memory-ledger.mjs`, one script wired into both
     `SessionStart` and `Stop`) and the harvester core
     (`scripts/lib/harvest.mjs`, `nemeda-agent memory harvest`) — resume a
     closed session through its host CLI (`claude -p --resume` /
     `codex exec resume`, reusing `parseBackendOutput` from slack.mjs),
     parse its JSON answer, file whatever validates, mark the session
     harvested either way. Gated by `MEMORY_HARVEST=true`; guarded against
     recursion via `NEMEDA_MEMORY_HARVESTER=1` on the resumed session's
     environment, so a harvested session can never record or re-harvest
     itself. The opportunistic trigger from `SessionStart` (detached, with a
     per-machine lock and `harvest.log`) and the pending-review context
     line are shipped too. Still pending from the original design: the
     "read the raw transcript" fallback for a session that can no longer be
     resumed (a failed resume is recorded as a harvest error today, never
     fabricated), `memory install`/`uninstall`'s local scheduler
     (launchd/systemd/Task Scheduler), and the `memory-harvest` doctor check.
   - **1b-iv, pending**: `import-airtable`, migrating existing Knowledge Log
     bases into journals.
2. **Meeting integration** (with `meeting-capture-plan.md` phase 3): the
   pipeline writes `meeting` entries; `meeting-summary.md` retired.
3. **Central connection** (0.5.0): `psql` adapter, `memory sync`, central
   scope in the MCP tools, `memory recap`, doctor checks, contract document.
   Depends on the database being provisioned externally. Remove
   `airtable.knowledgeLog`.
4. **RAG** (after 0.5.0, outside the kit): embeddings and hybrid search are
   added to the database and its own service. The kit only changes if a new
   read-only tool should be surfaced through `workspace-context`.

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
- **Model for recaps.** Recaps run through the operator's own subscription
  (no API key), like the Slack bridge. Embeddings and any RAG model choice
  are the database side's decision and stay out of the plugin.
- **`psql` on every machine.** It is the one external binary this layer
  needs. If that turns out to be a blocker on Windows laptops, the fallback
  is a thin HTTP endpoint in front of the database (PostgREST or similar)
  reached with `fetch`; the contract above does not change.
- **Journal growth.** JSONL journals grow forever; at a few hundred entries a
  year per person this is irrelevant for a decade. If it ever matters, the
  central database is the archive and `memory index` can cap the local
  window.
- **Sync clients and Files On-Demand.** A teammate's journal may be a
  placeholder until first read (OneDrive) or not yet streamed (Drive);
  `memory index` treats an unreadable journal as "stale, retry" and `doctor`
  names it, instead of silently indexing a partial team memory.
