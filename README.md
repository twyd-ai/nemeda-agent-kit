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
- A zero-dependency CLI: `nemeda-agent init`, `context`, and `doctor`.
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

## Configure a repository

From Codex or Claude Code, ask the agent to initialize Agent Kit in the current
repository. The `workspace-bootstrap` skill resolves and runs the bundled CLI, so the
package does not need to be installed globally.

If the optional CLI binary is on `PATH`, the equivalent commands are:

```bash
nemeda-agent init
nemeda-agent doctor
```

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
│   ├── mcp.json                            # Portable MCP configuration
│   ├── .codex-plugin/plugin.json           # Codex adapter
│   ├── .claude-plugin/plugin.json          # Claude adapter
│   ├── skills/                             # Single source of methodology
│   ├── hooks/                              # Thin host lifecycle adapter
│   ├── schemas/                            # Per-repository contract
│   ├── scripts/                            # CLI, MCP, and context loader
│   └── tests/
├── examples/
└── docs/
```

## Design rule

The plugin owns reusable behavior. Each repository owns its identity, profiles,
tool requirements, and project rules. Credentials and customer content are never
packaged in the plugin.
