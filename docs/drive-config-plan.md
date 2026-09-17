# Workspace configuration on the shared drive

Status: approved by Miguel on 2026-09-17, after the memory session's review
(token-resolution cut point, token-variable prefix, redirects, project pin,
instruction change warnings, paused unattended writers, configuration
readers on client drives). Phase 0 is done; the rest
is not implemented.

Today a workspace is configured by `.nemeda/agent-kit.json`, found by walking
up from the working directory, and shared with the team through Git. That
works when the project has a repository of its own. It does not fit two
common cases:

- **Client repositories that must not be touched.** Scharlab and CTTC were
  migrated to project memory from local, untracked workspaces for exactly
  this reason; nobody else can use those workspaces.
- **Several code repositories and no appetite for a repository that only
  holds three configuration files.**

Every teammate already mounts the project's shared drive, and the file holds
no secrets. This plan lets the configuration live on that drive, with a
small local pointer that tells the kit where to find it.

## Constraints

- The configuration stays identical for the whole team. Values that differ
  per machine keep living in `.env.local` and `~/.nemeda/.env.local`.
- One source of truth per project: no copies that drift. Editing the file on
  the drive reaches everyone at their next command or session.
- Repository-hosted configuration keeps working exactly as today, and wins
  when both exist.
- A broken or unreachable drive copy must not break every teammate at once.
- No new way to leak a token (see Threat model).
- Zero dependencies, and the lookup stays synchronous: `readWorkspaceContext`
  is called from hooks and the MCP server.

## What the kit already gives us

- **One choke point.** Every consumer (CLI, hooks, MCP server, meetings,
  memory, harvest, setup, Slack) loads configuration through
  `readWorkspaceContext` in `scripts/lib/workspace.mjs`, which calls
  `findWorkspace`. Supporting a second source there covers the whole kit.
- **Drive detection.** `findSharedDrive(name, env, platform, provider)` in
  `scripts/lib/drive.mjs` already locates Google shared drives, OneDrive
  shortcuts, and synced SharePoint libraries on macOS, Windows, and Linux,
  honours `NEMEDA_DRIVE_ROOT`, and reports ambiguity.
- **Relative paths.** Every path in the configuration is relative to the
  workspace root (the folder containing `.nemeda/`). That root stays local
  in this design, so links, meetings folders, memory path, and repository
  paths keep their meaning unchanged.
- **Sync-conflict detection** for journals (`JOURNAL_CONFLICT_PATTERN`),
  reusable for the configuration file.

## Design

### The pointer file

A new file, `.nemeda/agent-kit.link.json`, in the local workspace root:

```json
{
  "schemaVersion": 1,
  "source": {
    "provider": "google",
    "sharedDrive": "Scharlab-Workspace",
    "path": "config/agent-kit.json"
  }
}
```

- `provider` and `sharedDrive` mean exactly what they mean in `drive`.
  `path` is relative to the shared drive root, defaults to
  `config/agent-kit.json`, and must stay inside it.
- A distinct file name, rather than a new key in `agent-kit.json`, so a
  pointer is never mistaken for a full configuration and a kit older than
  this feature sees an unconfigured folder instead of an invalid one.
- The pointer is machine-independent and non-secret, so it may be copied
  between machines or committed where that is allowed.

### Lookup

`findWorkspace` checks each directory, walking up as today, for
`agent-kit.json` first and `agent-kit.link.json` second. The first directory
with either one is the root. A full file in the same directory wins over a
pointer, and `doctor` warns when both exist.

For a pointer, `readWorkspaceContext`:

1. Resolves the shared drive with `findSharedDrive` (environment merged with
   the workspace `.env.local`, so a per-project `NEMEDA_DRIVE_ROOT` works).
2. Reads and validates the drive copy with the existing `validateConfig`.
3. Requires `drive.provider` and `drive.sharedDrive` in that copy to match
   the pointer, so a file copied to another project's drive is caught. For
   a project whose memory and configuration live apart from its drive
   (decision 5), this match gives way to the project pin, which then records
   the content drive as well.
4. On success, writes a last-good copy to `.nemeda/state/config-cache.json`
   with its source path, modification time, and checksum.
