# OneDrive support plan

Status: design, not implemented. Target release: 0.4.0.

Goal: let a project declare a Microsoft OneDrive / SharePoint document library
as its shared storage instead of a Google shared drive, with `setup`, `doctor`,
the session context, and the `workspace-create` skill behaving identically.
Nothing in the workspace layout changes: `docs/`, `config/`, skills, and
commands are still symlinks (junctions on Windows) into a synced folder.

## Constraints

1. Existing configurations keep working unchanged. `drive.provider` is
   optional and defaults to `google`.
2. Zero dependencies: detection is filesystem scanning plus environment
   variables, exactly like today. No Graph API, no OAuth.
3. One provider per project. Mixed setups are out of scope.
4. `NEMEDA_DRIVE_ROOT` and `NEMEDA_DRIVE_MOUNTS` stay provider-agnostic
   escape hatches and keep their names.

## What the kit already gives us

The Google-specific surface is small and well contained:

| Where | What is Google-specific |
|---|---|
| `scripts/lib/drive.mjs` | `driveMountCandidates` (mount layouts), `driveInstallInstructions`, `findSharedDrive` (error text), 12 mentions |
| `scripts/lib/workspace.mjs` | one doctor message ("is Google Drive for desktop running and streaming?") |
| `schemas/agent-kit.schema.json` | `drive.sharedDrive` description |
| `docs/drive-setup.md`, `docs/configuration.md`, `README.md`, `docs/workspace-comparison.md` | prose |
| `skills/workspace-create/SKILL.md` | step 1 "create the shared drive in Google Drive", onboarding step |
| `examples/*.json` | `sharedDrive` values only |

`setup.mjs`, the link/scaffold provisioning, folder READMEs, `.gitignore`
handling, the session-context taxonomy line, and every test that uses
`NEMEDA_DRIVE_ROOT` are already provider-neutral: they only consume
`planDriveLinks()`.

## OneDrive layouts to detect

The provider must find the *synced folder that plays the role of the shared
drive*. On OneDrive that is one of:

- a **SharePoint / Teams document library** synced with the OneDrive client
  (the team equivalent of a shared drive), or
- a **shared folder** from someone's OneDrive that the user added to their own
  files ("Add shortcut to My files").

Where the client puts them:

| Platform | Personal / work OneDrive root | Synced SharePoint libraries |
|---|---|---|
| macOS | `~/Library/CloudStorage/OneDrive-Personal`, `~/Library/CloudStorage/OneDrive-<Org>` (legacy: `~/OneDrive - <Org>` symlinks) | `~/Library/CloudStorage/OneDrive-SharedLibraries-<Org>/<Site> - <Library>` |
| Windows | `%OneDrive%`, `%OneDriveConsumer%`, `%OneDriveCommercial%`, `%USERPROFILE%\OneDrive - <Org>` | `%USERPROFILE%\<Org>\<Site> - <Library>` |
| Linux | no official client: rclone `onedrive:` mounts (`~/OneDrive`, `~/onedrive`), `onedriver` mounts | same, one level below the mount |

Synced libraries are named `<Site> - <Library>` and the library name is
localized ("Documents", "Documentos", "Dokumente"). So the lookup for
`sharedDrive: "Acme"` accepts, in order of preference:

1. a directory named exactly `Acme` directly under a mount root or one level
   below (a shared folder, or a library whose site was named that way);
2. a directory named `Acme - <anything>` under `OneDrive-SharedLibraries-*`
   (macOS) or under `%USERPROFILE%\<Org>` (Windows): the synced library.

Ambiguity (several matches) is reported as a doctor `warn` naming every
candidate and pointing at `NEMEDA_DRIVE_ROOT`, instead of guessing.

## Design

### 1. Config: `drive.provider`

```json
"drive": {
  "provider": "onedrive",
  "sharedDrive": "Acme",
  "links": { "docs": "docs", "config": "config", ".claude/skills": "skills", ".claude/commands": "commands" },
  "scaffold": ["docs/meetings", "docs/transcripts", "docs/plans", "docs/analysis"]
}
```

- Schema: `provider` enum `["google", "onedrive"]`, default `google`.
- `validateDrive` in `workspace.mjs` adds `provider` to the allowed keys and
  rejects unknown values with code `invalid-drive`.
