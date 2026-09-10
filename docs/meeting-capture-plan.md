# Meeting capture and transcription plan

Status: phases 1 to 4 implemented (`nemeda-agent meeting list | process |
notes | doctor | setup`, whisper.cpp and apple-speech engines, SessionStart
inbox hook, recorder/transcriber/full roles over a shared inbox with claims
and heartbeats, notes by the local agent, memory entries through
`recordEntry` instead of the Airtable Knowledge Log, `recordings.keep`);
phase 5 pending. Target release: 0.4.0. The shipped
configuration is documented in `docs/configuration.md`.

Goal: replace the manual loop *record the meeting with OBS, run whisper by
hand, copy the text into the shared drive* with one kit-owned pipeline that
turns every finished recording into a filed transcript, a notes document, and
an Airtable Knowledge Log entry, on the team's own machines, with no hosted
service and no per-minute API cost.

The feature is optional at every level: a project opts in with a `meetings`
section, each machine opts in with a role, and the transcription model is a
per-machine choice that `doctor` recommends from the hardware it finds. No
machine is ever required to transcribe.

## Today's manual process

1. OBS records the meeting (screen + audio) to the local recordings folder
   (`~/Movies` on the current machine, `mkv`, file name
   `YYYY-MM-DD HH-mm-ss.mkv`).
2. The operator runs whisper.cpp locally (`whisper-cli`, model
   `ggml-large-v3-turbo`) on the file.
3. The operator copies the resulting text into `docs/transcripts/` on the
   shared drive and, sometimes, writes notes in `docs/meetings/`.

Steps 2 and 3 are skipped or delayed whenever the day is busy; transcripts end
up in the wrong folder or never leave the laptop. Step 1 stays as it is: OBS
is already configured and works.

## Constraints

1. Zero dependencies in the kit. External binaries are called through
   `child_process`: `ffmpeg` (audio extraction) and one transcription engine.
   Both are checked by `doctor`; `meeting setup` can install them, but only
   after showing the exact command and getting a confirmation.
2. Local by construction. Audio never leaves the team's machines and the
   shared drive; the only network step is the optional Airtable entry, which
   reuses the existing hooks.
3. Idempotent and safe. A recording is processed once, an existing transcript
   is never overwritten, the original recording is never deleted unless the
   project configures it.
4. Never inside a hook's time budget. Transcribing an hour of audio takes
   minutes; hooks stay fast no-ops that only *report* pending recordings.
5. Team-shared decisions (where transcripts go, naming, language, Airtable
   logging) live in `.nemeda/agent-kit.json`. Machine-local facts (role,
   recordings folder, engine binary, model path) live in `.env.local` or are
   detected.
6. Notes are written by the operator's own Codex / Claude subscription through
   the local CLI, the same way the Slack bridge answers questions. No API key.
7. No hardware requirement. A machine that cannot transcribe still
   participates by recording; one capable machine per team is enough.

## What the kit already gives us

- `planDriveLinks` + the `docs` link: writing to `<workspace>/docs/transcripts`
  lands on the shared drive whatever the provider (see `onedrive-plan.md`),
  so the pipeline never touches provider paths directly.
- `drive.scaffold` and the folder READMEs: `docs/meetings` and
  `docs/transcripts` are already the canonical taxonomy in `workspace-create`.
- `scripts/lib/hooks.mjs`: `.nemeda/state/` directory, throttling, dedupe
  files, the "never throw, never block" hook contract.
- `scripts/lib/airtable.mjs` + the canonical base: Knowledge Log already has
  `Type = Meeting` and `Status = Pending`.
- `scripts/lib/slack.mjs`: `buildBackendCommand` runs `codex` or `claude`
  non-interactively with a system prompt and the workspace MCP; reusable for
  notes generation. `slack-ops.mjs` already installs a launchd agent.
- `scripts/lib/drive.mjs`: `driveInstallInstructions` is the precedent for
  "tell the user the exact install command per platform".
- `nemeda-agent doctor` and `workspace_doctor`: the place to report missing
  binaries, models, folders, and machine capability.

## Prerequisites and installation

Three tiers, so the requirement on any single machine is as small as its role
needs:

