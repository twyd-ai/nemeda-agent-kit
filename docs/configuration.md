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

## Slack bridge (`slack`)

Routes one Slack channel to this repository so a teammate can ask questions
about it without a checkout. Optional; omit it and nothing Slack-related runs.

```json
"slack": {
  "channels": ["C01ABCDEF12"],
  "owner": "U01ABCDEF12",
  "guests": ["U02ABCDEF12"],
  "backend": "claude",
  "model": "sonnet",
  "maxQuestionsPerHour": 20,
  "maxAnswerChars": 1500,
  "followThreads": true,
  "onUnauthorized": "ephemeral",
  "timeoutSeconds": 240
}
```

- Each person runs **their own** Slack app and their own runner, so a mention is
  delivered only to that person's machine and every answer is billed to that
  person's own agent subscription. One app per person, not one per project: in a
  channel, the channel decides which repository answers; in a DM, the person
  picks the project.
- The whole section is **optional**. The minimal install is machine-local only:
  set `owner` (your Slack member ID) and `repos` in `~/.nemeda/runner.json`, and
  every listed repository is answerable in DMs with no repository changes at
  all. The registry's `channels` map (`{"C…": "project-id"}`) routes channels
  the same way. A repository's own `slack` section overrides the registry when
  present, and is the right place for anything teammates should review, such as
  `guests`.
- **DMs are the everyday surface.** No mention needed; the DM is one ongoing
  conversation per project, resumed across restarts. With several projects, pick
  one with `usa <proyecto>` (sticky until changed) or per-message with
  `<proyecto>: la pregunta`; with one project there is nothing to pick. The
  runner lists what it serves when it cannot tell which you mean.
- `owner` is the Slack user the runner belongs to. `guests` are the teammates it
  also answers — typically product or delivery people with no subscription and
  no checkout. Anyone else is refused; `onUnauthorized: "ephemeral"` tells them
  which bot to mention instead, `"silent"` says nothing.
- Adding a guest grants them read access to this codebase through the bot.
  Treat the channel list and the guest list as access control.
- `followThreads` lets the runner answer follow-ups in a thread it already
  replied in, without a new mention. The Slack thread is the agent session, so
  context carries across the thread.
- `sourceRef` (for example `origin/main`) answers from a detached mirror
  worktree instead of the operator's working tree. Turn it on when more than one
  person runs a runner for the same repository, so their answers cannot diverge
  and a dirty local checkout stays private.
- The backend runs read-only by construction: built-in tools are narrowed to
  `Read`, `Grep`, and `Glob`, and `Bash`, `Write`, `Edit`, and the network tools
  are denied. A Slack message can never make the agent change anything.
- The manifest asks for the minimum scopes. `conversations.info` is not among
  them, so `slack doctor` cannot confirm the bot was invited to a channel and
  warns instead. Adding `channels:read` (and `groups:read` for private channels)
  upgrades that warning to a real check, at the cost of reinstalling the app —
  which issues a new bot token.
- Tokens are never stored here. They live in `~/.nemeda/.env.local`
  (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`), together with the runner registry
  `~/.nemeda/runner.json` that lists which repositories this machine serves.

Commands:

```bash
nemeda-agent slack init                 # ~/.nemeda/runner.json + token file
nemeda-agent slack manifest             # the Slack app manifest to paste
nemeda-agent slack ask "..."            # answer one question locally, as Slack would
nemeda-agent slack doctor               # registry, routing, tokens, channel membership
nemeda-agent slack run                  # the Socket Mode runner, in the foreground
nemeda-agent slack install              # macOS LaunchAgent, starts at login
```

Use `slack ask` before creating any Slack app: it runs the exact backend path
the runner uses and prints what Slack would render, which is how the voice gets
tuned without spending a real conversation.

## Rules

- Paths are relative to the directory containing `.nemeda/`.
- Instruction files must resolve inside that directory tree.
- `documents` are discoverable references, not automatically injected context.
- Tool names describe required capabilities; authentication remains personal.
- Configuration may contain non-secret IDs, but never credentials or customer data.
