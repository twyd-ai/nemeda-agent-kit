import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// NEMEDA_DRIVE_ROOT points directly at the shared drive folder; it overrides
// detection (useful for tests, Linux hosts, or several Google accounts).
export function findSharedDrive(sharedDriveName, environment = process.env) {
  const override = environment.NEMEDA_DRIVE_ROOT;
  if (override) {
    return existsSync(override)
      ? { drivePath: override, mount: path.dirname(override), error: null }
      : { drivePath: null, mount: null, error: `NEMEDA_DRIVE_ROOT does not exist: ${override}` };
  }
  const cloudStorage = path.join(os.homedir(), "Library", "CloudStorage");
  if (!existsSync(cloudStorage)) {
    return { drivePath: null, mount: null, error: "No Google Drive mount found; install Google Drive for desktop and sign in." };
  }
  const mounts = readdirSync(cloudStorage)
    .filter((name) => name.startsWith("GoogleDrive-"))
    .map((name) => path.join(cloudStorage, name));
  if (mounts.length === 0) {
    return { drivePath: null, mount: null, error: "No Google Drive mount found; install Google Drive for desktop and sign in." };
  }
  // "Shared drives" is localized ("Unidades compartidas", …), so search for
  // the drive by name one level below every top-level folder instead of
  // assuming the English segment.
  for (const mount of mounts) {
    for (const topLevel of safeReadDirectories(mount)) {
      const candidate = path.join(mount, topLevel, sharedDriveName);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return { drivePath: candidate, mount, error: null };
      }
    }
  }
  return {
    drivePath: null,
    mount: mounts[0],
    error: `Shared drive "${sharedDriveName}" not found under ${mounts.join(", ")}; ask the owner for access.`
  };
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
  return { ...located, links };
}
