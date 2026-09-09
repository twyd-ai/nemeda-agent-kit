import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// One entry per shared-storage provider. Everything provider-specific lives
// here — where the desktop client mounts, how to install it, and how a
// directory name is matched to `drive.sharedDrive` — so the rest of the kit
// (setup, links, scaffold, doctor) only ever consumes planDriveLinks().
//
// Google Drive layouts:
// - macOS: Google Drive for desktop streams under ~/Library/CloudStorage.
// - Windows: Google Drive for desktop mounts a drive letter (G: by default)
//   or mirrors into a folder under the user profile.
// - Linux: there is no official client; rclone / ocamlfuse mounts and GNOME's
//   gvfs are the common setups, so we scan their usual locations.
const PROVIDERS = {
  google: {
    id: "google",
    label: "Google Drive",
    client: "Google Drive for desktop",
    mountCandidates(environment, platform) {
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
    },
    installInstructions(platform) {
      if (platform === "darwin") {
        return "Install Google Drive for desktop (brew install --cask google-drive), sign in, and enable file streaming.";
      }
      if (platform === "win32") {
        return "Install Google Drive for desktop (https://www.google.com/drive/download/), sign in, and keep the default drive-letter mount.";
      }
      return "There is no official Google Drive client for Linux. Mount the drive with rclone (rclone mount gdrive: ~/GoogleDrive) or set NEMEDA_DRIVE_ROOT to the shared drive path. See docs/drive-setup.md.";
    },
    notFoundHint: "Create it in Google Drive (or ask the owner for access), wait for it to sync, and retry."
    // No matchSharedDrive: a Google shared drive folder carries the exact
    // name declared in the configuration.
  },
  // OneDrive layouts:
  // - macOS: the OneDrive client streams every account under
  //   ~/Library/CloudStorage, one folder per account (OneDrive-Personal,
  //   OneDrive-<Org>) plus one per synced SharePoint library collection
  //   (OneDrive-SharedLibraries-<Org>), which holds the "<Site> - <Library>"
  //   folders directly — no extra nesting versus a personal/org root.
  // - Windows: the classic client exposes %OneDrive%, %OneDriveConsumer%,
  //   and %OneDriveCommercial%, plus "OneDrive - <Org>" under the user
  //   profile; a newer SharePoint sync client mounts a library at
  //   %USERPROFILE%\<Org>\<Site> - <Library>, where <Org> is an arbitrary
  //   folder name. Scanning every folder under the profile as a candidate
  //   would be too broad, so only a top-level folder that already contains
  //   a "<Something> - <Something>"-shaped child is treated as an <Org> mount.
  // - Linux: no official client; rclone (`onedrive:`) and onedriver mount at
  //   the conventional ~/OneDrive.
  onedrive: {
    id: "onedrive",
    label: "OneDrive",
    client: "OneDrive",
    mountCandidates(environment, platform) {
      if (platform === "darwin") {
        const cloudStorage = path.join(os.homedir(), "Library", "CloudStorage");
        if (!existsSync(cloudStorage)) return [];
        return readdirSync(cloudStorage)
          .filter((name) => name.startsWith("OneDrive-"))
          .map((name) => path.join(cloudStorage, name));
      }
      if (platform === "win32") {
        const candidates = [];
        for (const key of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
          const root = environment[key];
          if (root && existsSync(root)) candidates.push(root);
        }
        const profile = environment.USERPROFILE;
        if (profile && existsSync(profile)) {
          for (const name of safeReadDirectories(profile)) {
            if (name.startsWith("OneDrive - ")) candidates.push(path.join(profile, name));
          }
          for (const name of safeReadDirectories(profile)) {
            const org = path.join(profile, name);
            if (candidates.includes(org)) continue;
            if (safeReadDirectories(org).some(looksLikeLibraryName)) candidates.push(org);
          }
        }
        return candidates;
      }
      const candidates = [];
      for (const name of ["OneDrive", "onedrive"]) {
        const mount = path.join(os.homedir(), name);
        if (existsSync(mount)) candidates.push(mount);
      }
      return candidates;
    },
    installInstructions(platform) {
      if (platform === "darwin") {
        return "Install OneDrive (brew install --cask onedrive), sign in, and let the initial sync finish.";
      }
      if (platform === "win32") {
        return "Install OneDrive (https://www.microsoft.com/microsoft-365/onedrive/download), sign in, and sync the shared folder (\"Add shortcut to My files\") or the SharePoint library (its Sync button).";
      }
      return "There is no official OneDrive client for Linux. Mount it with rclone (rclone mount onedrive: ~/OneDrive) or onedriver, or set NEMEDA_DRIVE_ROOT to the shared folder path. See docs/drive-setup.md.";
    },
    notFoundHint: "Add the shared folder to \"My files\" or sync the SharePoint library from the browser, wait for it to sync, and retry.",
    // Synced SharePoint libraries are named "<Site> - <Library>" and the
    // library name is localized ("Documents", "Documentos", "Dokumente"), so
    // an exact name match alone would miss them; accept any folder whose
    // name starts with "<sharedDriveName> - ".
    matchSharedDrive(sharedDriveName, entryName) {
      return entryName.startsWith(`${sharedDriveName} - `);
    }
  }
};

// Loose signal that a folder plays the "<Site> - <Library>" role, used only
// to decide whether an arbitrary top-level Windows folder is worth treating
// as a OneDrive mount — the real name match still runs through
// matchSharedDrive afterwards.
function looksLikeLibraryName(name) {
  return / - /.test(name);
}

export const DEFAULT_DRIVE_PROVIDER = "google";
export const DRIVE_PROVIDERS = Object.keys(PROVIDERS);

