# Shared storage setup, per platform and provider

The workspace mounts shared content (docs, config, skills, commands) from a
shared drive. Two providers are supported today, chosen with `drive.provider`
in `.nemeda/agent-kit.json` (`google`, the default, or `onedrive`; see
[configuration.md](configuration.md)). The kit finds the shared folder by
name on any platform for either provider, and `NEMEDA_DRIVE_ROOT` overrides
detection when a mount is unusual.

## Google Drive

### macOS

```bash
brew install --cask google-drive
```

Sign in and keep **Stream files** enabled. Drives appear under
`~/Library/CloudStorage/GoogleDrive-<email>/`; the kit searches every signed-in
account and every locale ("Shared drives", "Unidades compartidas", …).

### Windows

Install Google Drive for desktop from
<https://www.google.com/drive/download/> and sign in. It mounts a drive letter
(`G:` by default); the kit scans all drive letters and the
`%USERPROFILE%\Google Drive` mirror folder. Workspace links are created as
**directory junctions**, so no administrator rights or Developer Mode are
needed.

### Linux

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

## OneDrive / SharePoint

Set `"drive": { "provider": "onedrive", ... }`. The shared folder the kit
looks for is one of two things, and either works with the same `sharedDrive`
name:

- a **shared folder** from someone else's OneDrive, added to your own files
  ("Add shortcut to My files") — the team equivalent of "here is the drive,
  everyone open it once";
- a **SharePoint / Teams document library** synced with the OneDrive client —
  the closer equivalent of a Google shared drive, created from a Teams team
  or a SharePoint site.

A synced library is named `<Site> - <Library>` and the library part is
localized ("Documents", "Documentos", "Dokumente", …), so a configured
`sharedDrive: "Acme"` also matches `Acme - Documentos`. If more than one
folder matches equally well (for example the same name reachable as both a
personal shortcut and a synced library), `nemeda-agent doctor` reports every
candidate under `drive-ambiguous` instead of guessing — point
`NEMEDA_DRIVE_ROOT` at the right one.

### macOS

Install OneDrive (`brew install --cask onedrive`) and sign in. The client
streams every account and every synced library under
`~/Library/CloudStorage/`:

- `OneDrive-Personal`, `OneDrive-<Org>` — personal or work root; a shared
  folder someone added lives directly inside;
- `OneDrive-SharedLibraries-<Org>` — every synced SharePoint library, one
  folder per library, named `<Site> - <Library>`.

### Windows

Install OneDrive from
<https://www.microsoft.com/microsoft-365/onedrive/download> and sign in. The
kit reads `%OneDrive%`, `%OneDriveConsumer%`, and `%OneDriveCommercial%`
directly, plus any `%USERPROFILE%\OneDrive - <Org>` folder (the classic
per-account root). A newer sync client can instead create
`%USERPROFILE%\<Org>\<Site> - <Library>`; the kit only treats `<Org>` as a
mount once it already contains a library-shaped folder, so it does not scan
your whole profile. Workspace links are created as **directory junctions**,
same as Google Drive.

### Linux

There is no official client. Mount it with rclone
(`rclone mount onedrive: ~/OneDrive --daemon --vfs-cache-mode writes`) or
[onedriver](https://github.com/jstaf/onedriver); the kit scans `~/OneDrive`
and `~/onedrive`. Anything else: set `NEMEDA_DRIVE_ROOT` to the shared
folder path.

## Files On-Demand and streaming placeholders

Both clients can list a synced folder before its files are actually
downloaded (macOS Files On-Demand, Drive streaming). `skills` and `commands`
are read by every AI session at start, so `nemeda-agent doctor` warns
(`drive-placeholder`, macOS only today) when one of them still holds
undownloaded files — right-click the folder and choose **Always keep on this
device**.

## Verifying

```bash
nemeda-agent doctor
```

tells you whether a mount was found, which provider it matched, whether the
shared drive is visible, and whether every workspace link resolves to
content.
