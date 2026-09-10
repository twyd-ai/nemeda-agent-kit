# Repository configuration

The canonical file is `.nemeda/agent-kit.json`.

## Single repository

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "example-project",
    "name": "Example Project"
  },
  "repository": {
    "id": "example-api",
    "role": "backend",
    "profiles": ["python", "fastapi"]
  },
  "context": {
    "instructions": ["AGENTS.md"],
    "documents": ["docs/architecture.md"]
  },
  "tools": {
    "required": ["git", "github"],
    "optional": ["google-drive", "airtable"]
  },
  "policies": {
    "protectSecrets": true,
    "conversationLanguage": "es",
    "artifactLanguage": "en"
  }
}
```

## Parent workspace

Use `workspace.repositories` when one folder coordinates several independent Git
repositories. Each child should eventually have its own configuration when it needs
more specific rules.

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "example-suite",
    "name": "Example Suite"
  },
  "workspace": {
    "repositories": [
      {
        "id": "example-backend",
        "path": "backend",
        "role": "backend",
        "profiles": ["python", "fastapi"]
      },
      {
        "id": "example-frontend",
        "path": "frontend",
        "role": "frontend",
        "profiles": ["typescript", "nextjs"]
      }
    ]
  },
  "context": {
    "instructions": ["AGENTS.md"],
    "documents": []
  },
  "tools": {
    "required": ["git", "github"],
    "optional": []
  },
  "policies": {
    "protectSecrets": true
  }
}
```

Workspace repositories may declare `remote` (and optionally `branch`); then
`nemeda-agent setup` clones them when the path is missing.

## Shared Drive (`drive`)

Declares the Google shared drive and the symlinks that connect it to the
workspace. `nemeda-agent setup` creates them; `nemeda-agent doctor` verifies
they resolve and contain content. Keys are workspace-relative link paths,
values are folders inside the shared drive.

```json
{
  "drive": {
    "sharedDrive": "Example-Workspace",
    "links": {
      "docs": "docs",
      "config": "config",
      ".claude/skills": "skills",
      ".claude/commands": "commands"
    }
  }
}
```

The Drive mount is detected language-agnostically (the "Shared drives" folder
name is localized). Set `NEMEDA_DRIVE_ROOT=/path/to/shared-drive` to override
detection (several Google accounts, Linux, tests).

`provider` selects the shared-storage client the kit looks for: `google`
(default) or `onedrive`. The validator rejects any other value. Switching
provider never changes `links`, `scaffold`, or the workspace layout — only
how the shared folder is found on disk.

```json
{
  "drive": {
    "provider": "onedrive",
    "sharedDrive": "Example-Workspace",
    "links": { "docs": "docs", "config": "config" }
  }
}
```

`sharedDrive` is looked up in whatever plays the "shared drive" role for that
provider: a Google shared drive, a personal OneDrive folder someone added a
shortcut to, or a synced SharePoint document library. A synced library is
named `<Site> - <Library>` and the library part is localized ("Documents",
"Documentos", …), so `sharedDrive: "Acme"` also matches `Acme - Documentos`.
See [drive-setup.md](drive-setup.md) for the per-platform mount locations
and [onedrive-plan.md](onedrive-plan.md) for the full design.

`nemeda-agent doctor` also warns when two candidates match equally well
(`drive-ambiguous`, e.g. the same name reachable from two accounts) instead
of silently picking one — set `NEMEDA_DRIVE_ROOT` to remove the ambiguity.

### Provisioning

`nemeda-agent setup` does not just consume the Drive structure — it creates it.
Any declared link target or `scaffold` folder missing on the shared drive is
created (create-if-absent, like everything setup does), and the four canonical
folders get a short README stating what belongs in them, so the conventions
travel with the structure to every teammate and every AI:

```json
"drive": {
  "sharedDrive": "Acme",
  "links": {
    "docs": "docs",
    "config": "config",
    ".claude/skills": "skills",
    ".claude/commands": "commands",
    ".agents/skills": "skills",
    ".agents/commands": "commands",
    ".cursor/commands": "commands"
  },
  "scaffold": ["docs/meetings", "docs/transcripts", "docs/plans", "docs/analysis"]
}
```

