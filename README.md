# Nemeda Agent Kit

Portable methodology, tools, and repository context for AI coding agents.

Nemeda Agent Kit gives Claude Code, Codex, Cursor, and Agent Plugins-compatible
hosts the same operational baseline without copying skills or tool configuration into every
project. A small `.nemeda/agent-kit.json` file identifies each repository; normal
project instructions stay in `AGENTS.md`.

> Status: early release. The core (skills, MCP context, CLI, Airtable hooks) is
> in daily use; the Slack relay is newer and has been exercised by one team.
> Interfaces may still change before 1.0.

## What it includes

- Agent Skills for workspace discovery, bootstrap, diagnostics, and safe
  multi-repository work.
- A read-only MCP server that exposes normalized workspace context and health
  checks.
- A zero-dependency CLI: `nemeda-agent init`, `setup`, `context`, `doctor`, and
  `slack`.
- **Shared-workspace assembly and provisioning** (`nemeda-agent setup`): the
  shared drive structure itself — Google Drive or OneDrive/SharePoint,
  `drive.provider` in the config — (folders created when missing, each
  carrying a README with its filing conventions, plus a declared docs
  taxonomy), the
  workspace symlinks (`docs/`, `config/`, skills and commands for both Claude
  and Codex; directory junctions on Windows), declared code repository clones,
  an `.env.local` template, and the matching `.gitignore` entries — all
  declared in `.nemeda/agent-kit.json` instead of per-project shell scripts.
  Drive detection works on macOS, Windows, and Linux
  ([drive-setup.md](docs/drive-setup.md)).
- **Project provisioning end to end**: the `workspace-create` skill walks a new
  project from nothing to a replicable workspace — Drive structure, workspace
  repo, code repos, and a canonical Airtable base created through the API
  (`nemeda-agent airtable init`) with the exact tables and fields the hooks
  expect. A teammate replicates it with clone + `nemeda-agent setup`, and every
  AI session receives the same project map and filing conventions.
- **Airtable automations as plugin hooks**, parameterized by the same config:
  - A session-start reconciler reads open and merged PRs directly from GitHub
    (via `gh pr list`) and moves tasks with a matching `Airtable: recXXX` line
    to the configured in-progress or done status (throttled to once per 12 h,
    idempotent). This is the authoritative sync — it works no matter how the
    PR was opened (web UI, another machine, `gh` CLI), because it reads
    GitHub's own PR state instead of watching for a local command.
  - `gh pr create` run from the agent's own Bash tool gets an immediate
    fast-path update on top of that, for instant feedback.
  - An opt-in session logger (`KNOWLEDGE_LOG_AUTO=true`) creates one Pending
    Knowledge Log entry per session.
  Every hook is a fast no-op in repositories without an `airtable` section,
  never blocks the tool that triggered it, and requires `gh` to be installed
  and authenticated — `nemeda-agent doctor` checks both explicitly.
- **Project memory** (`nemeda-agent memory`), replacing the Airtable
  Knowledge Log: session summaries, decisions, findings, and meeting
  outcomes as append-only, per-author journals on the shared drive — safe
  with Google Drive and OneDrive sync clients, unlike a single shared
  database file. `memory add`/`list`/`search`/`review` work with no
  Airtable dependency at all, the `memory-log` skill is the portable
  replacement for the per-project Drive `klog.md` commands, and the MCP
  server's `memory_search`/`memory_recent`/`memory_get` tools let any
  session search prior work before proposing something that may already be
  decided; see [memory-plan.md](docs/memory-plan.md) for the design and the
  optional company-wide database layer.
- **A personal Slack bridge** (`nemeda-agent slack`): a Socket Mode runner that
  answers questions about your repositories in Slack threads. No infrastructure
  (the connection is outbound, so there is no server, URL, or tunnel), and every
  answer is produced by the operator's own Codex or Claude subscription through
  the local CLI. Each person runs their own Slack app, so a mention reaches only
  their machine and only the owner and their declared guests are answered.
  Read-only by construction, and `slack ask` replays the whole path locally so
  the voice can be tuned before any Slack app exists.
- Native manifests and marketplaces for Claude Code, Codex, and Cursor —
  Cursor installs the portable core directly (Agent Plugins standard), with a
  thin adapter adding an always-on workspace rule; `nemeda-agent cursor init`
  covers machines that cannot install the plugin.
- A portable Agent Plugins `plugin.json` + `mcp.json` core.
- A versioned JSON Schema and sanitized Milence/Scharlab examples.

## Install

### Codex

```bash
codex plugin marketplace add marcnaa/nemeda-agent-kit
```

