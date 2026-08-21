# Architecture

Nemeda Agent Kit separates portable agent behavior from repository-owned context.

```text
Plugin: reusable and versioned
  ├── skills        methodology and repeatable workflows
  ├── MCP           read-only context and diagnostics
  ├── hooks         session context + parameterized Airtable automations
  ├── slack         Socket Mode runner, app manifest, and the Slack voice
  └── CLI           deterministic init, setup, doctor, and slack

Repository: specific and reviewable
  ├── .nemeda/agent-kit.json   identity, profiles, tools, Drive links, Airtable ids
  └── AGENTS.md                durable human instructions

Machine-local: assembled by `setup`, verified by `doctor`, never committed
  ├── docs/, config/, .claude/skills, .claude/commands   symlinks into Drive
  ├── nested code repository clones
  ├── .env.local               personal secrets (AIRTABLE_API_KEY)
  ├── .nemeda/state/           hook throttles and dedupe caches
  └── ~/.nemeda/               runner registry, Slack tokens, runner state

External systems: live and authorized
  └── GitHub, Drive, Airtable, Slack, Figma, calendars, and other MCP connectors
```

The Airtable hooks are deliberately indirect: the agent only labels PR bodies
with `Airtable: recXXX`. A session-start reconciler is the authoritative sync —
it reads open and merged PRs directly from GitHub via `gh pr list` and moves
task status accordingly, so it works regardless of how the PR was opened (web
UI, another machine, `gh` CLI). Observing a local `gh pr create` Bash call is
only a fast-path for immediate feedback on top of that; it cannot be the sole
mechanism because it only sees PRs the agent itself creates from a Bash tool.
The agent never mutates client-visible state directly, and the hooks never
block a tool (they always exit 0).

## The Slack bridge

The bridge exists so people without a checkout — product, delivery — can ask
questions against the same repository context the coding agents use. It adds one
process and one config section; it does not add a second source of truth.

Socket Mode is what removes the infrastructure: the runner's WebSocket is
outbound, so there is no server, no public URL, and no tunnel. Each person runs
their own Slack app and their own runner, which makes routing deterministic
(Slack delivers a mention only to that app's connection) and keeps every answer
billed to that person's own agent subscription through the local CLI. Nothing is
shared between teammates — separate apps, separate tokens, separate plans — so
the design has no shared secret.

The reduced surface is deliberate. The runner narrows the backend to
`Read`/`Grep`/`Glob` plus the kit's own read-only MCP server, denies the write
and network tools, and sets `NEMEDA_SLACK_RUNNER=1` so the plugin's own hooks
no-op inside a Slack-triggered session. Slack message text is treated as
untrusted data throughout: the voice prompt states it explicitly, and the tool
set means an injected instruction has nothing to act on.

Availability is the honest trade for zero infrastructure: the bot is up while
the laptop is. Slack's presence indicator makes that visible without the runner
posting anything.

## Portability boundary

The portable core follows the Agent Plugins working draft:

- root `plugin.json` for identity;
- `skills/<name>/SKILL.md` for Agent Skills;
- root `mcp.json` for MCP servers.

Codex and Claude currently require their own marketplace and manifest locations, so
the repository supplies thin adapters:

- `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`;
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

The adapters point at the same skills, scripts, and MCP implementation. They must not
contain forked copies of methodology.

## Why `.nemeda/agent-kit.json`

`AGENTS.md` is ideal for natural-language rules and is loaded natively by Codex and
several other agents. It is not a convenient schema-controlled registry for repository
roles, profiles, tool dependencies, and nested repository mappings.

The dedicated JSON file provides deterministic parsing and validation. The session
hook combines it with `AGENTS.md` at runtime, while the CLI can diagnose invalid or
missing fields without rewriting human guidance.

## Trust model

- MCP context tools are read-only.
- `init` writes only when target files do not already exist.
- Instruction paths must remain inside the configured repository root.
- Secret files are never read as context.
- Plugin hooks still require the host's normal trust and approval flow.
- External connectors retain their own authorization and access controls.
