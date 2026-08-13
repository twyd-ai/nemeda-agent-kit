---
name: workspace-doctor
description: Diagnose whether Nemeda Agent Kit is correctly configured for the current repository, including config validity, instruction paths, repository identity, host availability, and legacy duplication. Use when setup is incomplete, tools or context differ between agents, or a teammate reports the plugin is not working.
---

# Workspace doctor

1. Call the `workspace_doctor` MCP tool with the current working directory.
2. Separate errors, warnings, and informational checks.
3. Treat missing required tools and invalid configuration as errors.
4. Treat parallel `AGENTS.md` and `CLAUDE.md` files as a drift risk unless one is a
   short import or generated compatibility adapter.
5. Treat symlinked skills, duplicated MCP configuration, and copied project scripts
   as migration warnings, not automatic deletion candidates. Symlinks declared in
   `drive.links` are intentional and are verified separately.
6. For Drive/Airtable findings (missing or broken symlinks, empty Drive folders,
   missing clones, empty `AIRTABLE_API_KEY`, unauthenticated `gh`), the standard
   repair is `nemeda-agent setup` — it is idempotent and never overwrites. Filling
   the API key and `gh auth login` remain manual, personal steps.
7. Offer the smallest repair that preserves existing repository rules and user work.

The doctor is read-only. Do not install tools, edit files, remove symlinks, or change
host configuration unless the user explicitly requests a repair; `nemeda-agent setup`
is the one sanctioned repair command, and only with the user's go-ahead.