Linking `.claude/`, `.agents/`, and `.cursor/` to the same Drive folders gives
Claude Code, Codex, and Cursor users identical shared skills and commands
(Cursor loads commands but not skills; its users reach the kit's skills through
generated slash commands instead — see below). The `scaffold` list
is the project's docs taxonomy: setup creates it, doctor checks it, and the
session context tells every AI to file documents into it rather than leaving
files loose at the drive root.

Creating the **shared drive itself** needs the provider's own UI — the Google
Drive UI (Workspace account) or a Teams/SharePoint site synced to OneDrive;
everything inside it is automated either way. Platform notes for both
desktop clients are in [drive-setup.md](drive-setup.md) — the kit detects
mounts on macOS, Windows (junctions, no admin needed), and Linux
(rclone/gvfs for Google, rclone/onedriver for OneDrive).

## Cursor

Cursor supports the Agent Plugins standard the kit's portable core follows, so
the **plugin installs natively**: skills and the workspace-context MCP server
load exactly as they do in Claude Code and Codex, and the repository carries
the thin Cursor adapters (`.cursor-plugin/marketplace.json` at the root,
`.cursor-plugin/plugin.json` plus an always-on rule in the plugin) mirroring
the Claude and Codex ones. Install it from the Cursor marketplace, a team
marketplace (Dashboard → Plugins → Import from Repo), or a local checkout
under `~/.cursor/plugins/local`. The rule activates only in repositories that
contain `.nemeda/agent-kit.json` and points Cursor at the MCP context and
`AGENTS.md`; shared team commands reach Cursor through the `.cursor/commands`
Drive link like every other host.

For a machine that cannot install the plugin, the same wiring can be generated
per workspace instead:

```bash
nemeda-agent cursor init     # or `nemeda-agent setup` with Cursor installed
```

writes `.cursor/mcp.json`, the rule, and one slash command per kit skill,
all referencing this machine's checkout (and therefore gitignored by setup).
Skip it when the plugin is installed — the plugin already provides all three.

## Airtable (`airtable`)

Replaces the per-project constants of the legacy workspace scripts. IDs are
non-secret routing data; the personal access token lives only in the
gitignored `.env.local` (`AIRTABLE_API_KEY`).

```json
{
  "airtable": {
    "baseId": "appXXXXXXXXXXXXXX",
    "tasks": {
      "tableId": "tblXXXXXXXXXXXXXX",
      "statusField": "Status",
      "notesField": "Notes",
      "statusInProgress": "In progress",
      "statusDone": "Completed"
    },
    "knowledgeLog": {
      "tableId": "tblYYYYYYYYYYYYYY",
      "people": { "person@example.com": "recXXXXXXXXXXXXXX" }
    },
    "reconcileRepos": ["owner/backend", "owner/frontend"],
    "lookbackDays": 21
  }
}
```

- `tasks` and `knowledgeLog` both live in the base identified by the
  top-level `airtable.baseId` (Airtable's REST API is per-base, not
  per-table, so this is the only base id needed).
- `tasks` drives the PR sync: a PR body line `Airtable: recXXXXXXXXXXXXXX`
  (or a task-table URL) links the PR; unlabelled record ids are ignored on
  purpose. Statuses must match the single-select options exactly.
- `knowledgeLog.people` maps `git config user.email` to the person's record
  id in the Team/People table.
- `reconcileRepos` are the **authoritative** source of PR status: on session
  start (12 h throttle; `--force` bypasses when run by hand), `gh pr list` is
  read for both `--state open` (→ `statusInProgress`) and `--state merged`
  (→ `statusDone`, bounded by `lookbackDays`). This works regardless of how
  the PR was opened — web UI, another machine, or the `gh` CLI — because it
  reads GitHub's PR state directly rather than watching for a local command.
  A merged PR always wins over a stale open one for the same task, and a task
  already marked done is never moved backwards.
  Requires `gh` installed and authenticated; `nemeda-agent doctor` checks
  both and tells them apart.
