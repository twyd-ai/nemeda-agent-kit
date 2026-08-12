---
name: workspace-context
description: Load and apply repository-owned Nemeda Agent Kit context before working in a configured repository or multi-repository workspace. Use when a task depends on project identity, repository role, stack profile, required tools, or durable instructions.
---

# Workspace context

Resolve the repository context before making decisions that depend on project scope.

1. Call the `workspace_context` MCP tool with the current working directory.
2. Read every instruction file returned by the tool before acting.
3. Treat `.nemeda/agent-kit.json` as structured routing data, not as a replacement
   for `AGENTS.md`.
4. If both a workspace configuration and a nearer repository configuration exist,
   prefer the nearer configuration and use the parent only for shared context.
5. If no Agent Kit configuration exists, report legacy mode and inspect `AGENTS.md`
   and `CLAUDE.md` directly. Do not invent missing project identity or tools.
6. Never load credentials, `.env` files, or arbitrary linked folders as context.

Keep completion claims at the closest directly verified level. A command exit,
upload acknowledgement, remote response, dashboard state, and physical-device
result are different kinds of evidence.
