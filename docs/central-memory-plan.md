# Central memory plan: RAG over finished projects

Status: design, not implemented. Target release: 0.5.0 of the kit plus a new
service repository. Extends the "Central memory" section of
[memory-plan.md](memory-plan.md): the database contract defined there stays
as it is; this plan adds the retrieval service on top of it and the kit's
client side.

Goal: keep what every finished project taught us in one PostgreSQL database
in the cloud, and let any agent session ask it in natural language ("how did
we handle SSO for Milence", "what did the Scharlab kick-off decide about
embeddings") through MCP, with the same privacy stance as the rest of the
kit: our infrastructure, our model, per-person access.

## Decisions taken (2026-09-10)

Relayed from Miguel during review; they fix the choices the first draft
left open and are reflected throughout the rest of this document.

| Topic | Decision |
|---|---|
| Write path | Promotion through the service; one personal token per person, no laptop reaches the database |
| Cloud | Azure, where TWYD already runs |
| Identity | Microsoft Entra, reusing the TWYD MCP app registrations |
| Read scope | Everyone may read every project; `people.projects` defaults to `'*'` and `internal` is no longer a per-person restriction |
| Database | A new database, `memoria_central`, on the PostgreSQL server that already serves TWYD (created on 2026-09-14; pgvector is available on that server); the schema inside it stays `nemeda_memory`, which is what the contract and the kit depend on |
| Service hosting | A small Azure VM, not a container or a function, so it can join the Tailscale network |
| Embeddings | Not in-process: Text Embeddings Inference (TEI) on the DGX Spark, reached over Tailscale, exactly as Scharlab does |

## Constraints

1. The kit stays zero-dependency. No embedding model, no vector math, no
   database driver in the plugin. It talks to the service with `fetch` and to
   the database with `psql`, as memory-plan.md already decided.
2. Text never goes to third-party inference. The embedding model runs on our
   own hardware, the DGX Spark, behind Tailscale (the Scharlab rule, E7-04).
3. Ingest and retrieval must use the same model and produce compatible
   vectors, verified by a test, not by convention.
4. Per-person identity on every query, so access can be scoped per project
   and revoked per person; the client never chooses its own identity.
5. Changing the embedding model must be a re-index, never a schema change.
6. Writes keep the existing contract's semantics: promotion is
   `INSERT ... ON CONFLICT (id, revision) DO NOTHING`, revisions are new
   rows, nothing is ever updated or deleted by the kit. The transport
   changes: the service exposes promotion so a laptop needs one credential
   and no network path to the database (see "Write path" below); `psql`
   stays for administrators and ad-hoc analysis.

## What exists already

| Piece | Where | Reused how |
|---|---|---|
| Database contract (`nemeda_memory`: `meta`, `projects`, `entries`, `digests`; reader/writer roles; `search` tsvector) | memory-plan.md | Unchanged; the service reads it and adds one table |
| `memory sync` (promotion, idempotent by `(id, revision)`) | kit, memory module | Same statement, now sent through the service; `psql` transport kept as the admin fallback |
| MCP over Streamable HTTP with Microsoft Entra OAuth (RFC 9728 discovery, JWT validation, `azp` allowlist, per-user rate limits, `twyd_whoami`) | TWYD backend, `mcp_server/` | Copied into the new service; only the tools change |
| bge-m3 provider with `local` (sentence-transformers) and `tei` (Text Embeddings Inference) backends, plus the compatibility test (cosine ≥ 0.999 between stacks) | Scharlab backend, `ai/embeddings.py` | Copied; `tei` against the Spark is the production mode, `local` stays for tests and evaluation, the compatibility test becomes a CI gate |
| DGX Spark on the tailnet (Tailscale as a persistent service, IP documented in `spark/plan/conectar.md`) | Miguel's hardware | Hosts TEI with bge-m3 |
| PostgreSQL server for TWYD, pgvector already enabled | Azure | Hosts the new database `memoria_central` (schema `nemeda_memory` inside it) |
| Kit MCP server (`memory_search`, `memory_recent`, `memory_get` over the project journals) | kit, `scripts/mcp-server.mjs` | Gains an optional proxy to the central service |

## Why a service and not direct database queries

- The query has to be embedded with the corpus model. Direct access would
  force every laptop onto the tailnet to reach TEI, or put the model on
  every laptop. One service, one model, one endpoint, consistency guaranteed
  by construction.
- Good retrieval is hybrid: vector similarity plus the full-text `search`
  column, fused, then filtered by project, type, status, and date. That is
  server logic, and the place to tune it once for everyone.
- Identity, project scoping, rate limits, and audit are already solved in
  TWYD's MCP module.
- The database keeps no public port; only the service reaches it. That is
  also why promotion goes through the service: with `psql` as the only write
  transport every person would need a database user *and* network access
  to the database (VPN or SSH tunnel) *and* the service token, the exact
  risk memory-plan.md left open under "psql on every machine". Personal
  `psql` access stays for administrators and ad-hoc analysis.

Direct queries remain possible for whoever has a database user (the
PostgreSQL MCP connector on this machine, for instance); they just are not
the RAG path.

## Architecture

```text
laptops                                  cloud
────────                                 ─────
admins ── psql (private network) ────────▶ PostgreSQL (TWYD server, database memoria_central, schema nemeda_memory, pgvector)
                                                          ▲
Claude Desktop / Claude Code ── MCP/HTTPS ─▶              │
Codex / Cursor ── kit stdio proxy ── HTTPS ─▶ memory-service (FastAPI on an Azure VM, Caddy for TLS)
memory sync / close ── kit ── HTTPS ────────▶ ├─ promote: INSERT … ON CONFLICT DO NOTHING, promoted_by from the token
                                              ├─ embed worker: rows without a vector → TEI → embeddings
                                              ├─ search: hybrid SQL (pgvector + tsvector, RRF, filters)
                                              └─ MCP: memory_central_search | digests | projects | promote | whoami
                                                        │ Tailscale
                                                        ▼
                                              DGX Spark: TEI serving BAAI/bge-m3
```

### 1. Database additions

On top of the memory-plan.md contract, one table and one extension:

```sql
create extension if not exists vector;

create table nemeda_memory.embeddings (
  entry_id     text        not null,
  revision     integer     not null,
  model        text        not null,          -- 'BAAI/bge-m3'
  dimensions   integer     not null,          -- 1024
  embedding    vector(1024) not null,
  embedded_at  timestamptz not null default now(),
  primary key (entry_id, revision, model),
  foreign key (entry_id, revision) references nemeda_memory.entries (id, revision)
);
create index on nemeda_memory.embeddings using hnsw (embedding vector_cosine_ops)
  where model = 'BAAI/bge-m3';
```

- `model` and `dimensions` are data, not schema: a second model gets its
  own rows and its own partial index. pgvector fixes the column width, so a
  model with a different width gets a sibling table (`embeddings_768`); the
  service picks the table from its configuration.
- Digests get the same treatment (`digest_embeddings`), chunked by Markdown
  section because recaps are long; entries are embedded whole (title,
  summary, tags) because they are already short.
- `nemeda_memory_reader` gets `SELECT` on the new tables. A third role,
  `nemeda_memory_service`, is what the service connects as: writer (insert
  on `entries` and `digests`, for promotion on behalf of a validated user)
  plus `INSERT` on the embedding tables. Still no `UPDATE` or `DELETE`
  anywhere; `doctor` keeps warning on anything broader for the roles a
  person may hold.
- **Project closure is append-only.** Closing a project inserts one digest
  with `kind = 'closure'` (a new nullable column on `digests`, default
  `'recap'`); a view `projects_status` derives `active = not exists
  (closure digest)`. Nothing updates `projects`, which stays the registry
  the provisioning owns and the kit only reads. Reopening a project is one
  more row: a digest with `kind = 'reopen'`, and the view takes the latest.

### 2. The service

A new repository, `nemeda-memory-service`, Python and FastAPI, one process:

- **Embed worker.** Every few minutes (and right after a promotion) selects
  `entries_current` rows without a row in `embeddings` for the active model,
  sends them in batches to TEI on the Spark, inserts. Same for digests.
  Idempotent by the primary key; a model switch is a configuration change
  on the TEI side followed by a full pass. The service itself loads no
  model, so the VM stays small; the `local` provider is kept for tests, for
  the evaluation phase, and as an emergency fallback that an operator
  enables explicitly.
- **When the Spark is unreachable** (powered off, TEI down, tailnet
  hiccup): promotions still succeed and their rows wait for a vector;
  `memory_central_search` degrades to full-text search only and says so in
  the response (`mode: "text-only"`, with the reason); `memory_central_whoami`
  and the kit's `doctor` report TEI status and the number of rows waiting.
  A single physical machine is an accepted risk for a corpus this size, not
  a reason for a second GPU.
- **Search.** One SQL: top-k by cosine distance on the active model, top-k
  by `ts_rank` on `search`, reciprocal rank fusion, then filters (project
  ids the caller may read, `type`, `status = reviewed` by default, `since`),
  returning the entry fields plus `source` so the caller can follow the link
  to a transcript, notes file, or PR. A maximum distance cut-off like
  TWYD's `MCP_RAG_MAX_VECTOR_DISTANCE` avoids confident nonsense on
  unrelated questions.
- **MCP.** Streamable HTTP at `/mcp`, the TWYD module with these tools:

  | Tool | Purpose |
  |---|---|
  | `memory_central_search(query, projects?, types?, since?, k?)` | hybrid search over entries, scoped to the caller's projects |
  | `memory_central_digests(project?, period?)` | recaps and closures, newest first |
  | `memory_central_projects()` | projects the caller may read, with the derived active flag and counts |
  | `memory_central_promote(entries[], digests[])` | the write path: `INSERT … ON CONFLICT (id, revision) DO NOTHING` for entries and digests the caller may write to; `promoted_by` comes from the validated token, never from the payload; returns what was inserted and what already existed |
  | `memory_central_whoami()` | validated identity and scopes, for diagnostics |

  The same promotion is also a plain HTTP endpoint (`POST /promote`) for
  the kit's CLI, since `memory sync` is not an agent conversation.

- **Identity and scope.** Microsoft Entra, reusing the TWYD MCP app
  registrations (API registration, public clients for Claude Code and
  Codex, the confidential client for the Claude connector). The token's
  e-mail is matched to a `people` table (`email`, `projects text[]` default
  `'{*}'`, `can_promote boolean`) in the service's own schema
  (`nemeda_memory_service`), never read by the kit. By decision, everyone
  reads every project; `projects` exists so a contractor or a client-side
  reader can be scoped later without a schema change. `client_summary`
  stays a field on the entry, not a per-person restriction. When Entra does not fit, the service issues personal
  bearer tokens with the same table behind them; the tools do not change.
- **Configuration.** `DATABASE_URL` (runtime role), `EMBEDDINGS_PROVIDER=tei`,
  `EMBEDDINGS_ENDPOINT_URL=http://<spark-tailscale-ip>:8080`,
  `EMBEDDINGS_MODEL=BAAI/bge-m3`, `EMBED_INTERVAL_SECONDS`, the `MCP_*`
  variables inherited from TWYD, and `RAG_MAX_DISTANCE`.
- **A shared server.** Roles are server-wide in PostgreSQL and `PUBLIC` can
  connect to every database by default, so the memory roles could connect
  to TWYD's database (customer data) even without seeing its tables. The
  provisioning therefore revokes `CONNECT` on `memoria_central` from
  `PUBLIC` (the administrator step above) and grants it only to the memory
  roles, keeps the `nemeda_memory_` prefix
  so nothing collides with TWYD's roles, never requires superuser, never
  touches anything outside its own database, and leaves a note for whoever
  administers TWYD to confirm that `PUBLIC` has no `CONNECT` on TWYD's
  database either (or at least that the memory roles hold no grant there).
- **Migrations.** Versioned SQL files in the service repository
  (`migrations/0001_contract.sql`, `0002_embeddings.sql`, …), applied with
  an owner role that the runtime never uses; the runtime role has no DDL,
  in line with the rest of the contract. The first migration is the
  memory-plan.md contract itself.

### 3. The kit side

Small, and owned by the memory module:

- `memory.central.mcpUrl` in `.nemeda/agent-kit.json` (shared, non-secret)
  and `memory.central.tokenVariable` (the *name* of the variable holding the
  personal token, default `NEMEDA_MEMORY_TOKEN`, read from
  `~/.nemeda/.env.local` because it is per person, not per project). The
  existing `urlVariable` for `psql` becomes optional once `mcpUrl` exists.
  `doctor` fetches the discovery document and reports reachable /
  unauthenticated / version.
- `memory sync` sends its batch to `POST /promote` with that token; the
  `psql` transport stays as an explicit `--via psql` for administrators.
- Claude Desktop and Claude Code connect to the URL directly (OAuth). For
  Codex and Cursor, the kit's stdio MCP server proxies
  `memory_central_search` with `NEMEDA_MEMORY_TOKEN` from `~/.nemeda/.env.local`
  through `fetch`; still zero dependencies.
- The memory skill searches central before proposing something that may
  already have been decided elsewhere, then the project journals.
- Project closure: `nemeda-agent memory close` promotes every reviewed entry
  of the project and writes the closure digest (`kind = 'closure'`) through
  the operator's own agent, same path as recaps. Inactive status is derived
  from that digest by the `projects_status` view; the kit never updates
  `projects`.

### 4. What gets indexed

Entries and digests. Not transcripts: they are long, noisy, and may carry
customer content; the meeting notes and the memory entry are the distilled
version and point at the transcript on the drive for whoever needs the
detail. Revisit only if evaluation shows entries are too thin for the
questions people actually ask.

### 5. Embedding model

Start with `BAAI/bge-m3`: multilingual with good Spanish and Catalan, long
inputs, 1024 dimensions, open licence, already operated by the team with a
compatibility test. Its size only matters on the Spark, where it already
runs; the VM never loads it. Two alternatives to measure in phase 5,
same vector width so they can share the table: `Qwen3-Embedding-0.6B`
(newer, instruction-aware, query and passage prefixes differ — Scharlab's
code already handles that) and `embeddinggemma-300m` (much smaller, if
laptop-side queries ever become desirable). The corpus is small enough that
re-embedding with another model costs minutes.

## Hosting

- **Database**: `memoria_central` on the PostgreSQL server that already
  serves TWYD in Azure (created 2026-09-14). The schema inside it is
  `nemeda_memory`, unchanged. Two statements need database-owner or
  superuser rights and are run once by an administrator, before any
  migration: `CREATE EXTENSION IF NOT EXISTS vector;` and `REVOKE CONNECT ON
  DATABASE memoria_central FROM PUBLIC;` (then `GRANT CONNECT` to the memory
  roles as they are created). Everything else — schema, roles, tables,
  views, grants inside the schema — comes from the migrations. Connectivity
  from the VM by the same private network or a firewall rule for the VM's
  address.
- **Service**: one small Azure VM (2 vCPU is plenty: no model in process),
  joined to the tailnet so it reaches the Spark, with Caddy in front for a
  DNS name and a Let's Encrypt certificate: the MCP URL must be HTTPS for the
  OAuth flow. TLS, system patches, and restarts are ours to run; that is the
  price of the tailnet membership a container or a function could not offer
  as simply.
- **Embeddings**: TEI on the DGX Spark, as a persistent service (systemd) so
  it survives a reboot like Tailscale already does; the Scharlab setup
  documents Tailscale on the Spark but not TEI as a service, so making it one
  is part of phase 1.

## Phases

1. **Provision.** The migrations: the memory-plan.md contract (including the
   `entries_current` view and the `meta.schema_version` row the kit checks
   first) plus section 1 of this plan: the embedding tables, `digests.kind`,
   the `projects_status` view, the roles, and the service's own `people`
   table; applied to `memoria_central` on the TWYD server after the two
   administrator statements. memory-plan.md
   notes this SQL was to be written in another session; it becomes this
   phase. Also: TEI as a systemd service on the Spark, verified from the
   tailnet.
2. **Service.** Repository, embed worker, hybrid search, MCP tools, Entra
   verifier and `people` scoping, the vector-compatibility test as a CI gate,
   a `docker-compose` for local runs against a throwaway Postgres.
3. **Kit.** `memory.central.mcpUrl`, doctor check, stdio proxy, skill update,
   `memory close`. Coordinated with the memory module's owner.
4. **Deploy and onboard.** The Azure VM on the tailnet with Caddy, Entra app
   registrations reused from TWYD's (a new API registration for the memory
   resource, the existing public clients allow-listed), per-person rows in
   `people`, onboarding page.
