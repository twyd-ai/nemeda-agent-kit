# Nemeda Agent Kit

Portable methodology, tools, and repository context for AI coding agents.

Nemeda Agent Kit gives Codex, Claude Code, and Agent Plugins-compatible hosts the
same operational baseline without copying skills or tool configuration into every
project. A small `.nemeda/agent-kit.json` file identifies each repository; normal
project instructions stay in `AGENTS.md`.

> Status: private experimental MVP. The repository currently lives under
> `marcnaa` while the package is validated. It is not yet an official Nemeda
> distribution.

## What it includes

- Agent Skills for workspace discovery, bootstrap, diagnostics, and safe
  multi-repository work.
- A read-only MCP server that exposes normalized workspace context and health
  checks.
- A zero-dependency CLI: `nemeda-agent init`, `setup`, `context`, and `doctor`.
- **Shared-workspace assembly** (`nemeda-agent setup`): Google Drive symlinks
  (`docs/`, `config/`, `.claude/skills`, `.claude/commands`), declared code
  repository clones, an `.env.local` template, and the matching `.gitignore`
  entries — all declared in `.nemeda/agent-kit.json` instead of per-project
  shell scripts.
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
- Native manifests and marketplaces for Codex and Claude Code.
- A portable Agent Plugins `plugin.json` + `mcp.json` core.
- A versioned JSON Schema and sanitized Milence/Scharlab examples.

## Install from this private repository

Prerequisite: GitHub access to `marcnaa/nemeda-agent-kit` through your normal
Git credentials.

### Codex

```bash
codex plugin marketplace add marcnaa/nemeda-agent-kit
```

Open `/plugins`, select **Nemeda Agent Kit Private**, install
`nemeda-agent-kit`, then start a new session.

### Claude Code

```bash
claude plugin marketplace add marcnaa/nemeda-agent-kit
claude plugin install nemeda-agent-kit@nemeda-agent-kit-private
```

Run `/reload-plugins` or start a new session.

### Local development install

The marketplace installs are separate clones of the GitHub repository: edits in
this checkout do nothing until pushed to `main` and re-synced. To iterate
locally, point the marketplace at the checkout instead:

```bash
claude plugin marketplace add /path/to/ai-workspace-plugin
claude plugin install nemeda-agent-kit@nemeda-agent-kit-private
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

See [configuration.md](docs/configuration.md) for the contract and
[architecture.md](docs/architecture.md) for the portability boundaries.

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
│   ├── schemas/                            # Per-repository contract
│   ├── scripts/                            # CLI, MCP server, hook scripts, lib/
│   ├── bin/                                # nemeda-agent, nemeda-agent-mcp
│   └── tests/
├── examples/
└── docs/
```

## Design rule

The plugin owns reusable behavior. Each repository owns its identity, profiles,
tool requirements, and project rules. Credentials and customer content are never
packaged in the plugin.