| Tier | What | Who needs it | How it gets there |
|---|---|---|---|
| Required for transcribing | `ffmpeg` and one transcription engine: `apple-speech` (via `yap`, no model to download) on macOS 26 with Apple Silicon, `whisper-cpp` plus one model everywhere else | machines with role `transcriber` or `full` | `meeting setup` installs on confirmation (`brew` on macOS, `winget` on Windows, `apt` on Linux) and, for whisper engines, downloads the model `doctor` recommended |
| Recommended for recording | OBS Studio | machines with role `recorder` or `full` that do not use a platform's native recording | `meeting setup --obs` installs it on confirmation; scenes, audio sources, and the recording folder are configured by hand following `docs/meeting-capture.md` |
| Outside the kit | virtual audio device for system audio (BlackHole on macOS), Zoom / Teams / Meet accounts and their native recording | recorders | documented, never installed |

OBS is recommended, not required: any recording that lands in the watched
folder is processed, so a teammate who records natively in Zoom, Teams, or
Meet only points `NEMEDA_MEETINGS_WATCH` at that folder.

`meeting setup` never installs anything silently. It prints the package
manager command, waits for a yes, runs it, then re-runs `meeting doctor`.

## Design

### 1. Config section `meetings` (shared, optional)

```json
"meetings": {
  "inbox": "docs/recordings/inbox",
  "transcripts": "docs/transcripts",
  "notes": "docs/meetings",
  "language": "es",
  "naming": "{date}-{slug}",
  "knowledgeLog": true,
  "recordings": { "keep": "local" }
}
```

- `inbox`: workspace-relative folder on the shared drive where recorders drop
  finished recordings and transcribers pick them up. This is what makes the
  feature optional per machine (section 2). Omit it for a single-machine
  setup where the same laptop records and transcribes.
- `transcripts`, `notes`: workspace-relative folders, normally inside the
  `docs` Drive link. Validator requires all folders to be relative and inside
  the workspace; `doctor` warns when one is not covered by a `drive.links`
  entry (its content would stay on one laptop).
- `language`: whisper language code or `auto`. Defaults to
  `policies.conversationLanguage` when present, else `auto`.
- `naming`: `{date}` (`YYYY-MM-DD`, from the recording timestamp) and
  `{slug}` (from `--title`, or `untitled`). Names must satisfy the strictest
  provider (OneDrive) character rules.
- `knowledgeLog`: create one Airtable Knowledge Log entry per meeting when the
  `airtable` section exists. Mirrors `KNOWLEDGE_LOG_AUTO` semantics.
- `recordings.keep`: `local` (default, leave the file where it was recorded),
  `archive` (move it to `docs/recordings/` on the drive; large, opt-in), or
  `delete-after-days: N` (only after the transcript exists and is non-empty).

Without a `meetings` section every command, hook, and doctor check is a
no-op, exactly like `airtable` and `slack`.

### 2. Machine roles (`.env.local`, all optional)

```
NEMEDA_MEETINGS_ROLE=full                   # recorder | transcriber | full (default: full)
NEMEDA_MEETINGS_WATCH=/Users/me/Movies      # default: detected from OBS
NEMEDA_MEETINGS_ENGINE=apple-speech         # apple-speech | whisper-cpp | whisper | mlx-whisper (default: what `doctor` selected)
NEMEDA_WHISPER_BIN=whisper-cli              # whisper engines only; default: first binary found
NEMEDA_WHISPER_MODEL=~/.nemeda/models/ggml-small.bin   # whisper engines only; default: the model `doctor` recommended
NEMEDA_MEETINGS_THREADS=8                   # default: os.cpus().length
```

| Role | Does | Needs |
|---|---|---|
| `recorder` | moves finished recordings from the local watch folder to the shared `inbox` | nothing beyond the drive link |
| `transcriber` | watches the shared `inbox`, transcribes, files, writes notes, logs | ffmpeg, an engine (plus a model for whisper engines) |
| `full` | watches the local folder and does everything on the same machine | ffmpeg, an engine (plus a model for whisper engines) |

One `transcriber` per team is enough; usually the person with the most capable
machine. Two transcribers are allowed: the processed-state file lives next to
the inbox (`<inbox>/.processed.json`) so they never handle the same file
twice, with an atomic rename-based claim (`x.mkv` becomes
`x.mkv.claimed-<host>` while in progress).

OBS detection reads `RecFilePath` from the active profile:
`~/Library/Application Support/obs-studio/basic/profiles/*/basic.ini` (macOS),
`%APPDATA%\obs-studio\...` (Windows), `~/.config/obs-studio/...` (Linux). When
OBS is not installed the watch folder must be set explicitly; `doctor` says so.

### 3. Engine selection, model tiers, and the minimum machine

Two engine families, one rule:

- **`whisper-cpp` is the cross-platform base.** It is the only engine that
  behaves the same on macOS, Windows, and Linux, it is what the team already
  runs, and it has the best accuracy in published comparisons
  (`large-v3-turbo`). Every other adapter is an optimisation on top of it,
  never a replacement for it.
