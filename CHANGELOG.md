# Changelog

## Unreleased

### Added

- `nemeda-agent memory import-airtable`: migrates an Airtable Knowledge Log
  into project memory, one import journal per base, every entry under its
  real author from the Team table, re-runnable without duplicates.
- `NEMEDA_MEMORY_AUTHOR` (environment or `~/.nemeda/.env.local`): the email
  every memory path attributes entries to, instead of `git config
  user.email`, for people whose git email is a GitHub noreply address. The
  new `memory-author` doctor row warns about a noreply identity.
- Workspace configuration on the shared drive: a local
  `.nemeda/agent-kit.link.json` names the drive, and the kit reads
  `config/agent-kit.json` (and `AGENTS.md`) from it, so a project whose code
  repositories cannot be touched needs no repository just for its
  configuration. A last good copy keeps the workspace working when the drive
  is not mounted or a bad edit lands; `doctor` reports `config-source` and
  the cache, mismatch, and conflict-copy cases
  ([drive-config-plan.md](docs/drive-config-plan.md)).

### Changed

- The test suite points `NEMEDA_HOME` at a temporary directory, so it never
  reads a developer's personal `~/.nemeda`.
- `nemeda-agent memory` commands report that the workspace configuration
  could not be read, with the reason, instead of claiming the `memory`
  section is missing.
- `nemeda-agent meeting` commands and the `workspace_meetings` tool report
  an unreadable configuration the same way.

### Security

- The central memory client refuses HTTP redirects, so a redirect can never
  carry the personal token to another host.
- `memory.central.tokenVariable` and `urlVariable` must start with
  `NEMEDA_MEMORY_`, so a configuration can never make the kit send another
  secret (an Airtable or Slack token) as its bearer token.
- The central memory origin and the promoted project are pinned: a
  workspace pins them on first use, and a later change sends nothing until
  a person confirms it with `nemeda-agent memory trust` at an interactive
  terminal. `doctor` reports `central-origin` and `central-project`.
- The memory folder must resolve inside its shared drive, and a move within
  the drive pauses the unattended writers (harvest, meeting entries, the
  automatic sync) until `memory trust`; interactive commands warn and
  `doctor` reports `memory-destination`.
- The same applies to the meetings folders (transcripts, notes, inbox,
  archive): a move pauses the `meeting watch` loop until `memory trust`,
  `meeting process` warns, a folder outside the shared drive is refused, and
  `doctor` reports `meetings-destination`. A meeting memory entry that is
  paused now says why.
- Instructions read from the shared drive are marked in the session context,
  and a change since the last session raises `config-instructions`. A drive
  copy that names another shared drive, or resolves outside its drive, is
  refused.

## 0.4.0 — 2026-09-15

The release that turns the kit from repository context into a working
memory for the team: meetings and sessions are captured, reviewed, and
shared, first inside each project and then across the company.

### Added

- **Microsoft OneDrive and SharePoint** as an alternative to Google Drive
  for `drive.links`: a provider registry, mount detection on macOS, Windows,
  and Linux, library matching, and doctor checks
  ([drive-setup.md](docs/drive-setup.md)).
- **Meeting capture**: finished recordings (OBS or any folder) are
  transcribed locally — whisper.cpp, or Apple's speech engine on macOS 26 —
  and filed under the project's transcripts; recorder and transcriber roles
  over a shared inbox; notes written by the local agent; retention rules; an
  unattended watch service; `nemeda-agent meeting …` and the
  `workspace_meetings` MCP tool ([meeting-capture.md](docs/meeting-capture.md)).
- **Project memory**, replacing the Airtable Knowledge Log: one append-only
  journal per person on the shared drive, `nemeda-agent memory
  add|list|search|review`, the `memory-log` skill, the `memory_search`,
  `memory_recent`, and `memory_get` MCP tools, and a machine-local SQLite
  index ([memory-plan.md](docs/memory-plan.md)).
- **Unattended session capture**: hooks record every Claude Code and Codex
  session; `memory harvest` summarises closed sessions through the host's
  own CLI (opt-in with `MEMORY_HARVEST=true`), started automatically at
  session start or on a schedule (`memory install`).
- **Central memory**, the company-wide layer served by
  `nemeda-memory-service`: `memory sync` promotes reviewed entries,
  `memory search --central`, `memory doctor`, `memory recap`,
  `memory close`/`reopen`, an automatic sync at most every 12 hours, a
  read-only proxy of the `memory_central_*` tools for Codex and Cursor
  (and Claude Code on request), and `memory sync --via psql` for
  administrators ([configuration.md](docs/configuration.md#central-memory-memorycentral)).

### Changed

- The kit now lives at `twyd-ai/nemeda-agent-kit`: install commands, the
  organization marketplace, and every manifest's `repository`/`homepage`
  point there.
- `nemeda-agent memory add --json` accepts `"status": "reviewed"`, and the
  `memory-log` skill uses it: an entry the person confirmed is reviewed.

### Fixed

- The Claude plugin manifest no longer declares `displayName`, which made
  Claude Code and Claude Desktop reject the plugin.

### Deprecated

- `airtable.knowledgeLog`: use the `memory` section. It keeps working until
  `nemeda-agent memory import-airtable` can migrate existing Knowledge Logs.

### Upgrading

- Update the marketplace and the plugin in each host (Claude Code, Codex,
  Cursor), then restart the host so hooks and the MCP server reload.
- Nothing changes for a repository until it adds a `memory` or `meetings`
  section to `.nemeda/agent-kit.json`; `nemeda-agent doctor` explains what
  is missing.
- For central memory, put your personal token in `~/.nemeda/.env.local` as
  `NEMEDA_MEMORY_TOKEN=…` (`chmod 600` the file) and never commit it.

Since the previous version bump the kit also gained the team Slack relay,
Cursor as a first-class host, and whole-workspace provisioning (Drive
taxonomy, Airtable, any OS).
