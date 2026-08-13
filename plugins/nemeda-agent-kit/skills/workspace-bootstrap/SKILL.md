---
name: workspace-bootstrap
description: Initialize Nemeda Agent Kit safely in a repository by creating a minimal .nemeda/agent-kit.json and AGENTS.md without overwriting existing project guidance. Use when a user asks to adopt, initialize, configure, or migrate a repository to the toolkit.
---

# Bootstrap a repository

1. Inspect the repository root, current `AGENTS.md`, `CLAUDE.md`, package metadata,
   nested repositories, remotes, and dirty state.
2. Run `nemeda-agent init` from the intended repository root when the binary is on
   `PATH`. Otherwise, resolve the plugin root from this skill's filesystem location
   and run `node <plugin-root>/scripts/cli.mjs init`. In Claude Code,
   `${CLAUDE_PLUGIN_ROOT}` points to that root.
3. Never overwrite an existing `.nemeda/agent-kit.json` or `AGENTS.md`.
4. Review the generated profile detection. It is a starting point, not proof of the
   production architecture.
5. Move project-specific rules into `AGENTS.md`; keep structured identity, profiles,
   context paths, and tool requirements in `.nemeda/agent-kit.json`.
6. For shared workspaces, extend the configuration with `drive` (shared-drive name
   and symlink map), `workspace.repositories[].remote`, and `airtable` (base, tables,
   status vocabulary) — see `docs/configuration.md` — then run `nemeda-agent setup`
   to create symlinks, clone repositories, and write the `.env.local` template. Ask
   the user for the shared-drive name and Airtable ids; never guess them.
7. Run `nemeda-agent doctor` and report warnings before proposing publication.

Do not put tokens, passwords, customer records, or private document contents into
the configuration file. Connector names and non-secret resource identifiers may be
configured when the project needs them.