Open `/plugins`, select **Nemeda Agent Kit**, install `nemeda-agent-kit`, then
start a new session.

### Cursor

Install from a team marketplace (**Dashboard → Plugins → Import from Repo**
with this repository) or clone it under `~/.cursor/plugins/local`. The plugin
loads the same skills and MCP context as the other hosts; the bundled rule
activates only inside kit-configured repositories.

### Claude Code

```bash
claude plugin marketplace add marcnaa/nemeda-agent-kit
claude plugin install nemeda-agent-kit@nemeda-agent-kit
```

Run `/reload-plugins` or start a new session.

### Claude Desktop organization marketplace

In **Organization settings → Plugins → Add plugin → GitHub**, enter
`marcnaa/nemeda-agent-kit` in `owner/repo` form. Managed sync uses a GitHub App
installation token; automatic sync additionally requires repository admin
access and the App's Webhooks read/write permission.

Keep plugin sources relative to this repository, as in
`./plugins/nemeda-agent-kit`; managed sync cannot fetch plugin code from a
separate repository.

### Local development install

The marketplace installs are separate clones of the GitHub repository: edits in
this checkout do nothing until pushed to `main` and re-synced. To iterate
locally, point the marketplace at the checkout instead:

```bash
claude plugin marketplace add /path/to/ai-workspace-plugin
claude plugin install nemeda-agent-kit@nemeda-agent-kit
```

After each change, run `/reload-plugins` (or restart the session).

## Configure a repository

From Codex or Claude Code, ask the agent to initialize Agent Kit in the current
repository. The `workspace-bootstrap` skill resolves and runs the bundled CLI, so the
package does not need to be installed globally.

If the optional CLI binary is on `PATH`, the equivalent commands are:

```bash
nemeda-agent init            # or: init --workspace  (scans nested git repos)
nemeda-agent setup           # Drive symlinks, repo clones, .env.local, .gitignore
nemeda-agent doctor          # config, Drive, Airtable, gh, and host diagnostics
nemeda-agent slack init      # personal Slack bridge: registry + token file
nemeda-agent slack doctor    # registry, routing, tokens, channel membership
```

`setup` is idempotent and create-if-absent only: existing files, links, and
clones are reported and left untouched. `doctor` tells you exactly which
machine-local piece is missing (broken symlink, Drive not streaming, empty
`AIRTABLE_API_KEY`, unauthenticated `gh`, missing clone).

During development from this checkout, run it directly:

```bash
node plugins/nemeda-agent-kit/scripts/cli.mjs init
node plugins/nemeda-agent-kit/scripts/cli.mjs doctor
```

`init` never overwrites an existing configuration or `AGENTS.md`. It creates:

```text
your-repo/
├── .nemeda/
│   └── agent-kit.json
└── AGENTS.md
```

See [configuration.md](docs/configuration.md) for the contract,
[architecture.md](docs/architecture.md) for the portability boundaries, and
[slack-bridge-setup.md](docs/slack-bridge-setup.md) for the step-by-step Slack
bot setup.

## Repository layout

```text
.
├── .agents/plugins/marketplace.json        # Codex marketplace
├── .claude-plugin/marketplace.json         # Claude marketplace
├── plugins/nemeda-agent-kit/
│   ├── plugin.json                         # Agent Plugins core manifest
│   ├── mcp.json / .mcp.json                # Portable and host MCP configuration
│   ├── .codex-plugin/plugin.json           # Codex adapter
│   ├── .claude-plugin/plugin.json          # Claude adapter
│   ├── skills/                             # Single source of methodology
│   ├── hooks/hooks.json                    # Session context + Airtable hooks
│   ├── slack/                              # App manifest + the Slack voice
│   ├── schemas/                            # Per-repository contract
│   ├── scripts/                            # CLI, MCP server, hook scripts, lib/
│   └── tests/
├── deploy/relay/                           # Dockerfile + Azure recipe
├── examples/
└── docs/
```

## Design rule

The plugin owns reusable behavior. Each repository owns its identity, profiles,
tool requirements, and project rules. Credentials and customer content are never
packaged in the plugin.

## Contributing

Run the checks before opening a pull request:

```bash
cd plugins/nemeda-agent-kit && npm test
claude plugin validate ./plugins/nemeda-agent-kit
git diff --check
```

The tests are `node --test` with no dependencies, and the whole kit is written
to stay dependency-free — please keep it that way. Reusable behavior belongs in
the plugin, project specifics in each repository's `.nemeda/agent-kit.json`.
See [AGENTS.md](AGENTS.md) for the full contributor rules.

## License

[Apache-2.0](LICENSE). Copyright 2026 Nemeda.
