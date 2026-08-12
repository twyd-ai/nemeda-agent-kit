# Milence and Scharlab workspace comparison

Reviewed on 12 August 2026 from the local Milence checkout and the private
`twyd-ai/scharlab-workspace` repository.

## Common model

Both workspaces use the same composition pattern:

- one coordinator repository around independent code repositories;
- Google Drive folders mounted through machine-specific symlinks;
- Claude skills and commands mounted from Drive;
- project MCP configuration in `.mcp.json`;
- local setup scripts for Airtable knowledge logging and PR synchronization;
- project rules in `CLAUDE.md`;
- secrets in personal `.env.local` files.

Scharlab explicitly states that it replicates the Milence pattern. Its
`setup-workspace.sh` improves onboarding by making Drive linking and repository cloning
idempotent.

## Useful differences

| Area | Milence | Scharlab | Toolkit consequence |
|---|---|---|---|
| Code topology | Several mobile clients plus backend worktrees | Separate backend and frontend repos | Model nested repositories explicitly |
| Bootstrap | Mostly documented/manual | Idempotent setup script | Provide deterministic `init` and `doctor` |
| Skills | Domain and native-mobile skills | Backend/frontend stack and PR skills | Profiles make stack requirements explicit |
| Codex adaptation | Versioned `.agents/skills` and `.codex` config | Local unversioned `AGENTS.md` and `.codex` config | One portable source with host adapters |
| Tracking | Airtable Tasks and Knowledge Log | Project-specific Airtable fork | Put IDs/status mappings in repo config, not plugin code |

## Repeated failure modes

1. Skills are copied or symlinked into host-specific locations and drift.
2. The same MCP server is configured separately for Codex and Claude.
3. Absolute Drive symlinks make setup account- and platform-specific.
4. Generic hook scripts are forked only to change project IDs, statuses, and repos.
5. `CLAUDE.md` is treated as universal context even though other agents load different
   instruction files.
6. A parent workspace can hide which nested Git repository and product target is
   actually active.

## Migration direction

- Package methodology, context loading, diagnostics, and generic automation in the
  plugin.
- Keep project identity, nested repository mappings, profiles, and tool requirements
  in `.nemeda/agent-kit.json`.
- Keep durable rules in `AGENTS.md`; use generated compatibility adapters only where a
  host still needs them.
- Replace Drive-hosted skill distribution with the private plugin marketplace.
- Access Drive and Airtable through authenticated connectors or MCP instead of local
  secrets embedded in copied scripts.
