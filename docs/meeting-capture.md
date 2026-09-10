# Meeting capture

Record a meeting, get a filed transcript, meeting notes, and a project-memory
entry on the shared drive, without touching whisper by hand or copying files.
This is the user guide; the design and its phases are in
[meeting-capture-plan.md](meeting-capture-plan.md) and the configuration
contract in [configuration.md](configuration.md#meeting-capture-meetings).

## What happens

1. A recording lands in the folder the kit watches: OBS's recording folder by
   default, or wherever Zoom, Teams, or Meet save their native recordings.
2. Once the file has not changed for 60 seconds, `nemeda-agent meeting
   process` (by hand, from the session-start hint, or from the unattended
   watch loop) transcribes it: Apple's on-device speech model on macOS 26 with
   Apple Silicon, whisper.cpp everywhere else.
3. The transcript is filed as `<meetings.transcripts>/<date>-<slug>/` with
   `transcript.txt`, `transcript.srt`, `transcript.json`, and `meta.json`.
4. Your own Claude Code or Codex CLI writes the notes (Summary, Decisions,
   Action items, Open questions) into `<meetings.notes>/<date>-<slug>.md`.
5. One entry of type `meeting` is appended to the project memory, so
   `nemeda-agent memory search` and the `memory_search` MCP tool find it.
6. The recording stays where it was, or is archived or deleted later,
   according to `meetings.recordings`.

Everything runs on your machines. Audio never leaves the team's laptops and
the shared drive; the notes are produced by a subscription you already have.

## Quick start (one machine)

1. Add to `.nemeda/agent-kit.json`:

   ```json
   "meetings": {
     "transcripts": "docs/transcripts",
     "notes": "docs/meetings"
   }
   ```

   Both folders should sit inside the `docs` Drive link so the whole team
   sees them (`nemeda-agent setup` creates them when they are in
   `drive.scaffold`).
2. `nemeda-agent meeting doctor` tells you what this machine can do and what
   is missing. `nemeda-agent meeting setup` installs it after showing the
   plan: `ffmpeg` and `whisper-cpp` through Homebrew or winget, `yap` on an
   eligible Mac, the recommended whisper model into `~/.nemeda/models/`, and
   the choices into `.env.local`. Nothing runs without a yes.
3. Record a meeting. `nemeda-agent meeting list` shows it as ready a minute
   after you stop; `nemeda-agent meeting process --title "Weekly sync"`
   transcribes it, writes the notes, and logs the memory entry.
4. `nemeda-agent meeting install` registers the watch loop as a user service
   so steps 3 and 4 happen by themselves from then on.

## Recording with OBS

OBS is recommended, not required: any recording that reaches the watched
folder is processed. If you already record natively in Zoom, Teams, or Meet,
point `NEMEDA_MEETINGS_WATCH` in `.env.local` at that folder and skip this
section.

Minimal OBS setup for a browser or desktop meeting:

1. Install OBS Studio (`nemeda-agent meeting setup --obs`, or
   <https://obsproject.com/download>).
2. **Audio.** On macOS the system does not expose "what the speakers play" as
   an input, so the other participants' voices need a virtual audio device:
   install BlackHole (`brew install blackhole-2ch`), create a Multi-Output
   Device in Audio MIDI Setup that includes your speakers and BlackHole, and
   select it as the Mac's output while recording. In OBS add two sources:
   *Audio Input Capture* for your microphone and *Audio Input Capture* for
   BlackHole. On Windows the *Desktop Audio* source captures system audio
   directly.
3. **Video.** Add a *Window Capture* of the meeting window, or *Display
   Capture* of the screen you share. Video only matters if you want to watch
   the recording later; the kit uses the audio track.
4. **Output.** Settings → Output → Recording: choose a folder (the kit reads
   it from OBS's profile, so it needs no configuration), format `mkv` or
   `mp4` (with `mkv`, enable "Automatically remux to mp4" if you want both;
   the kit transcribes the mp4 and ignores the mkv twin), and a modest video
   bitrate — the audio is what counts.
5. Press *Start Recording* when the meeting starts and *Stop Recording* when
   it ends. OBS names the file `YYYY-MM-DD HH-mm-ss`, which is where the
   transcript's date comes from.

## Engines and what a machine needs

| Engine | Where | Needs | Notes |
|---|---|---|---|
| `apple-speech` | macOS 26, Apple Silicon | `yap` (Homebrew) | System model, no download, no dedicated memory, two to three times faster than whisper turbo, slightly less accurate. Selected automatically when eligible. |
| `whisper-cpp` | macOS, Windows, Linux | `ffmpeg`, `whisper-cli`, one ggml model | The cross-platform base and the most accurate option with `large-v3-turbo`. |

`meeting doctor` recommends a whisper model from the hardware:
`large-v3-turbo` on Apple Silicon or with an NVIDIA GPU, `small` on a
CPU-only machine with 8 GB or more, none below 4 cores or 8 GB (that machine
should only record). `--engine whisper-cpp` on any command overrides the
automatic choice for a critical meeting.

Rough time per hour of audio: about 2 minutes with `apple-speech`, 5 with
whisper turbo on Apple Silicon, 25 with `small` on a CPU-only laptop, and
over an hour with turbo on a CPU-only laptop.

## Working as a team

Not every machine has to transcribe. Declare a shared inbox on the drive and
give each machine a role in `.env.local`:

```json
"meetings": {
  "inbox": "docs/recordings/inbox",
  "transcripts": "docs/transcripts",
  "notes": "docs/meetings"
}
```

```
NEMEDA_MEETINGS_ROLE=recorder      # this laptop only records and hands off
NEMEDA_MEETINGS_ROLE=transcriber   # this Mac drains the team inbox
NEMEDA_MEETINGS_ROLE=full          # default: both, on one machine
```

A recorder copies each finished recording into the inbox once and needs no
tools at all. A transcriber claims a recording (renaming it to
`<name>.claimed-<host>`, invisible to other transcribers), transcribes it,
files the transcript and notes, renames it back, and records it as done in
`<inbox>/.processed.json`. Transcribers leave a heartbeat; a recorder's
`meeting doctor` warns when nobody has transcribed for 48 hours. Two
transcribers can share one inbox.

Recordings are big. Keep the inbox on a drive with room for them, and use
`meetings.recordings` (`archive` to a drive folder, or `delete` after N
days) so it does not grow forever.

## Notes and memory

Notes are written by `claude` or `codex` on the machine that transcribed,
read-only and with every tool denied: the transcript goes on stdin, the
answer is Markdown with four fixed sections in the transcript's language.
The file starts with a header (date, recording, transcript path, generator)
so it explains itself on the drive.

The memory entry uses the notes' Summary as its summary and points at the
transcript, the notes, the recording, and the engine. It is written by the
memory module's `recordEntry`, under this machine's `git config user.email`,
and only when the workspace has a `memory` section.

If no CLI is available when a meeting is transcribed, the run says so and
the transcript is still filed. Later, `nemeda-agent meeting notes
docs/transcripts/<date>-<slug>` (or the `meeting-notes` skill in an agent
session) produces the notes and the memory entry; `--force` regenerates
them.

## Unattended mode

`nemeda-agent meeting watch` runs `process` for this machine's role every 30
seconds in the foreground and logs only what changed. `nemeda-agent meeting
install` writes a launchd agent (macOS) or a systemd user unit (Linux) that
runs the loop at login and prints the command that loads it; on Windows it
prints the `schtasks` command to register the same loop at logon.
`nemeda-agent meeting uninstall` stops and removes it. Logs go to
`~/.nemeda/state/meetings-<project>.log`; `meeting doctor` reports whether
the service is installed and loaded.

## Asking the agent about meetings

The `workspace_meetings` MCP tool lists transcribed meetings (newest first,
with title, date, duration, notes file, and an excerpt) and filters by text
or date, so any agent session can answer "what did we decide on Tuesday" and
then read the transcript or notes it points at. The session-start hook adds
one line whenever recordings are waiting, so the agent can offer to run
`meeting process`.

## Troubleshooting

- **"still being written"**: the file changed less than 60 seconds ago.
  Wait, or check that OBS has stopped recording. On a synced inbox it also
  means the sync client is still downloading.
- **Nothing found in the recordings folder**: `meeting doctor` shows which
  folder is watched. OBS's profile must have a recording path, or set
  `NEMEDA_MEETINGS_WATCH`.
- **Empty transcript**: the recording has no usable audio track (wrong input
  selected in OBS). The kit files nothing and says so.
- **Notes error "Not logged in"**: the CLI the kit calls has no session on
  this machine; run `claude login` (or `codex login`) once in a terminal.
- **Two transcribers, one recording**: the second sees it as claimed and
  skips it. A claim left by a machine that crashed is released the next time
  that same machine runs.
- **Model too slow**: `meeting doctor` prints the estimate; switch the model
  with `meeting setup --model small`, install `yap` on an eligible Mac, or
  make this machine a recorder.
