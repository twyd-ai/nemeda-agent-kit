# Repository configuration

The canonical file is `.nemeda/agent-kit.json`.

## Single repository

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "example-project",
    "name": "Example Project"
  },
  "repository": {
    "id": "example-api",
    "role": "backend",
    "profiles": ["python", "fastapi"]
  },
  "context": {
    "instructions": ["AGENTS.md"],
    "documents": ["docs/architecture.md"]
  },
  "tools": {
    "required": ["git", "github"],
    "optional": ["google-drive", "airtable"]
  },
  "policies": {
    "protectSecrets": true,
    "conversationLanguage": "es",
    "artifactLanguage": "en"
  }
}
```

## Parent workspace

Use `workspace.repositories` when one folder coordinates several independent Git
repositories. Each child should eventually have its own configuration when it needs
more specific rules.

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "example-suite",
    "name": "Example Suite"
  },
  "workspace": {
    "repositories": [
      {
        "id": "example-backend",
        "path": "backend",
        "role": "backend",
        "profiles": ["python", "fastapi"]
      },
      {
        "id": "example-frontend",
        "path": "frontend",
        "role": "frontend",
        "profiles": ["typescript", "nextjs"]
      }
    ]
  },
  "context": {
    "instructions": ["AGENTS.md"],
    "documents": []
  },
  "tools": {
    "required": ["git", "github"],
    "optional": []
  },
  "policies": {
    "protectSecrets": true
  }
}
```

Workspace repositories may declare `remote` (and optionally `branch`); then
`nemeda-agent setup` clones them when the path is missing.

## Shared Drive (`drive`)

Declares the Google shared drive and the symlinks that connect it to the
workspace. `nemeda-agent setup` creates them; `nemeda-agent doctor` verifies
they resolve and contain content. Keys are workspace-relative link paths,
values are folders inside the shared drive.

```json
{
  "drive": {
    "sharedDrive": "Example-Workspace",
    "links": {
      "docs": "docs",
      "config": "config",
      ".claude/skills": "skills",
      ".claude/commands": "commands"
    }
  }
}
```

The Drive mount is detected language-agnostically (the "Shared drives" folder
name is localized). Set `NEMEDA_DRIVE_ROOT=/path/to/shared-drive` to override
detection (several Google accounts, Linux, tests).

## Airtable (`airtable`)

Replaces the per-project constants of the legacy workspace scripts. IDs are
non-secret routing data; the personal access token lives only in the
gitignored `.env.local` (`AIRTABLE_API_KEY`).

```json
{
  "airtable": {
    "baseId": "appXXXXXXXXXXXXXX",
    "tasks": {
      "tableId": "tblXXXXXXXXXXXXXX",
      "statusField": "Status",
      "notesField": "Notes",
      "statusInProgress": "In progress",
      "statusDone": "Completed"
    },
    "knowledgeLog": {
      "tableId": "tblYYYYYYYYYYYYYY",
      "people": { "person@example.com": "recXXXXXXXXXXXXXX" }
    },
    "reconcileRepos": ["owner/backend", "owner/frontend"],
    "lookbackDays": 21
  }
}
```

- `tasks` and `knowledgeLog` both live in the base identified by the
  top-level `airtable.baseId` (Airtable's REST API is per-base, not
  per-table, so this is the only base id needed).
- `tasks` drives the PR sync: a PR body line `Airtable: recXXXXXXXXXXXXXX`
  (or a task-table URL) links the PR; unlabelled record ids are ignored on
  purpose. Statuses must match the single-select options exactly.
- `knowledgeLog.people` maps `git config user.email` to the person's record
  id in the Team/People table.
- `reconcileRepos` are the **authoritative** source of PR status: on session
  start (12 h throttle; `--force` bypasses when run by hand), `gh pr list` is
  read for both `--state open` (→ `statusInProgress`) and `--state merged`
  (→ `statusDone`, bounded by `lookbackDays`). This works regardless of how
  the PR was opened — web UI, another machine, or the `gh` CLI — because it
  reads GitHub's PR state directly rather than watching for a local command.
  A merged PR always wins over a stale open one for the same task, and a task
  already marked done is never moved backwards.
  Requires `gh` installed and authenticated; `nemeda-agent doctor` checks
  both and tells them apart.
- The `PostToolUse` hook on `gh pr create` is a fast-path only: it gives
  immediate feedback when the agent itself opens the PR from Bash, on top of
  the reconciler above — it is not a substitute for it.
- Environment switches in `.env.local`: `PR_AIRTABLE_SYNC_DISABLED`,
  `PR_AIRTABLE_SYNC_DRYRUN`, `KNOWLEDGE_LOG_AUTO`, `AIRTABLE_PERSON_ID`,
  `PR_RECONCILE_REPO`, `PR_RECONCILE_LOOKBACK_DAYS`.

## Rules

- Paths are relative to the directory containing `.nemeda/`.
- Instruction files must resolve inside that directory tree.
- `documents` are discoverable references, not automatically injected context.
- Tool names describe required capabilities; authentication remains personal.
- Configuration may contain non-secret IDs, but never credentials or customer data.