- The `PostToolUse` hook on `gh pr create` is a fast-path only: it gives
  immediate feedback when the agent itself opens the PR from Bash, on top of
  the reconciler above — it is not a substitute for it.
- Environment switches in `.env.local`: `PR_AIRTABLE_SYNC_DISABLED`,
  `PR_AIRTABLE_SYNC_DRYRUN`, `KNOWLEDGE_LOG_AUTO`, `AIRTABLE_PERSON_ID`,
  `PR_RECONCILE_REPO`, `PR_RECONCILE_LOOKBACK_DAYS`.

## Slack bridge (`slack`)

Routes one Slack channel to this repository so a teammate can ask questions
about it without a checkout. Optional; omit it and nothing Slack-related runs.

```json
"slack": {
  "channels": ["C01ABCDEF12"],
  "owner": "U01ABCDEF12",
  "guests": ["U02ABCDEF12"],
  "backend": "claude",
  "model": "sonnet",
  "maxQuestionsPerHour": 20,
  "maxAnswerChars": 1500,
  "followThreads": true,
  "onUnauthorized": "ephemeral",
  "timeoutSeconds": 240
}
```

- Each person runs **their own** Slack app and their own runner, so a mention is
  delivered only to that person's machine and every answer is billed to that
  person's own agent subscription. One app per person, not one per project: in a
  channel, the channel decides which repository answers; in a DM, the person
  picks the project.
- The whole section is **optional**. The minimal install is machine-local only:
  set `owner` (your Slack member ID) and `repos` in `~/.nemeda/runner.json`, and
  every listed repository is answerable in DMs with no repository changes at
  all. The registry's `channels` map (`{"C…": "project-id"}`) routes channels
  the same way. A repository's own `slack` section overrides the registry when
  present, and is the right place for anything teammates should review, such as
  `guests`.
- **DMs are the everyday surface.** No mention needed; the DM is one ongoing
  conversation per project, resumed across restarts. With several projects, pick
  one with `usa <proyecto>` (sticky until changed) or per-message with
  `<proyecto>: la pregunta`; with one project there is nothing to pick. The
  runner lists what it serves when it cannot tell which you mean.
- `owner` is the Slack user the runner belongs to. `guests` are the teammates it
  also answers — typically product or delivery people with no subscription and
  no checkout. Anyone else is refused; `onUnauthorized: "ephemeral"` tells them
  which bot to mention instead, `"silent"` says nothing.
- Adding a guest grants them read access to this codebase through the bot.
  Treat the channel list and the guest list as access control.
- `followThreads` lets the runner answer follow-ups in a thread it already
  replied in, without a new mention. The Slack thread is the agent session, so
  context carries across the thread.
- `sourceRef` (for example `origin/main`) answers from a detached mirror
  worktree instead of the operator's working tree. Turn it on when more than one
  person runs a runner for the same repository, so their answers cannot diverge
  and a dirty local checkout stays private.
- The backend runs read-only by construction: built-in tools are narrowed to
  `Read`, `Grep`, and `Glob`, and `Bash`, `Write`, `Edit`, and the network tools
  are denied. A Slack message can never make the agent change anything.
- The manifest asks for the minimum scopes. `conversations.info` is not among
  them, so `slack doctor` cannot confirm the bot was invited to a channel and
  warns instead. Adding `channels:read` (and `groups:read` for private channels)
  upgrades that warning to a real check, at the cost of reinstalling the app —
  which issues a new bot token.