- **`apple-speech` is the default on macOS 26 with Apple Silicon.** It wraps
  the system's `SpeechAnalyzer` / `SpeechTranscriber` through the `yap` CLI
  (`brew install finnvoor/tap/yap`): the model is downloaded and managed by
  the OS, nothing to fetch or store, no dedicated RAM, and two to three times
  faster than whisper turbo on the same machine. Spanish is supported. It is
  somewhat less accurate than whisper turbo, so a per-run
  `--engine whisper-cpp` (or `NEMEDA_MEETINGS_ENGINE`) keeps the base engine
  one flag away for critical or jargon-heavy meetings.

`meeting doctor` selects the engine in this order and records why:

1. `apple-speech` when the OS is macOS 26 or later on Apple Silicon and
   `yap` is installed or installable;
2. otherwise `whisper-cpp`, with a model tier from the hardware below;
3. `whisper` and `mlx-whisper` only when the operator names them.

With `apple-speech` there is no model tier and no memory floor: any Apple
Silicon Mac on macOS 26 qualifies as a `transcriber`. The rest of this
section applies to the whisper engines.

No model is required by the kit. For whisper engines, `meeting doctor` reads
CPU count, free memory, and whether Metal (Apple Silicon) or a CUDA/Vulkan
build is available, then recommends one tier. `large-v3-turbo` is the
recommendation for capable machines, not a requirement.

| Model (whisper.cpp ggml) | Download | RAM in use | Quality | Recommended when |
|---|---|---|---|---|
| `large-v3-turbo` | 1.6 GB | ~3 GB | high | Apple Silicon, or a PC with a supported GPU |
| `small` | 0.5 GB | ~1 GB | good enough for Spanish and English meetings | Intel/AMD laptop, 8 GB RAM or more, no GPU |
| `base` | 0.15 GB | ~0.5 GB | low | last resort, short recordings only |

Floor: fewer than 4 logical cores or less than 4 GB of free memory. Below it
`doctor` recommends no model and says the machine should run as `recorder`.
Above it, the recommendation is written to `.env.local` as
`NEMEDA_WHISPER_MODEL` by `meeting setup` after download, never guessed at
run time; the selected engine is written as `NEMEDA_MEETINGS_ENGINE` the same
way. Speed on CPU is roughly 1x to 3x real time with `small` and slower
than real time with `large-v3-turbo`; on Apple Silicon `large-v3-turbo` runs
several times faster than real time. `doctor` prints the estimate for a
one-hour meeting so the operator can decide.

### 4. Pipeline (`scripts/lib/meetings.mjs`)

Pure functions where possible, side effects behind explicit steps so each
one is testable with stubs:

1. **Discover**: list files in the watched folder (local for `recorder` and
   `full`, the shared `inbox` for `transcriber`) with a recording extension
   (`mkv`, `mp4`, `mov`, `m4a`, `wav`, `mp3`). A file is *ready* when its
   size has not changed for 60 s and it is not the twin of a file already
   processed (OBS "auto-remux" produces `x.mkv` + `x.mp4`; dedupe by
   basename). Processed recordings are recorded as
   `{ path, size, mtime, transcript, host }` in `.nemeda/state/meetings.json`
   (local watch) or `<inbox>/.processed.json` (shared inbox).
2. **Hand off** (`recorder` only): move the ready file into the shared
   `inbox`, keep a copy locally when `recordings.keep` is `local`. Stop here.
3. **Extract audio**: `ffmpeg -i <in> -vn -ac 1 -ar 16000 -c:a pcm_s16le
   <tmp>.wav` into the OS temp directory (whisper.cpp needs 16 kHz mono PCM).
   Skipped for `apple-speech`, which decodes the original file itself through
   AVFoundation.
4. **Transcribe**: engine adapter table, same shape as the drive providers:
   - `whisper-cpp` (base engine on every platform; `whisper-cli -m MODEL -f WAV
     -l LANG -t N -otxt -osrt -oj -of BASE`);
   - `apple-speech` (default on macOS 26 + Apple Silicon; `yap transcribe FILE
     --locale LANG --srt` plus a text pass, exact flags to be pinned against the
     installed `yap` version at implementation time);
   - `whisper` (openai-whisper CLI, opt-in);
   - `mlx-whisper` (Apple Silicon, opt-in).
   Each adapter exposes `available()`, `command(input, output, options)` and
   `parse(outputBase)` returning `{ text, segments, language, durationSeconds }`.