// Accepts a provider id or a `drive` config object; unknown ids return null
// so callers can report them (the validator rejects them before setup runs).
export function driveProvider(providerOrConfig = DEFAULT_DRIVE_PROVIDER) {
  const id = typeof providerOrConfig === "string"
    ? providerOrConfig
    : providerOrConfig?.provider || DEFAULT_DRIVE_PROVIDER;
  return PROVIDERS[id] || null;
}

// NEMEDA_DRIVE_MOUNTS (path-separator separated) beats platform scanning for
// every provider: for tests and for mounts the heuristics cannot know about.
export function driveMountCandidates(environment = process.env, platform = process.platform, provider = DEFAULT_DRIVE_PROVIDER) {
  if (environment.NEMEDA_DRIVE_MOUNTS) {
    return environment.NEMEDA_DRIVE_MOUNTS.split(path.delimiter).filter((mount) => existsSync(mount));
  }
  const entry = driveProvider(provider);
  return entry ? entry.mountCandidates(environment, platform) : [];
}

export function driveInstallInstructions(platform = process.platform, provider = DEFAULT_DRIVE_PROVIDER) {
  const entry = driveProvider(provider);
  return entry ? entry.installInstructions(platform) : `Unknown drive provider "${provider}". Supported: ${DRIVE_PROVIDERS.join(", ")}.`;
}

// The "Shared drives" segment is localized ("Unidades compartidas", …) and the
// mount layouts differ per platform, so instead of assuming any segment we
// search for the shared drive by name: directly under each mount root, and one
// level below it. NEMEDA_DRIVE_ROOT always wins: it points directly at the
// shared drive folder and skips detection entirely (tests, unusual mounts,
// several accounts).
export function findSharedDrive(sharedDriveName, environment = process.env, platform = process.platform, provider = DEFAULT_DRIVE_PROVIDER) {
  const override = environment.NEMEDA_DRIVE_ROOT;
  if (override) {
    return existsSync(override)
      ? { drivePath: override, mount: path.dirname(override), error: null, ambiguous: [] }
      : { drivePath: null, mount: null, error: `NEMEDA_DRIVE_ROOT does not exist: ${override}`, ambiguous: [] };
  }
  const entry = driveProvider(provider);
  if (!entry) {
    return { drivePath: null, mount: null, error: `Unknown drive provider "${provider}". Supported: ${DRIVE_PROVIDERS.join(", ")}.`, ambiguous: [] };
  }
  const mounts = driveMountCandidates(environment, platform, entry.id);
  if (mounts.length === 0) {
    return { drivePath: null, mount: null, error: `No ${entry.label} mount found. ${entry.installInstructions(platform)}`, ambiguous: [] };
  }
  // A folder named like the drive can exist in "My Drive" too, so a name match
  // alone is ambiguous. The structural difference is reliable across locales:
  // the shared-drives container holds only directories (one per drive), while
  // a personal My Drive holds loose files. Prefer the clean container.
  const matches = [];
  for (const mount of mounts) {
    for (const drivePath of matchingDirectories(mount, sharedDriveName, entry)) {
      matches.push({ drivePath, mount, rank: 1 });
    }
    for (const topLevel of safeReadDirectories(mount)) {
      const container = path.join(mount, topLevel);
      for (const drivePath of matchingDirectories(container, sharedDriveName, entry)) {
        matches.push({ drivePath, mount, rank: directoryHoldsOnlyDirectories(container) ? 0 : 2 });
      }
    }
  }
  matches.sort((a, b) => a.rank - b.rank);
  if (matches.length > 0) {
    const bestRank = matches[0].rank;
    // Two matches at different ranks are not ambiguous: the ranking already
    // expresses a deliberate preference (a clean container over a personal
    // root holding loose files). Only a tie at the best rank — two
    // equally-plausible candidates, e.g. a shared folder and a synced
    // library with the same name — is worth a doctor warning instead of
    // silently picking one.
    const ambiguous = [...new Set(matches.filter((match) => match.rank === bestRank).map((match) => match.drivePath))];
    return {
      drivePath: matches[0].drivePath,
      mount: matches[0].mount,
      error: null,
      ambiguous: ambiguous.length > 1 ? ambiguous : []
    };
  }
  return {
    drivePath: null,
    mount: mounts[0],
    error: `Shared drive "${sharedDriveName}" not found under ${mounts.join(", ")}. ${entry.notFoundHint}`,
    ambiguous: []
  };
}

// Directories inside `container` that play the role of the shared drive: the
// exact name always counts (an existsSync check, so case-insensitive
// filesystems behave as before); a provider may add its own naming rule
// through matchSharedDrive(name, entryName) for layouts such as synced
// document libraries named "<Site> - <Library>".
function matchingDirectories(container, sharedDriveName, entry) {
  const found = [];
  const direct = path.join(container, sharedDriveName);
  if (isDirectory(direct)) found.push(direct);
  if (typeof entry.matchSharedDrive === "function") {
    for (const name of safeReadDirectories(container)) {
      if (name !== sharedDriveName && entry.matchSharedDrive(sharedDriveName, name)) found.push(path.join(container, name));
    }
  }
  return found;
}

function isDirectory(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
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
  const provider = driveConfig.provider || DEFAULT_DRIVE_PROVIDER;
  const located = findSharedDrive(driveConfig.sharedDrive, environment, process.platform, provider);
  const links = Object.entries(driveConfig.links || {}).map(([linkPath, drivePath]) => ({
    linkPath: path.join(root, linkPath),
    relativeLinkPath: linkPath,
    target: located.drivePath ? path.join(located.drivePath, drivePath) : null
  }));
  const scaffold = (driveConfig.scaffold || []).map((folder) => ({
    relativePath: folder,
    target: located.drivePath ? path.join(located.drivePath, folder) : null
  }));
  return { ...located, provider, links, scaffold };
}