- Tokens are never stored here. They live in `~/.nemeda/.env.local`
  (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`), together with the runner registry
  `~/.nemeda/runner.json` that lists which repositories this machine serves.

Commands:

```bash
nemeda-agent slack init                 # ~/.nemeda/runner.json + token file
nemeda-agent slack manifest             # the Slack app manifest to paste
nemeda-agent slack ask "..."            # answer one question locally, as Slack would
nemeda-agent slack doctor               # registry, routing, tokens, channel membership
nemeda-agent slack run                  # the Socket Mode runner, in the foreground
nemeda-agent slack install              # macOS LaunchAgent, starts at login
```

Use `slack ask` before creating any Slack app: it runs the exact backend path
the runner uses and prints what Slack would render, which is how the voice gets
tuned without spending a real conversation.

### Provisioning a base

```bash
nemeda-agent airtable init --name "Acme" --workspace-id wspXXXXXXXXXXXX
```

creates the canonical base through the Airtable Meta API — Backlog (Status/
Notes/Priority/Owner), Team (Name/Email/Role), Knowledge Log (with the exact
field names the hooks write, including the Person link to Team) — and prints
the `airtable` config snippet to paste into `.nemeda/agent-kit.json`. Needs an
`AIRTABLE_API_KEY` with the `schema.bases:write` scope; the workspace id is in
the airtable.com URL.

## Meeting capture (`meetings`)

Turns finished meeting recordings into transcripts filed on the shared drive.
Optional; omit it and `nemeda-agent meeting` refuses to run. Design and
roadmap in [meeting-capture-plan.md](meeting-capture-plan.md); this is what
phases 1 to 3 ship.

```json
"meetings": {
  "inbox": "docs/recordings/inbox",
  "transcripts": "docs/transcripts",
  "notes": "docs/meetings",
  "language": "es",
  "naming": "{date}-{slug}"
}
```

- `transcripts` (required): workspace-relative folder that receives one
  `<date>-<slug>/` folder per recording, with `transcript.txt`,
  `transcript.srt`, `transcript.json` (normalised segments), and
  `meta.json` (source, checksum, duration, engine, model, language, host).
  Put it inside the `docs` Drive link so the whole team gets it.
- `notes`: folder for the meeting notes generated from transcripts (later
  phase; validated now so the taxonomy is stable).
- `language`: language code or `auto`; defaults to
  `policies.conversationLanguage`.
- `naming`: folder template; `{date}` is required, `{time}` and `{slug}`
  optional. The slug comes from `--title`, sanitised to the strictest shared
  drive's character set.
- `inbox`: shared-drive folder where recorders drop finished recordings and
  transcribers pick them up (see Team roles). Optional; without it every
  machine records and transcribes on its own.
- `knowledgeLog`, `recordings`: reserved for the notes phase; accepted and
  validated, not yet acted on.

Machine-local settings go in `.env.local`, never in the shared config.
`nemeda-agent meeting setup` writes the first two after choosing for you:

```
NEMEDA_MEETINGS_ROLE=full                      # recorder | transcriber | full (default)
NEMEDA_MEETINGS_ENGINE=apple-speech            # apple-speech | whisper-cpp; default: what doctor selects
NEMEDA_WHISPER_MODEL=~/.nemeda/models/ggml-large-v3-turbo.bin   # whisper only; default: best ggml-*.bin in ~/.nemeda/models or ~/whisper-models
NEMEDA_MEETINGS_WATCH=/Users/me/Movies        # default: OBS's recording folder from its active profile
NEMEDA_WHISPER_BIN=whisper-cli                 # default: whisper-cli on PATH
NEMEDA_YAP_BIN=yap                             # default: yap on PATH
NEMEDA_MEETINGS_THREADS=8                      # whisper only; default: all cores
```

### Team roles

Not every machine has to transcribe. With `meetings.inbox` declared, each
machine picks a role in `.env.local`:

| Role | Does | Needs |
|---|---|---|
| `recorder` | copies every finished local recording into the inbox, once | the Drive link only |
| `transcriber` | drains the inbox: claims a recording, transcribes it, files the transcript | an engine (plus a model for whisper) |
| `full` (default) | transcribes its own recordings and, when an inbox exists, the team's | same as transcriber |

One transcriber per team is enough, usually the most capable Mac. Several
can run at once: a recording is claimed by renaming it to
`<name>.claimed-<host>` (atomic, invisible to the other transcribers) and
renamed back when done; what is done is recorded in `<inbox>/.processed.json`
by name, so it is the same on every machine whatever its mount path; and each
transcriber leaves a heartbeat in `<inbox>/.transcribers.json` that a
recorder's `doctor` reads to warn when nobody has transcribed for 48 hours.
A claim left by a machine that died is released the next time that machine
runs; claims by other machines are listed by `meeting list` and never
touched. Originals stay where the recorder put them.

### Engines

- **`whisper-cpp`** is the cross-platform base: `whisper-cli` from
  whisper.cpp plus a ggml model, on macOS, Windows, and Linux. Needs `ffmpeg`.
- **`apple-speech`** is selected automatically on macOS 26 with Apple Silicon
  when the `yap` CLI is installed: the system's SpeechAnalyzer model, nothing
  to download, no dedicated memory, two to three times faster than whisper
  turbo, somewhat less accurate. `--engine whisper-cpp` (or the variable)
  brings the base engine back for a critical meeting.

No model is required. For whisper, `doctor` recommends a tier from the
hardware: `large-v3-turbo` on Apple Silicon or with an NVIDIA GPU, `small`
on a CPU-only machine with 8 GB or more, and none below 4 cores or 8 GB (that
machine should only record). `base` exists for `setup --model base`.

### Commands

- `nemeda-agent meeting list`: ready (untouched for 60 seconds), still being
  written, and already transcribed recordings, plus the selected engine.
- `nemeda-agent meeting process [FILE] [--title …] [--engine …]`: transcribes
  every ready recording, or one file. Every recording is processed once
  (`.nemeda/state/meetings.json`), existing transcript folders are never
  overwritten (a second recording with the same name gets a numeric suffix),
  and the original recording is left where it was.
- `nemeda-agent meeting doctor`: role, inbox and transcriber heartbeat,
  machine capability and estimate per hour of audio, engine selection and
  why, ffmpeg and model, recordings folder, transcripts/notes folders and
  whether they sit inside a Drive link, and the local and inbox backlogs. A
  recorder only gets the role, inbox, and recordings-folder checks. The same checks appear in `nemeda-agent doctor` and the
  `workspace_doctor` MCP tool when the section exists.
- `nemeda-agent meeting setup [--obs] [--model TIER] [--yes] [--dry-run]`:
  shows the plan (Homebrew or winget installs, model download to
  `~/.nemeda/models/`, `.env.local` lines), asks for confirmation, then runs
  it. Commands that need `sudo` or a manual download are printed, never run.
  `--obs` adds OBS Studio; OBS itself is recommended, not required, because
  any recording that lands in the watched folder is processed.

At session start a hook adds one context line when recordings are waiting, so
the agent can offer to run `meeting process`; it never transcribes by itself.

## Project memory (`memory`)

Session summaries, decisions, findings, and meeting outcomes, replacing the
Airtable Knowledge Log. Optional; omit it and `nemeda-agent memory` refuses
to run. Full design, storage rationale, and the central-database layer in
[memory-plan.md](memory-plan.md); this is what the project layer ships.

```json
"memory": {
  "project": {
    "path": ".nemeda/memory",
    "tags": ["architecture", "api", "deployment"]
  }
}
```

- `project.path` (required): workspace-relative folder that holds the
  journals. Put it inside a `drive.links` entry (e.g.
  `".nemeda/memory": "memory"`) so every teammate shares it; `doctor` warns
  when it resolves to a plain local folder instead.
- `project.store`: `journal` (default) — one append-only JSONL file per
  author under `<path>/journal/<email>.jsonl`, safe with Google Drive and
  OneDrive sync clients because each file has exactly one writer. A cloud
  sync client does not honour SQLite's cross-machine locking, so a single
  shared `.sqlite` file is only offered as an explicit `sqlite-file` opt-in
  for a one-person project.
- `project.tags`: suggested tags shown by the reviewed-logging flow; free
  text, never enforced.
- `central` (optional): connects to a company-wide PostgreSQL database
  provisioned entirely outside the kit — see memory-plan.md's contract. Not
  implemented yet in the CLI; the config shape is validated ahead of that
  work landing.

`nemeda-agent memory add` appends one entry (`--type`, `--title`, `--tags`,
the prose summary on stdin, or the whole entry as JSON with `--json`),
`memory list` and `memory search "query"` read every author's journal.
Entries are attributed to `git config user.email`; `nemeda-agent doctor`
checks the folder resolves through Drive, this author's journal is
writable, and flags sync-client conflict copies in `journal/`.

`nemeda-agent memory review [ID] [--all]` completes a `pending` entry into
`reviewed`, optionally with changes (`summary`, `clientSummary`, `tags`, ...)
as JSON on stdin; with no ID it lists the pending inbox, author-scoped by
default (`--all` lists everyone's, for visibility). **Only the entry's own
author can review it** — a journal has exactly one writer by design, so a
different machine appending a revision to someone else's journal file would
reintroduce the concurrent-write problem journals exist to avoid. The
`memory-log` skill drives the confirm-before-write reviewed-logging flow
end to end (portable replacement for the per-project Drive `klog.md`
commands); `nemeda-agent doctor` and its Airtable-based predecessor keep
working during the migration window.

The kit's MCP server exposes three read-only tools backed by the same
journals: `memory_search` (full-text, with the same `type`/`author`/
`status`/`since` filters as the CLI), `memory_recent`, and `memory_get` by
id. No `central` support yet — see memory-plan.md's phase 1b.

### Query index

`memory list`, `memory search`, and the MCP `memory_*` tools answer through a
machine-local SQLite cache at `.nemeda/state/memory.sqlite`. It is never on
the shared drive — every machine builds its own from the journals, which
remain the only source of truth — and it is gitignored with the rest of
`.nemeda/state/`. It rebuilds itself whenever any journal changes, so there
is nothing to maintain; deleting it is always safe.

The engine is picked automatically: `node:sqlite` when the Node runtime has
it (22.13+), else the `sqlite3` binary, else no index at all and every query
reads the journals directly. All three return identical results in the
same order. If the index engine fails, the query is answered from the
journals and the CLI says so on stderr. `nemeda-agent memory index` shows the
engine and whether the index is up to date; `--rebuild` forces a rebuild.
`NEMEDA_SQLITE_BIN` points at a non-default `sqlite3`, and
`NEMEDA_MEMORY_INDEX_ENGINE` (`node-sqlite`, `sqlite3-cli`, `memory`) pins
one engine.

### Unattended capture (`memory.harvest`)

`SessionStart` and `Stop` hooks record every session against a repository
with a `memory` section in `.nemeda/state/sessions.json` (which host, which
model, when it started, when it was last active) — free, no model call,
always on. `nemeda-agent memory harvest [--session ID] [--dry-run]`
resumes each closed session (idle 30 minutes by default) through its own
host CLI — `claude -p --resume` or `codex exec resume` — with a prompt
asking for JSON project-memory entries, files whatever validates, and marks
the session harvested either way, so a permanently broken session is never
retried forever.

```json
"memory": {
  "harvest": { "idleMinutes": 30, "maxSessionsPerRun": 5, "hosts": ["claude", "codex"] }
}
```

All three keys are optional and default to what is shown. **Harvesting
itself never runs unless `MEMORY_HARVEST=true` is set in `.env.local`** —
it invokes the host CLI and therefore costs tokens; recording activity in
the ledger is free and always on regardless of that flag.
`NEMEDA_CLAUDE_BIN` / `NEMEDA_CODEX_BIN` in `.env.local` override which
binary runs, for a non-default install or for tests.

Nothing calls `memory harvest` automatically yet — no opportunistic trigger
from `SessionStart`, no `memory install` scheduler, no doctor check, no
`SessionStart` context line naming what is pending review. Run it by hand,
or from your own cron/scheduled task, until that lands; see
memory-plan.md's phase 1b-iii for the design.

`airtable.knowledgeLog` still works but is deprecated in favor of this
section (`nemeda-agent doctor` reports it); it will be removed once the
central layer ships.

## Rules

- Paths are relative to the directory containing `.nemeda/`.
- Instruction files must resolve inside that directory tree.
- `documents` are discoverable references, not automatically injected context.
- Tool names describe required capabilities; authentication remains personal.
- Configuration may contain non-secret IDs, but never credentials or customer data.
