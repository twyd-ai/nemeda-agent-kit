---
name: workspace-create
description: Create a complete new project workspace end to end — Drive structure, workspace repository, code repositories, Airtable base, and team onboarding — so every teammate and every AI shares the same context from day one. Use when a user asks to start, create, or scaffold a new project or workspace.
---

# Create a new project workspace

The goal is not the folders: it is that every teammate and every AI opens this
project with the same knowledge — same docs, same skills, same plan, same
filing conventions. Everything below serves that.

## 1. Gather (ask, never guess)

- Project name and short id (lowercase, hyphens).
- Which code repositories exist or must be created (GitHub org/names), or none —
  a documentation/operations project is valid with no code repos.
- Shared drive name. Convention: use the project name, exactly.
- Airtable workspace id (`wsp...`, from the airtable.com URL) if the project
  wants a plan base; skip otherwise.
- Who is on the team (for access grants and the Team table).

## 2. Preflight

Run `nemeda-agent doctor` (or `node <plugin-root>/scripts/cli.mjs doctor`).
If there is no Google Drive mount, give the platform instructions and stop
until it is installed — `docs/drive-setup.md` has macOS, Windows, and Linux
steps; the doctor error message carries the short version.

## 3. Steps only a human can do (say so, plainly)

1. **Create the shared drive** in Google Drive (New → Shared drive) with the
   agreed name, and add the team as members. Creating shared drives needs a
   Workspace account; the kit cannot do it through the filesystem.
2. **Grant access**: GitHub org membership for the code repos, and Airtable
   workspace access if using a plan base.

Wait for confirmation that the drive exists and Drive for desktop shows it.

## 4. Assemble

1. Create the workspace directory, `git init`, then run `nemeda-agent init`
   with the project id and name.
2. Extend `.nemeda/agent-kit.json` with:
   - `drive`: `sharedDrive` plus the canonical links — `docs`, `config`,
     `.claude/skills` and `.agents/skills` → `skills`, `.claude/commands` and
     `.agents/commands` → `commands` (both hosts, same shared content);
   - `drive.scaffold`: the docs taxonomy. Default:
     `docs/meetings`, `docs/transcripts`, `docs/plans`, `docs/analysis`,
     `docs/api` — adapt names to the team's language and drop what does not
     apply, but never leave it empty: the taxonomy is what keeps the drive
     from degrading into loose files;
   - `workspace.repositories` with each code repo's `path`, `role`,
     `profiles`, and `remote` (or the single `repository` section if the
     workspace is one repo).
3. If using Airtable: `nemeda-agent airtable init --name <project>
   --workspace-id wsp...` and paste the printed snippet into the config.
   Add each teammate to the Team table.
4. Run `nemeda-agent setup` — it creates the Drive folders (with their
   convention READMEs), the symlinks (junctions on Windows), clones the code
   repositories, and writes the `.env.local` template and `.gitignore`
   entries.
5. Run `nemeda-agent doctor` until everything relevant passes.
6. Commit the workspace repository (config, AGENTS.md, .gitignore) and push it
   to the org, so teammates replicate with: clone + `nemeda-agent setup`.

## 5. Hand-off message

Tell the user what a teammate does on any OS: install Google Drive for desktop
(see `docs/drive-setup.md`), accept the drive membership, clone the workspace
repo, run `nemeda-agent setup`, then `nemeda-agent doctor`. Their AI then
loads the same context, skills, and conventions as everyone else's.

Never put secrets in the config; `.env.local` stays personal and gitignored.
