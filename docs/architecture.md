# Architecture

Nemeda Agent Kit separates portable agent behavior from repository-owned context.

```text
Plugin: reusable and versioned
  ├── skills        methodology and repeatable workflows
  ├── MCP           read-only context and diagnostics
  ├── hooks         thin lifecycle adapter
  └── CLI           deterministic init and doctor

Repository: specific and reviewable
  ├── .nemeda/agent-kit.json   identity, profiles, tools, context paths
  └── AGENTS.md                durable human instructions

External systems: live and authorized
  └── GitHub, Drive, Airtable, Slack, Figma, calendars, and other MCP connectors
```

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
