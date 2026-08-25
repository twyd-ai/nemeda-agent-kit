import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Where Google Drive can be mounted, per platform:
// - macOS: Google Drive for desktop streams under ~/Library/CloudStorage.
// - Windows: Google Drive for desktop mounts a drive letter (G: by default)
//   or mirrors into a folder under the user profile.
// - Linux: there is no official client; rclone / ocamlfuse mounts and GNOME's
//   gvfs are the common setups, so we scan their usual locations.
// NEMEDA_DRIVE_ROOT always wins: it points directly at the shared drive folder
// and skips detection entirely (tests, unusual mounts, several accounts).
export function driveMountCandidates(environment = process.env, platform = process.platform) {
  // Explicit mount roots (path-separator separated) beat platform scanning:
  // for tests and for mounts the heuristics cannot know about.
  if (environment.NEMEDA_DRIVE_MOUNTS) {
    return environment.NEMEDA_DRIVE_MOUNTS.split(path.delimiter).filter((mount) => existsSync(mount));
  }
  const home = os.homedir();
  if (platform === "darwin") {
    const cloudStorage = path.join(home, "Library", "CloudStorage");
    if (!existsSync(cloudStorage)) return [];
    return readdirSync(cloudStorage)
      .filter((name) => name.startsWith("GoogleDrive-"))
      .map((name) => path.join(cloudStorage, name));
  }
  if (platform === "win32") {
    const candidates = [];
    for (let code = "D".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      if (existsSync(root)) candidates.push(root);
    }
    for (const name of ["Google Drive", "GoogleDrive"]) {
      const mirror = path.join(home, name);
      if (existsSync(mirror)) candidates.push(mirror);
    }
    return candidates;
  }
  const candidates = [];
  for (const name of ["GoogleDrive", "google-drive", "gdrive", "Google Drive", "grive"]) {
    const mount = path.join(home, name);
    if (existsSync(mount)) candidates.push(mount);
  }
  const gvfs = `/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}/gvfs`;
  if (existsSync(gvfs)) {
    for (const entry of safeReadDirectories(gvfs)) {
      if (entry.includes("google-drive")) candidates.push(path.join(gvfs, entry));
    }
  }
  return candidates;
}

export function driveInstallInstructions(platform = process.platform) {
  if (platform === "darwin") {
    return "Install Google Drive for desktop (brew install --cask google-drive), sign in, and enable file streaming.";
  }
  if (platform === "win32") {
    return "Install Google Drive for desktop (https://www.google.com/drive/download/), sign in, and keep the default drive-letter mount.";
  }
  return "There is no official Google Drive client for Linux. Mount the drive with rclone (rclone mount gdrive: ~/GoogleDrive) or set NEMEDA_DRIVE_ROOT to the shared drive path. See docs/drive-setup.md.";
}

// The "Shared drives" segment is localized ("Unidades compartidas", …) and the
// mount layouts differ per platform, so instead of assuming any segment we
// search for the shared drive by name: directly under each mount root, and one
// level below it.
export function findSharedDrive(sharedDriveName, environment = process.env, platform = process.platform) {
  const override = environment.NEMEDA_DRIVE_ROOT;
  if (override) {
    return existsSync(override)
      ? { drivePath: override, mount: path.dirname(override), error: null }
      : { drivePath: null, mount: null, error: `NEMEDA_DRIVE_ROOT does not exist: ${override}` };
  }
  const mounts = driveMountCandidates(environment, platform);
  if (mounts.length === 0) {
    return { drivePath: null, mount: null, error: `No Google Drive mount found. ${driveInstallInstructions(platform)}` };
  }
  // A folder named like the drive can exist in "My Drive" too, so a name match
  // alone is ambiguous. The structural difference is reliable across locales:
  // the shared-drives container holds only directories (one per drive), while
  // a personal My Drive holds loose files. Prefer the clean container.
  const matches = [];
  for (const mount of mounts) {
    const direct = path.join(mount, sharedDriveName);
    if (existsSync(direct) && statSync(direct).isDirectory()) {
      matches.push({ drivePath: direct, mount, rank: 1 });
    }
    for (const topLevel of safeReadDirectories(mount)) {
      const candidate = path.join(mount, topLevel, sharedDriveName);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        matches.push({ drivePath: candidate, mount, rank: directoryHoldsOnlyDirectories(path.join(mount, topLevel)) ? 0 : 2 });
      }
    }
  }
  matches.sort((a, b) => a.rank - b.rank);
  if (matches.length > 0) {
    return { drivePath: matches[0].drivePath, mount: matches[0].mount, error: null };
  }
  return {
    drivePath: null,
    mount: mounts[0],
    error: `Shared drive "${sharedDriveName}" not found under ${mounts.join(", ")}. Create it in Google Drive (or ask the owner for access), wait for it to sync, and retry.`
  };
}

function directoryHoldsOnlyDirectories(directory) {
  try {
    const entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name !== ".DS_Store");
    return entries.length > 0 && entries.every((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

function safeReadDirectories(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function planDriveLinks(root, driveConfig, environment = process.env) {
  const located = findSharedDrive(driveConfig.sharedDrive, environment);
  const links = Object.entries(driveConfig.links || {}).map(([linkPath, drivePath]) => ({
    linkPath: path.join(root, linkPath),
    relativeLinkPath: linkPath,
    target: located.drivePath ? path.join(located.drivePath, drivePath) : null
  }));
  const scaffold = (driveConfig.scaffold || []).map((folder) => ({
    relativePath: folder,
    target: located.drivePath ? path.join(located.drivePath, folder) : null
  }));
  return { ...located, links, scaffold };
}
