# Google Drive setup, per platform

The workspace mounts shared content (docs, config, skills, commands) from a
Google shared drive. The kit finds the drive by name on any platform, and
`NEMEDA_DRIVE_ROOT` overrides detection when a mount is unusual.

## macOS

```bash
brew install --cask google-drive
```

Sign in and keep **Stream files** enabled. Drives appear under
`~/Library/CloudStorage/GoogleDrive-<email>/`; the kit searches every signed-in
account and every locale ("Shared drives", "Unidades compartidas", …).

## Windows

Install Google Drive for desktop from
<https://www.google.com/drive/download/> and sign in. It mounts a drive letter
(`G:` by default); the kit scans all drive letters and the
`%USERPROFILE%\Google Drive` mirror folder. Workspace links are created as
**directory junctions**, so no administrator rights or Developer Mode are
needed.

## Linux

There is no official client. Two working setups:

- **rclone** (recommended):

  ```bash
  rclone config                 # create a remote named gdrive (drive type)
  mkdir -p ~/GoogleDrive
  rclone mount gdrive: ~/GoogleDrive --daemon --vfs-cache-mode writes
  ```

  Mount the whole account (shared drives appear one level down) or a single
  shared drive; with `--drive-team-drive` pointing at one drive, set
  `NEMEDA_DRIVE_ROOT=~/GoogleDrive` since the mount root *is* the drive.

- **GNOME online accounts** (gvfs): add the Google account in Settings; the
  kit scans `/run/user/<uid>/gvfs/` for google-drive mounts. File names can be
  odd under gvfs, so rclone is the better developer experience.

The kit scans `~/GoogleDrive`, `~/google-drive`, `~/gdrive`, `~/Google Drive`
and gvfs. Anything else: set `NEMEDA_DRIVE_ROOT` to the shared drive path.

## Verifying

```bash
nemeda-agent doctor
```

tells you whether a mount was found, whether the shared drive is visible, and
whether every workspace link resolves to content.