5. On failure (drive not mounted, file still a streaming placeholder,
   invalid JSON, validation error, mismatch), falls back to the last-good
   copy when there is one, and adds an issue that names the cause. With no
   cache, it returns `mode: "configured"` with the error, as an invalid local
   file does today.

The returned context gains `configSource: "repository" | "drive" |
"drive-cache"` and the drive path, so the session context line, `context`,
and `doctor` say where the configuration came from.

Reading one small file per command is cheap on a hydrated drive. A
placeholder read can block while the client downloads it. The doctor
already spots placeholders without reading them (`hasPlaceholderFiles`: a
non-empty file with no allocated blocks), so the hook path applies the same
test to the configuration file and takes the cache when it is still a
placeholder, leaving the download to the next command.

### Instructions and documents

`context.instructions` are refused today when their real path leaves the
workspace root, which would reject an `AGENTS.md` that lives on the drive.
For a drive-hosted configuration, instructions and documents may resolve
inside either the local root or the folder that holds the drive copy, with
the same realpath, size, and secret-name checks. This lets the project keep
one shared `AGENTS.md` next to its configuration on the drive.

This is not quite the exposure drive editors already have through shared
skills and commands: a skill has to be invoked, while instructions are
injected into every session by the context hook. So instructions read from
the drive are marked as such in the session context line and in `doctor`,
and `doctor` warns when their checksum changed since the last session on
this machine.

### Protecting the token and the routing

A drive-hosted configuration moves the power to edit routing from people
with push rights to people with edit rights on a drive folder. Five things
in the configuration decide where a secret or project content goes, and
each gets a guard. Guards 1 to 3 apply to every configuration, whatever its
source, because they close gaps that exist today.

1. **Service origin (`memory.central.mcpUrl`).** The kit pins the origin per
   person in `~/.nemeda/central-origins.json`. A repository-hosted
   configuration records its origin silently on first use, so nothing
   changes for existing workspaces. A drive-hosted configuration records it
   only through an explicit step: `init --from-drive` shows the URL and
   asks, or `nemeda-agent memory trust <url>`.
2. **Token variable (`memory.central.tokenVariable`, `urlVariable`).** Today
   any variable name is accepted and resolved from the environment,
   `~/.nemeda/.env.local`, and the workspace `.env.local`. An editor could
   set it to `AIRTABLE_API_KEY` or `SLACK_BOT_TOKEN`, and the kit would send
   that secret as a bearer token, even to the legitimate service, where it
   would reach the logs. The validator will require the `NEMEDA_MEMORY_`
   prefix for both keys. Only the defaults are in use, so this breaks no
   one.
3. **Redirects.** `centralFetch` follows redirects by default, so a pinned
   origin that redirects elsewhere could carry the `Authorization` header
   along, depending on the runtime version. The service never redirects API
   calls, so the client will use `redirect: "error"`.
4. **Project identity and write destinations.** A changed `project.id`
   promotes entries into another registered project. With every person
   reading every project that is misfiling, but once `people.projects`
   scopes readers (contractors, client-side readers) it becomes disclosure,
   and the automatic sync would make it silent. The kit pins `project.id`
   per workspace in `.nemeda/state/` together with the service origin, on
   the same trusted first use, and refuses memory writes and syncs when it
   changes until `memory trust`. Write destinations need no pin: link
   targets, `memory.project.path`, and the meetings folders are already
   validated as relative paths without `..`, and the drive copy must name
   the pointer's provider and shared drive, so journals and transcripts
   cannot be sent to another project's drive. At runtime the kit also
   checks that the memory and meetings folders resolve inside that shared
   drive, which covers a stray local symlink.
5. **Moves within the drive.** A folder inside a shared drive can be shared
   more widely than the drive itself (Google allows sharing shared-drive
   folders beyond the members; SharePoint and OneDrive have per-folder
   permissions), so moving the memory or meetings folder can still widen
   its audience. A `doctor` warning alone would go unseen, because most
   writes are unattended: harvest, the meetings watch loop and its memory
   entries, and the automatic sync. So the kit records the resolved memory
   and meetings folders per workspace in `.nemeda/state/` and, when one
   changes, unattended writers refuse and log why, and the next session's
   context line says writes are paused and names the command to resume.
   Interactive commands only warn. One `memory trust` confirms the new
   folders together with any other changed pin, so a legitimate
   reorganization costs one confirmation and never raises repeated
   alarms.