5. **File**: create `<transcripts>/<date>-<slug>/` with `transcript.txt`,
   `transcript.srt`, `transcript.json`, and `meta.json` (source path, sha256,
   duration, engine, model, language, transcribing host, processed-at).
   Create-if-absent: an existing folder is reported and left alone.
6. **Notes** (optional, `--notes` or `meetings.notes` present and a backend
   available): run the local agent through `buildBackendCommand`-style
   invocation with the `meeting-notes` skill prompt and the transcript on
   stdin, write `<notes>/<date>-<slug>.md` with Summary, Decisions, Action
   items (owner, due), Open questions, and a link to the transcript folder.
   When no backend is available the CLI prints the exact skill invocation to
   run in the next agent session instead.
7. **Log**: with `knowledgeLog: true` and an `airtable` section, create one
   Knowledge Log record (`Type = Meeting`, `Status = Pending`, `Entry = <date>
   <title>`, `Summary` = notes summary or first 500 characters). Dedupe via
   the state file, like the session logger.
8. **Recordings**: apply `recordings.keep`.

Every step appends an `action` object (`kind`, `status`, `message`) exactly
like `setup.mjs`, so `--json` output and the human summary come for free.

### 5. CLI surface (`nemeda-agent meeting`)

```
nemeda-agent meeting process [FILE] [--title TITLE] [--notes] [--dry-run] [--json]
nemeda-agent meeting list                         # ready, claimed, processed; local and inbox
nemeda-agent meeting watch [--interval 30]        # foreground loop, like `slack run`
nemeda-agent meeting install | uninstall          # launchd / systemd user unit / Task Scheduler
nemeda-agent meeting doctor [--json]              # role, engines, model, ffmpeg, OBS path, folders, capability
nemeda-agent meeting setup [--obs] [--model TIER] # install missing tools and the recommended model, on confirmation
```

`process` without `FILE` handles every ready recording for this machine's
role. `watch` polls (no `fs.watch`: unreliable on macOS for large files being
written and on cloud-synced folders). `install` reuses the launchd code path
from `slack install` with its own label. `setup` with role `recorder`
installs nothing except, with `--obs`, OBS.

### 6. Hooks and skills

- **SessionStart** `scripts/hooks/meeting-inbox.mjs`: directory listing only.
  If ready recordings exist for this machine's role, adds one context line:
  "2 recordings waiting in ~/Movies; run `nemeda-agent meeting process`" or,
  for a transcriber, "3 recordings from the team waiting in the inbox". No-op
  without a `meetings` section. Budget: well under one second.
- **Skill `meeting-notes`**: given a transcript path, produce the notes
  document with the template above, file it in `meetings.notes`, and offer to
  create the Knowledge Log entry. Used both interactively and by step 6.
- **Skill `workspace-context`**: taxonomy line mentions that transcripts and
  notes are produced by the kit and where they land.
- **Skill `workspace-create`**: asks whether the project records meetings;
  if so adds the `meetings` section with defaults and `docs/recordings/inbox`
  to the scaffold.
- **MCP** (optional, phase 4): `workspace_meetings` read-only tool listing
  recent transcript folders with their `meta.json`, so any agent can answer
  "what did we decide on Tuesday" without a Drive search.

### 7. Doctor

`meeting doctor` (also merged into `nemeda-agent doctor` / `workspace_doctor`
when the section exists):

| Code | Check |
|---|---|
| `meetings-role` | role resolved; `recorder` skips the tool checks below |
| `meetings-capability` | OS version and architecture first (native engine eligible?), then cores, free memory, GPU/Metal; recommended engine and, for whisper, model tier or "run as recorder" |
| `meetings-ffmpeg` | `ffmpeg` on PATH, with the install command when missing |
| `meetings-engine` | selected engine and why (`apple-speech` preferred where eligible, `whisper-cpp` base elsewhere), with the install command when missing |
| `meetings-model` | whisper engines only: model file exists, matches or exceeds the recommended tier, is not the tiny test model |
| `meetings-watch` | watch folder resolved (OBS profile, env, or inbox) and readable |
| `meetings-folders` | inbox/transcripts/notes exist and resolve through a Drive link |
| `meetings-backlog` | number of ready but unprocessed recordings, and the estimated time to clear it |
| `meetings-service` | launch agent installed and loaded (after `install`) |
| `meetings-transcriber` | at least one machine has claimed the transcriber role recently (heartbeat in `<inbox>/.transcribers.json`), otherwise warn that recordings will pile up |

## Tests

`tests/meetings.test.mjs`, `node --test`, no real audio:

- discovery: stable-size rule, twin dedupe, local and inbox state files,
  claim/unclaim with two fake hosts;