5. **Evaluate.** Twenty to thirty real questions over the Scharlab and
   Milence memories; recall@5 and a manual relevance pass for bge-m3 against
   the two alternatives; pick with numbers, re-embed if needed. Then promote
   the first finished project for real.

## Risks and open questions

- **Cold corpus.** Central memory is only as good as what gets promoted;
  the closure flow in phase 3 and the recaps are what fill it. Until a few
  projects are promoted, evaluation runs on the Scharlab and Milence
  journals.
- **Scope policy.** Whether every employee reads every project's internal
  summary is a policy decision (memory-plan.md open question); the `people`
  table and `client_summary` make either answer configurable.
- **One write transport, two writers.** Promotion (through the service, on
  behalf of a person) inserts rows; the embed worker inserts vectors. They
  never touch the same table, so no coordination is needed, but a row can
  sit un-embedded for up to one worker interval; the service can embed
  synchronously right after a promotion to close that gap, and `doctor` can
  show the lag either way.
- **Constraint 6 was revised** during review: the first draft kept `psql`
  as the only write transport. Promotion through the service is what makes
  one credential per person and no laptop-to-database network path
  possible; it is the recommended default, and `psql` remains for
  administrators.
- **Model drift.** A vector from the `local` stack and one from `tei` must
  match; the inherited compatibility test guards it, and the `model` column
  guards against mixing models by accident.
- **Entra friction.** TWYD's own notes list the registration pitfalls
  (public client flows, token version 2, Application ID URI). Reusing its
  registrations avoids rediscovering them; personal tokens remain the
  fallback.
- **The Spark is one machine.** Its absence never loses data (rows wait
  for vectors) and never blocks promotion, but semantic search degrades to
  text-only until it is back; the response and the doctor say so. If that
  becomes a real problem, the `local` provider on the VM is the fallback,
  at the cost of a bigger VM.
- **Shared database server.** Memory lives next to TWYD's customer data. The
  mitigations above (per-database `CONNECT`, prefixed roles, no superuser,
  no cross-database DDL) are part of the first migration, and a periodic
  check that the memory roles hold no grants outside their database belongs
  in the service's `doctor`-style self-check.
- **A VM is ours to keep patched.** Caddy for TLS, unattended security
  updates, and a restart policy for the service are part of phase 4, not
  afterthoughts.
- **Transcripts later.** If entries prove too thin, index meeting notes
  (already summaries) before considering transcripts, and only with a
  per-project opt-in because of customer content.