**Where the check sits.** Not in each consumer. `resolveCentralToken` is the
step every consumer takes before sending the token: the sync transport,
`memory search --central`, the MCP proxy, the online doctor rows, and the
automatic sync trigger. `centralSettings` receives the configuration source
from the context, and `resolveCentralToken` returns no token, with the
reason `untrusted-origin` or `untrusted-project`, when a pin does not match.
Every consumer then refuses with the same message, naming both values and
the command to trust the new one, and none can bypass it. The `SessionStart`
auto-sync logs the refusal and never prompts. `/health` sends no token, so
`memory doctor` keeps showing the new URL.

Airtable and Slack tokens go to fixed vendor hosts, not to addresses from
the configuration, so they need no origin pin; guard 2 keeps them from being
sent to the memory service.

### Initializing and moving

- `nemeda-agent init --from-drive "<shared drive>" [--provider onedrive]
  [--path config/agent-kit.json]` finds the drive, reads and validates the
  copy, prints the project, its sections, and the central URL, asks for
  confirmation, writes the pointer, pins the origin, and prints the next
  steps (`setup`, `doctor`). It never overwrites an existing file.
- When the local folder is inside a Git repository that must not change,
  `init` adds `.nemeda/` to `.git/info/exclude` instead of `.gitignore`. The
  recommended layout is still a plain parent folder that holds the pointer
  and the cloned code repositories, which the upward lookup already
  supports.
- `nemeda-agent config publish` copies an existing local `agent-kit.json` to
  the drive path, refuses to overwrite a different drive copy, and replaces
  the local file with a pointer only after reading the drive copy back. This
  is the migration path for the Scharlab and CTTC workspaces.

### Doctor

New checks, all offline except where noted:

| Code | Level | When |
|---|---|---|
| `config-source` | pass | Always; says repository, drive, or cache, with the path |
| `config-drive` | fail | Drive not found, file missing, or invalid, and no cache |
| `config-cache` | warn | Running on the cached copy, with its age and the cause |
| `config-mismatch` | fail | Drive copy names a different provider or shared drive |
| `config-conflict` | warn | Sync-client conflict copies next to the drive file |
| `config-both` | warn | Full file and pointer in the same folder |
| `config-instructions` | warn | Instructions come from the drive and changed since the last session |
| `central-origin` | fail | Central URL not pinned for this person |
| `central-project` | fail | `project.id` differs from the one pinned for this workspace |
| `memory-destination` | warn or fail | Memory or meetings folder moved within the drive, so unattended writes are paused (warn), or resolves outside it (fail) |

## Threat model

| Actor | Can already | Gains with this plan | Mitigation |
|---|---|---|---|
| Drive editor | Change shared skills, commands, docs, memory journals | Change routing and injected instructions | Guards 1 to 4; instructions marked with change warnings; restrict edit rights on `config/` where the provider allows it |
| Drive viewer | Read everything on the drive | Nothing: the file holds no secrets | None needed |
| Repository contributor | Change a repository-hosted configuration | Nothing new; guards 2 and 3 also close today's gaps | Unchanged |

Residual risk after the guards: a drive editor can still change which
instructions every session loads, which stays within an audience that
already has edit rights on that drive and is reported on change. A folder
move reaches content only after a person confirms it.

**Readers of the configuration itself.** The file holds no secrets, but it
is not written for client eyes either: it can carry Airtable person
mappings keyed by e-mail, Slack member IDs, internal repository names, and
the central memory URL. The memory journals next to it are more sensitive
still. A project drive may include client staff, so where both live is a
disclosure decision; see decision 5.

## Phases

0. **Redirects.** `redirect: "error"` in `centralFetch` (guard 3). Done in
   ee98d48, with a test, verified against production.