- roles: `recorder` hands off and stops, `transcriber` ignores the local
  folder, `full` does both;
- capability: engine selection from injected `{ platform, osVersion, arch,
  yapInstalled }` and tier recommendation from `{ cpus, freeMemory, gpu }`,
  floor behaviour, `NEMEDA_MEETINGS_ENGINE` override;
- naming: date extraction from OBS file names, slug sanitisation against the
  OneDrive character set, collision handling;
- engine adapters: `NEMEDA_WHISPER_BIN` and `NEMEDA_YAP_BIN` pointing at stub
  scripts in the temp dir that write canned `.txt/.srt/.json` outputs,
  `NEMEDA_FFMPEG_BIN` stub likewise, so `process` runs end to end in
  milliseconds with either engine; the `apple-speech` path must skip the
  ffmpeg step;
- setup: prints the right package-manager command per platform, runs nothing
  in `--dry-run`;
- filing: create-if-absent, `meta.json` content, `--dry-run` writes nothing;
- validator: `meetings` section rules, folders inside workspace, unknown keys;
- doctor: each check with and without the binary/model/folder present;
- inbox hook: output shape, no-op without config, sub-second on an empty
  folder.

## Phases

1. **Core**: `meetings.mjs` (discover, extract, transcribe via `whisper-cpp`,
   file), `meeting process`, `meeting list`, validator, schema, tests. Single
   machine, role `full`. Usable by hand from day one.
2. **Diagnostics, installation, and the native engine**: capability check,
   engine selection, the `apple-speech` adapter, model tiers, `meeting doctor`,
   `meeting setup` (including `yap` on eligible Macs), OBS folder detection,
   integration into `nemeda-agent doctor` and `workspace_doctor`, SessionStart
   inbox hook.
3. **Team roles**: shared `inbox`, `recorder` and `transcriber` roles, shared
   processed state and claims, transcriber heartbeat.
4. **Notes and log**: `meeting-notes` skill, local-backend notes generation,
   Airtable Knowledge Log entry, `recordings.keep`.
5. **Unattended**: `meeting watch`, `meeting install` (launchd first, then
   systemd user unit and Task Scheduler), optional `workspace_meetings` MCP
   tool, docs (`docs/meeting-capture.md` including the OBS walkthrough,
   `configuration.md`, README, `workspace-create` defaults).

Phase 1 alone already removes the manual copy step; each later phase is
independently shippable.

## Risks and open questions

- **Speaker diarization**: whisper.cpp only diarizes stereo input; real
  speaker labels need pyannote or similar (Python, models, not zero-dep).
  Start without speakers; leave a hook in the adapter interface for an
  external diarizer later.
- **Meeting title and attendees**: OBS knows nothing about the meeting. Phase
  1 takes `--title`; a later phase can read the calendar (macOS Calendar via
  `osascript`, or the existing calendar MCP) to propose title and attendees
  for the recording's time window.
- **Native engine accuracy and stability**: `apple-speech` is faster and
  lighter but measured less accurate than whisper `large-v3-turbo` in
  published tests, and `yap` is a third-party CLI over a first-generation API.
  Keep `whisper-cpp` installed next to it on transcribers, expose the per-run
  override, and pin the `yap` flags in the adapter with a doctor check on its
  version. The first `apple-speech` run on a machine triggers the OS model
  download, which needs network once.
- **Model download** (whisper engines): up to 1.6 GB from Hugging Face. `meeting setup` prints
  the `curl` command and downloads only on explicit confirmation; never
  silently. Models go to `~/.nemeda/models/` so several workspaces share them.
- **Inbox on a synced drive**: a 2 GB `mkv` takes time to upload from the
  recorder and download on the transcriber; the stable-size rule and the
  placeholder check from `onedrive-plan.md` cover it, but the transcriber
  should not sit on a metered connection. `doctor` reports the backlog size
  in GB as well as in files.
- **Long recordings on slow machines**: `doctor`'s time estimate is the
  guard; the `recorder` role is the answer when the estimate is unacceptable.
- **Privacy**: recordings may contain customer content. Transcripts and, with
  an inbox, recordings land on the shared drive by design, but the notes
  prompt runs through the operator's local agent only; nothing in the kit
  uploads audio elsewhere. Document this in `meeting-capture.md` and in the
  transcripts and inbox folder READMEs.
- **Dependency on the Slack backend invocation**: reuse `buildBackendCommand`
  as is, or extract a shared `scripts/lib/backend.mjs` first. Recommend the
  extraction in phase 4 so both features share one tested code path.