- `sharedDrive` description becomes provider-neutral ("Name of the shared
  drive or synced document library that holds ...").

### 2. Provider table in `drive.mjs`

Refactor the module around a small provider registry instead of a second copy
of every function:

```js
const PROVIDERS = {
  google:   { label: "Google Drive",  mountCandidates, installInstructions, matchSharedDrive },
  onedrive: { label: "OneDrive",      mountCandidates, installInstructions, matchSharedDrive }
};
export function driveProvider(driveConfig) { return PROVIDERS[driveConfig.provider || "google"]; }
```

- `driveMountCandidates(environment, platform, provider)`: the Google branch
  is today's code moved verbatim; the OneDrive branch scans the table above.
  `NEMEDA_DRIVE_MOUNTS` short-circuits both.
- `findSharedDrive(name, environment, platform, provider)`: keeps the shared
  ranking logic (exact match under root, one level below, prefer the
  container that holds only directories) and delegates the *name match* to
  the provider so OneDrive can accept `Acme - Documents`.
- `driveInstallInstructions(platform, provider)`.
- `planDriveLinks` reads the provider from `driveConfig` and passes it down.
  Its return value is unchanged, so `setup.mjs` and the doctor need no edits
  beyond message wording.
- Error and doctor messages use `provider.label` ("No OneDrive mount found.
  Install OneDrive ...", "is OneDrive running and syncing?").

Keep the exported names; existing callers and tests keep passing.

### 3. Doctor

`driveDoctorChecks` gains:

- provider name in the `drive-mount` pass message;
- a `drive-ambiguous` warn when more than one candidate matched;
- an optional `drive-placeholder` warn on macOS/Windows when a linked folder
  looks dataless (OneDrive Files On-Demand keeps placeholders until first
  read: `stat.blocks === 0` on macOS for a non-empty size). The fix is
  "Always keep on this device" on the `skills` and `commands` folders, which
  every AI reads at session start. Cheap to check, worth the hint.

### 4. Docs and skills

- `docs/drive-setup.md` becomes "Shared storage setup" with a Google section
  (unchanged) and a OneDrive section per platform, including how to sync a
  SharePoint library and how a shared folder shows up.
- `docs/configuration.md`: document `provider`; the provisioning paragraph
  says "Creating the shared drive or SharePoint library itself needs the
  provider's UI".
- `skills/workspace-create/SKILL.md`: step 1 branches on provider (create a
  shared drive / create a Teams team or SharePoint site and sync its library);
  onboarding tells teammates to install the matching desktop client.
- `README.md`, `docs/workspace-comparison.md`: one-line wording updates.
- New example `examples/onedrive-agent-kit.json`.

### 5. Tests

All filesystem-based, no network, in `tests/provisioning.test.mjs`:

- `findSharedDrive` with a fake macOS layout: `OneDrive-Personal/Acme`,
  `OneDrive-SharedLibraries-Org/Acme - Documents`, and the ambiguous case.
- Windows layout via `NEMEDA_DRIVE_MOUNTS` and the `%OneDrive*%` variables
  injected through the `environment` argument.
- Install instructions per platform for both providers.
- `validateConfig` rejects `provider: "dropbox"` and accepts omission.
- `setup` + `doctor` end-to-end with `NEMEDA_DRIVE_ROOT` pointing at a temp
  folder and `provider: "onedrive"` (proves the provider does not leak into
  the link/scaffold path).

## Phases

1. **Refactor without behavior change** — done. Provider registry in
   `drive.mjs` (`driveProvider`, `DRIVE_PROVIDERS`, `DEFAULT_DRIVE_PROVIDER`),
   Google as the only entry, `provider` accepted by the validator and the
   schema, doctor messages use the provider label, `planDriveLinks` reports
   the provider it used. Name matching beyond the exact folder name is a
   per-provider `matchSharedDrive(name, entryName)` hook, unused by Google.
2. **OneDrive provider** — done. Mount scanning for the three platforms
   (macOS `CloudStorage/OneDrive-*`, Windows `%OneDrive%` family plus
   `OneDrive - <Org>` and a heuristic `<Org>` folder for the SharePoint sync
   client, Linux `~/OneDrive`), `matchSharedDrive` for `"<name> - <library>"`,
   install instructions, a generic `drive-ambiguous` doctor warning when two
   candidates tie at the same rank (benefits Google too — e.g. the same
   shared drive name reachable from two accounts), and a macOS-only
   `drive-placeholder` warning for undownloaded `skills`/`commands` files.
   The placeholder check cannot be covered by an automated test: it relies on
   `stat.blocks === 0`, a real APFS cloud-placeholder state that cannot be
   fabricated with a normal file write, so its verification is deferred to
   phase 4 (manual, on a machine with an actual undownloaded file). Verified
   end-to-end against the real `OneDrive-Personal` mount on this machine.
3. **Docs and skills**: the four documents, the create skill, the example.
4. **Manual verification** on a Mac with `OneDrive-Personal` mounted (a
   shared folder is enough) and, when available, one Windows machine with a
   synced SharePoint library. Record findings in this file.

## Risks and open questions

- **Symlinks into OneDrive**: links are created *from* the workspace *into*
  the synced folder, which OneDrive tolerates. Never the reverse: OneDrive
  does not sync symlinks placed inside it.
- **Files On-Demand**: first session on a fresh machine triggers downloads of
  every skill file; usually seconds, but `doctor` should say so (section 3).
- **Path limits on Windows**: `%USERPROFILE%\<Org>\<Site> - <Library>\docs\...`
  gets long; junctions help, but document the 260-character limit or the
  `LongPathsEnabled` registry switch.
- **Case-insensitive, name-restricted filesystem**: OneDrive rejects `~`, `"`,
  `*`, `:`, `<`, `>`, `?`, `/`, `\`, `|` and leading/trailing spaces in names.
  `scaffold` entries and document names produced by the kit (see the meeting
  capture plan) must respect that; add a validator warning.
- **Shared folder vs library**: a personal shared folder only appears after
  each teammate adds the shortcut. The create skill must say so explicitly,
  as it does today for Google shared-drive membership.
- Out of scope: Dropbox, Box, plain SMB shares. The provider table makes them
  cheap later, but no one is asking.