1. **Loader.** Pointer file, lookup order, drive resolution, last-good cache,
   instruction roots with source marking and checksum warnings, the
   `configSource` field, context and doctor reporting, schema for the
   pointer. Tests with temporary drive layouts through `NEMEDA_DRIVE_ROOT`
   for every failure path and the cache fallback, including a scheduled
   harvest or meetings watch that starts at login before the drive client
   has mounted. Owner: meeting-capture session.
2. **Guards.** Origin and project pins with `memory trust`, the
   `NEMEDA_MEMORY_` prefix for `tokenVariable` and `urlVariable`, the
   `untrusted-*` reasons in `resolveCentralToken`, the runtime containment
   check, and the folder pins that pause unattended writers (guard 5).
   Owner: memory session for the memory writers and the shared pin store;
   meeting-capture session for the meetings watch loop, which uses the same
   store.
3. **Init, publish, and docs.** `init --from-drive`, `config publish`,
   `.git/info/exclude`, `configuration.md`, `drive-setup.md`, and the team
   guide. Messages that name `.nemeda/agent-kit.json` literally say
   "workspace configuration". Then move the Scharlab and CTTC configurations
   to their drives. Owner: meeting-capture session, with the memory session
   reviewing the memory paths.

Phase 2 must ship before or with phase 3: a drive-hosted configuration
without the guards is the exposure described above.

**Moving Scharlab and CTTC.** Their migration workspaces live in
`~/.nemeda/migrations/scharlab` and `~/.nemeda/migrations/cttc`, each with a
complete `agent-kit.json` (`project.id` `scharlab` and `cttc`), the link to
its memory folder on the drive, and its local state. `config publish` moves
only the configuration file, to `config/agent-kit.json` on each project's
own drive, whose members are all internal (decision 5); the imported
journals are already on those drives.

## Coordination

`workspace.mjs`, `cli.mjs`, the schema, and `configuration.md` are shared
hotspots under the two-session protocol: append-only edits, `pull --rebase`
before every push, and each session commits only its own files. Phase 1
changes `findWorkspace` and `readWorkspaceContext`, which every feature
uses, so it lands behind the full suite with no behaviour change for
repository-hosted configurations.

## Decisions

Taken by Miguel on 2026-09-17.

1. **Pointer name:** `agent-kit.link.json`.
2. **`AGENTS.md`** for drive-hosted projects lives next to the configuration
   on the drive.
3. **Edit rights on `config/`** are restricted to project leads where the
   provider supports folder-level permissions. The kit does not depend on it.
4. **Offline behaviour:** the cached copy is used without an age limit, with
   a warning. An age limit would turn a long flight into a broken workspace.
5. **Which drive holds the configuration.** The question is really about
   the memory, not the configuration. The configuration is routing; the
   memory journals are internal content, the summaries that Airtable kept
   apart from the client-facing summary. So the rule is:
   - `memory.project.path` must sit where no client account is a member.
   - The configuration goes wherever the memory goes, or somewhere more
     restricted.

   Two ways to satisfy it:
   - **The project's own drive** (the design above), when its members are
     all internal. Simplest: one drive, and the pointer names it.
   - **A separate, more restricted location** for the memory and the
     configuration, when the project drive includes client accounts. This
     means the pointer's drive may differ from `drive.sharedDrive`, so
     guard 4 can no longer rely on the two matching; instead the project pin
     also records `drive.provider` and `drive.sharedDrive`, with a change
     handled like any other pin.

   Evidence, checked read-only on 2026-09-17: the Scharlab-Workspace drive
   has seven members and CTTC two, all `@nemeda.io`, with no client accounts
   and no open links. Both are internal in practice, so both use their own
   drive. A company-wide internal drive is not the default: the existing
   Nemeda drive holds company documents, so adding every project
   collaborator to it would widen what they see.

   The kit cannot see drive membership from the file system, so this is not
   a `doctor` check. It is a documented step: `drive-setup.md` and the
   `workspace-create` skill say to confirm, when the memory folder is
   created, that the drive includes no client accounts, and to move the
   memory elsewhere if that ever changes.

   Decision: support both, default to the project's own drive, and keep the
   separate location for projects whose drive is shared with the client.
