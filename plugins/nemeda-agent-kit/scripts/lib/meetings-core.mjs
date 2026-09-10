// Everything about meeting capture that does not need the workspace
// configuration: the transcription engines, whisper models and tiers, the
// machine capability probe, OBS detection, recording discovery, naming, and
// the processed-state file. `workspace.mjs` imports the doctor, the doctor
// imports this module, and this module imports nothing of theirs, so the
// dependency graph stays a tree.

import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// mp4 first: OBS "auto-remux" writes x.mkv while recording and x.mp4 when
// done, and the mp4 is the finished artifact when both are present.
export const RECORDING_EXTENSIONS = [".mp4", ".mkv", ".mov", ".m4a", ".wav", ".mp3"];
// A recording is ready when nothing has written to it for this long; OBS
// keeps touching the file until the encoder closes it.
export const STABLE_SECONDS = 60;
export const STATE_FILE = "meetings.json";
export function modelsDirectory(environment = process.env) {
  return path.join(environment.HOME || os.homedir(), ".nemeda", "models");
}

function modelSearchDirectories(environment) {
  return [modelsDirectory(environment), path.join(environment.HOME || os.homedir(), "whisper-models")];
}

export function expandHome(candidate, environment = process.env) {
  if (typeof candidate !== "string" || !candidate) return candidate;
  if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    return path.join(environment.HOME || os.homedir(), candidate.slice(1));
  }
  return candidate;
}

export function executableOnPath(name, environment = process.env, platform = process.platform) {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\")) return existsSync(name);
  for (const entry of (environment.PATH || "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, platform === "win32" ? `${name}.exe` : name);
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

// ---------------------------------------------------------------------------
// Whisper models. No model is required by the kit; `doctor` recommends a
// tier from the hardware and `setup` downloads it on confirmation.
// ---------------------------------------------------------------------------

export const MODEL_TIERS = {
  "large-v3-turbo": { file: "ggml-large-v3-turbo.bin", downloadMB: 1620, ramGB: 3, quality: "high", rank: 3 },
  small: { file: "ggml-small.bin", downloadMB: 488, ramGB: 1, quality: "good enough for Spanish and English meetings", rank: 2 },
  base: { file: "ggml-base.bin", downloadMB: 148, ramGB: 0.5, quality: "low; short recordings only", rank: 1 }
};

export function modelDownloadUrl(tier) {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_TIERS[tier].file}`;
}

export function tierOfModel(modelPath) {
  const name = path.basename(modelPath || "");
  return Object.keys(MODEL_TIERS).find((tier) => MODEL_TIERS[tier].file === name) || null;
}

export function findWhisperModel(environment = process.env, searchDirectories = modelSearchDirectories(environment)) {
  const explicit = expandHome(environment.NEMEDA_WHISPER_MODEL, environment);
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const directory of searchDirectories) {
    if (!existsSync(directory)) continue;
    const candidates = readdirSync(directory).filter((name) => /^ggml-.*\.bin$/.test(name) && !name.startsWith("for-tests-"));
    // Prefer the highest known tier, then anything else alphabetically.
    candidates.sort((a, b) => (MODEL_TIERS[tierOfModel(b)]?.rank || 0) - (MODEL_TIERS[tierOfModel(a)]?.rank || 0) || a.localeCompare(b));
    if (candidates[0]) return path.join(directory, candidates[0]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Machine capability. Injected values keep the tests platform-independent.
// ---------------------------------------------------------------------------

// Darwin 25 is macOS 26 (Apple skipped 16 to 25); Darwin 20..24 were 11..15.
export function macosMajorFromDarwin(release) {
  const major = Number.parseInt(String(release || "").split(".")[0], 10);
  if (!Number.isFinite(major)) return null;
  return major >= 25 ? major + 1 : major - 9;
}

export function probeHost(environment = process.env, overrides = {}) {
  const platform = overrides.platform || process.platform;
  const arch = overrides.arch || process.arch;
  const release = overrides.release || os.release();
  const cores = overrides.cores ?? os.cpus().length;
  const totalMemoryGB = overrides.totalMemoryGB ?? Math.round(os.totalmem() / 2 ** 30);
  const macosMajor = platform === "darwin" ? macosMajorFromDarwin(release) : null;
  const appleSilicon = platform === "darwin" && arch === "arm64";
  const nvidia = overrides.nvidia ?? (platform !== "darwin" && executableOnPath("nvidia-smi", environment, platform));
  return {
    platform,
    arch,
    release,
    macosMajor,
    cores,
    totalMemoryGB,
    appleSilicon,
    gpu: appleSilicon ? "metal" : nvidia ? "nvidia" : null,
    appleSpeechEligible: appleSilicon && macosMajor !== null && macosMajor >= 26,
    tools: {
      ffmpeg: overrides.ffmpeg ?? executableOnPath(environment.NEMEDA_FFMPEG_BIN || "ffmpeg", environment, platform),
      whisperCli: overrides.whisperCli ?? executableOnPath(environment.NEMEDA_WHISPER_BIN || "whisper-cli", environment, platform),
      yap: overrides.yap ?? executableOnPath(environment.NEMEDA_YAP_BIN || "yap", environment, platform),
      brew: overrides.brew ?? executableOnPath("brew", environment, platform),
      winget: overrides.winget ?? executableOnPath("winget", environment, platform),
      obs: overrides.obs ?? (platform === "darwin" ? existsSync("/Applications/OBS.app") : executableOnPath("obs", environment, platform))
    }
  };
}

export const MINIMUM_CORES = 4;
export const MINIMUM_MEMORY_GB = 8;

export function recommendTier(host) {
  if (host.cores < MINIMUM_CORES || host.totalMemoryGB < MINIMUM_MEMORY_GB) {
    return { tier: null, reason: `${host.cores} cores and ${host.totalMemoryGB} GB are below the floor (${MINIMUM_CORES} cores, ${MINIMUM_MEMORY_GB} GB); this machine should record and let another one transcribe.` };
  }
  if (host.gpu === "metal") return { tier: "large-v3-turbo", reason: "Apple Silicon runs it several times faster than real time through Metal." };
  if (host.gpu === "nvidia") return { tier: "large-v3-turbo", reason: "an NVIDIA GPU is available." };
  return { tier: "small", reason: `no GPU: large-v3-turbo would be slower than real time on ${host.cores} CPU cores.` };
}

// Rough throughput in multiples of real time, used only for the estimates
// doctor prints so the operator can judge before committing a machine.
const SPEED_FACTORS = {
  "apple-speech": { any: 40 },
  "whisper-cpp": {
    "large-v3-turbo": { metal: 12, nvidia: 20, cpu: 0.7 },
    small: { metal: 30, nvidia: 40, cpu: 2.5 },
    base: { metal: 60, nvidia: 80, cpu: 6 }
  }
};

export function minutesPerHour(engineName, tier, host) {
  const table = SPEED_FACTORS[engineName];
  if (!table) return null;
  const factor = table.any ?? table[tier]?.[host.gpu || "cpu"];
  return factor ? Math.max(1, Math.round(60 / factor)) : null;
}

// ---------------------------------------------------------------------------
// Engines. `whisper-cpp` is the cross-platform base; `apple-speech` wraps the
// system SpeechAnalyzer through the `yap` CLI on macOS 26 + Apple Silicon.
// ---------------------------------------------------------------------------

const APPLE_LOCALES = { es: "es-ES", en: "en-US", ca: "ca-ES", pt: "pt-BR", fr: "fr-FR", de: "de-DE", it: "it-IT", ja: "ja-JP", zh: "zh-CN", ko: "ko-KR" };

export function appleLocale(language) {
  if (!language || language === "auto") return null;
  if (language.includes("-")) return language;
  return APPLE_LOCALES[language] || null;
}

function formatSrtTime(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const ms = total % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function segmentsToSrt(segments) {
  return segments.map((segment, index) => `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n${segment.text}\n`).join("\n");
}

// One paragraph per pause longer than two seconds: readable, still faithful.
export function segmentsToText(segments) {
  let text = "";
  let previousEnd = null;
  for (const segment of segments) {
    if (!segment.text) continue;
    if (text) text += previousEnd !== null && segment.start - previousEnd > 2 ? "\n\n" : " ";
    text += segment.text;
    previousEnd = segment.end;
  }
  return text;
}

const ENGINES = {
  "whisper-cpp": {
    label: "whisper.cpp",
    needsWav: true,
    needsModel: true,
    platforms: null,
    binary: (environment) => environment.NEMEDA_WHISPER_BIN || "whisper-cli",
    installed: (host) => host.tools.whisperCli,
    command({ binary, model, input, outputBase, language, threads }) {
      return {
        file: binary,
        args: ["-m", model, "-f", input, "-l", language, "-t", String(threads), "-otxt", "-osrt", "-oj", "-of", outputBase, "-np"]
      };
    },
    parse(outputBase) {
      const text = readIfExists(`${outputBase}.txt`);
      const srt = readIfExists(`${outputBase}.srt`);
      const rawJson = readIfExists(`${outputBase}.json`);
      let language = null;
      let segments = [];
      if (rawJson) {
        try {
          const parsed = JSON.parse(rawJson);
          language = parsed?.result?.language || null;
          segments = (parsed?.transcription || []).map((segment) => ({
            start: (segment?.offsets?.from ?? 0) / 1000,
            end: (segment?.offsets?.to ?? 0) / 1000,
            text: String(segment?.text || "").trim()
          }));
        } catch {
          segments = [];
        }
      }
      const durationSeconds = segments.length ? segments[segments.length - 1].end : null;
      return { text: text === null ? null : text.trim(), srt, language, segments, durationSeconds };
    }
  },
  "apple-speech": {
    label: "Apple Speech (yap)",
    needsWav: false,
    needsModel: false,
    platforms: ["darwin"],
    binary: (environment) => environment.NEMEDA_YAP_BIN || "yap",
    installed: (host) => host.tools.yap,
    eligible: (host) => host.appleSpeechEligible,
    command({ binary, input, outputBase, language }) {
      const locale = appleLocale(language);
      return {
        file: binary,
        args: ["transcribe", input, "--json", "--output-file", `${outputBase}.json`, ...(locale ? ["--locale", locale] : [])]
      };
    },
    parse(outputBase) {
      const rawJson = readIfExists(`${outputBase}.json`);
      if (rawJson === null) return { text: null, srt: null, language: null, segments: [], durationSeconds: null };
      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        return { text: null, srt: null, language: null, segments: [], durationSeconds: null };
      }
      const segments = (parsed?.segments || []).map((segment) => ({
        start: Number(segment?.start) || 0,
        end: Number(segment?.end) || 0,
        text: String(segment?.text || "").trim()
      }));
      return {
        text: segmentsToText(segments),
        srt: segmentsToSrt(segments),
        language: parsed?.metadata?.language || null,
        segments,
        durationSeconds: parsed?.metadata?.duration ?? (segments.length ? segments[segments.length - 1].end : null)
      };
    }
  }
};

export const DEFAULT_ENGINE = "whisper-cpp";

export function engineNames() {
  return Object.keys(ENGINES);
}

export function resolveEngine(name = DEFAULT_ENGINE) {
  const engine = ENGINES[name];
  if (!engine) throw new Error(`Unknown transcription engine "${name}"; available: ${engineNames().join(", ")}.`);
  return { name, ...engine };
}

// Selection order (docs/meeting-capture-plan.md §3): an explicit choice wins;
// otherwise apple-speech on an eligible Mac when yap is installed; otherwise
// whisper.cpp. `allowUninstalled` is for setup, which is about to install.
export function selectEngine(host, environment = process.env, { explicit = null, allowUninstalled = false } = {}) {
  const requested = explicit || environment.NEMEDA_MEETINGS_ENGINE || null;
  if (requested) {
    const engine = resolveEngine(requested);
    return { engine, reason: explicit ? "chosen with --engine" : "set by NEMEDA_MEETINGS_ENGINE", installed: engine.installed(host), alternative: null };
  }
  const apple = resolveEngine("apple-speech");
  const whisper = resolveEngine("whisper-cpp");
  if (host.appleSpeechEligible && (apple.installed(host) || allowUninstalled)) {
    return { engine: apple, reason: `macOS ${host.macosMajor} on Apple Silicon: system model, no download, fastest`, installed: apple.installed(host), alternative: null };
  }
  return {
    engine: whisper,
    reason: host.appleSpeechEligible ? "apple-speech is eligible here but yap is not installed" : "cross-platform base engine",
    installed: whisper.installed(host),
    alternative: host.appleSpeechEligible ? "apple-speech" : null
  };
}

// ---------------------------------------------------------------------------
// Installation commands per platform. `run` marks commands the kit may execute
// after confirmation; the rest are printed for the operator (sudo, downloads
// from release pages).
// ---------------------------------------------------------------------------

export function installCommands(host, { obs = false, engineName = null } = {}) {
  const steps = [];
  const wantsWhisper = engineName !== "apple-speech";
  const wantsApple = engineName === "apple-speech" || (engineName === null && host.appleSpeechEligible);
  if (host.platform === "darwin") {
    const formulae = [];
    if (!host.tools.ffmpeg && wantsWhisper) formulae.push("ffmpeg");
    if (!host.tools.whisperCli && wantsWhisper) formulae.push("whisper-cpp");
    if (!host.tools.yap && wantsApple) formulae.push("yap");
    if (formulae.length) {
      steps.push(host.tools.brew
        ? { kind: "tools", run: true, command: ["brew", "install", ...formulae], message: `Install ${formulae.join(", ")} with Homebrew.` }
        : { kind: "tools", run: false, command: null, message: `Install Homebrew (https://brew.sh) and then: brew install ${formulae.join(" ")}` });
    }
    if (obs && !host.tools.obs) {
      steps.push(host.tools.brew
        ? { kind: "obs", run: true, command: ["brew", "install", "--cask", "obs"], message: "Install OBS Studio with Homebrew." }
        : { kind: "obs", run: false, command: null, message: "Install OBS Studio from https://obsproject.com/download" });
    }
    return steps;
  }
  if (host.platform === "win32") {
    if (!host.tools.ffmpeg && wantsWhisper) {
      steps.push(host.tools.winget
        ? { kind: "tools", run: true, command: ["winget", "install", "--id", "Gyan.FFmpeg", "-e"], message: "Install ffmpeg with winget." }
        : { kind: "tools", run: false, command: null, message: "Install ffmpeg from https://www.gyan.dev/ffmpeg/builds/ and add it to PATH." });
    }
    if (!host.tools.whisperCli && wantsWhisper) {
      steps.push({ kind: "tools", run: false, command: null, message: "Download whisper.cpp for Windows from https://github.com/ggml-org/whisper.cpp/releases (whisper-bin-x64.zip), unzip, and set NEMEDA_WHISPER_BIN to whisper-cli.exe in .env.local." });
    }
    if (obs && !host.tools.obs) {
      steps.push(host.tools.winget
        ? { kind: "obs", run: true, command: ["winget", "install", "--id", "OBSProject.OBSStudio", "-e"], message: "Install OBS Studio with winget." }
        : { kind: "obs", run: false, command: null, message: "Install OBS Studio from https://obsproject.com/download" });
    }
    return steps;
  }
  if (!host.tools.ffmpeg && wantsWhisper) steps.push({ kind: "tools", run: false, command: null, message: "Install ffmpeg with your package manager: sudo apt install ffmpeg (or dnf/pacman)." });
  if (!host.tools.whisperCli && wantsWhisper) steps.push({ kind: "tools", run: false, command: null, message: "Install whisper.cpp: brew install whisper-cpp (Homebrew on Linux) or build from https://github.com/ggml-org/whisper.cpp and set NEMEDA_WHISPER_BIN." });
  if (obs && !host.tools.obs) steps.push({ kind: "obs", run: false, command: null, message: "Install OBS Studio: sudo apt install obs-studio (or the Flatpak)." });
  return steps;
}

// ---------------------------------------------------------------------------
// OBS: the recordings folder comes from the active profile so the common
// case needs no configuration at all.
// ---------------------------------------------------------------------------

export function obsProfileDirectories(environment = process.env, platform = process.platform) {
  const home = environment.HOME || os.homedir();
  if (platform === "darwin") return [path.join(home, "Library", "Application Support", "obs-studio", "basic", "profiles")];
  if (platform === "win32") return [path.join(environment.APPDATA || path.join(home, "AppData", "Roaming"), "obs-studio", "basic", "profiles")];
  return [path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "obs-studio", "basic", "profiles")];
}

export function detectObsRecordingFolder(environment = process.env, platform = process.platform) {
  for (const profilesDirectory of obsProfileDirectories(environment, platform)) {
    if (!existsSync(profilesDirectory)) continue;
    for (const profile of readdirSync(profilesDirectory)) {
      const ini = path.join(profilesDirectory, profile, "basic.ini");
      if (!existsSync(ini)) continue;
      const match = readFileSync(ini, "utf8").match(/^RecFilePath=(.+)$/m);
      if (match && existsSync(match[1].trim())) return match[1].trim();
    }
  }
  return null;
}

export function resolveWatchFolder(environment = process.env, platform = process.platform) {
  return expandHome(environment.NEMEDA_MEETINGS_WATCH, environment) || detectObsRecordingFolder(environment, platform) || null;
}

// ---------------------------------------------------------------------------
// Naming. `{date}` comes from the recording (OBS names files
// "YYYY-MM-DD HH-mm-ss"), `{slug}` from --title. The slug is restricted to
// the strictest provider's character set (OneDrive), so the folder name is
// valid on every shared drive.
// ---------------------------------------------------------------------------

export function slugify(title) {
  const slug = String(title || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function recordingTimestamp(filePath, mtime) {
  const base = path.basename(filePath, path.extname(filePath));
  const match = base.match(/(\d{4})-(\d{2})-(\d{2})(?:[ _T-](\d{2})[-:.](\d{2})(?:[-:.](\d{2}))?)?/);
  if (match) {
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return mtime instanceof Date ? mtime : new Date(mtime);
}

export function transcriptName(template, { timestamp, title }) {
  const date = `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())}`;
  const time = `${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}`;
  return template.replaceAll("{date}", date).replaceAll("{time}", time).replaceAll("{slug}", slugify(title));
}

// ---------------------------------------------------------------------------
// State: one record per processed recording, keyed by path + size + mtime so
// a re-exported file with the same name is seen as new.
// ---------------------------------------------------------------------------

export function statePath(root) {
  return path.join(root, ".nemeda", "state", STATE_FILE);
}

export function readState(root) {
  const filePath = statePath(root);
  if (!existsSync(filePath)) return { processed: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return { processed: Array.isArray(parsed?.processed) ? parsed.processed : [] };
  } catch {
    return { processed: [] };
  }
}

export function writeState(root, state) {
  const filePath = statePath(root);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function recordKey(entry) {
  return `${entry.path}|${entry.size}|${entry.mtime}`;
}

function twinKey(filePath) {
  return path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)));
}

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

export function discoverRecordings(watch, state, { now = Date.now(), stableSeconds = STABLE_SECONDS } = {}) {
  const result = { ready: [], pending: [], processed: [], twins: [] };
  if (!watch || !existsSync(watch)) return result;
  // Shared inbox state stores names relative to the folder, because every
  // machine mounts the drive at a different absolute path.
  const processed = state.processed.map((entry) => (path.isAbsolute(entry.path) ? entry : { ...entry, path: path.join(watch, entry.path) }));
  const processedKeys = new Set(processed.map(recordKey));
  const processedPaths = new Map();
  for (const entry of processed) {
    if (!processedPaths.has(twinKey(entry.path))) processedPaths.set(twinKey(entry.path), new Set());
    processedPaths.get(twinKey(entry.path)).add(entry.path);
  }
  const seenTwins = new Set();
  const candidates = readdirSync(watch, { withFileTypes: true })
    .filter((entry) => entry.isFile() && RECORDING_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(watch, entry.name))
    // Chronological (OBS names are date-first); extension priority only decides between twins.
    .sort((a, b) => twinKey(a).localeCompare(twinKey(b)) || RECORDING_EXTENSIONS.indexOf(path.extname(a).toLowerCase()) - RECORDING_EXTENSIONS.indexOf(path.extname(b).toLowerCase()));
  for (const filePath of candidates) {
    const stat = statSync(filePath);
    const entry = { path: filePath, size: stat.size, mtime: stat.mtimeMs };
    if (processedKeys.has(recordKey(entry))) {
      result.processed.push(entry);
      continue;
    }
    const twin = twinKey(filePath);
    const processedSiblings = processedPaths.get(twin);
    // A processed file hides its other-extension twins, never a re-exported
    // file with the same name (different size or mtime).
    const hiddenByProcessedTwin = Boolean(processedSiblings) && !processedSiblings.has(filePath);
    if (hiddenByProcessedTwin || seenTwins.has(twin)) {
      result.twins.push(entry);
      continue;
    }
    seenTwins.add(twin);
    if (now - stat.mtimeMs < stableSeconds * 1000) result.pending.push(entry);
    else result.ready.push(entry);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Team roles (docs/meeting-capture-plan.md §2). `recorder` hands finished
// recordings to the shared inbox; `transcriber` drains the inbox; `full`
// transcribes its own folder and the inbox. State for the inbox lives next
// to it so several machines agree on what is done and what is claimed.
// ---------------------------------------------------------------------------

export const ROLES = ["recorder", "transcriber", "full"];
export const DEFAULT_ROLE = "full";
export const SHARED_STATE_FILE = ".processed.json";
export const HEARTBEAT_FILE = ".transcribers.json";
export const CLAIM_MARKER = ".claimed-";
// A transcriber that has not reported in this long is treated as gone.
export const HEARTBEAT_STALE_HOURS = 48;

export function resolveRole(environment = process.env) {
  const value = String(environment.NEMEDA_MEETINGS_ROLE || DEFAULT_ROLE).trim().toLowerCase();
  if (!ROLES.includes(value)) throw new Error(`NEMEDA_MEETINGS_ROLE must be one of ${ROLES.join(", ")}; got "${value}".`);
  return value;
}

function readJsonSafe(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function sharedStatePath(inbox) {
  return path.join(inbox, SHARED_STATE_FILE);
}

export function readSharedState(inbox) {
  const parsed = readJsonSafe(sharedStatePath(inbox), null);
  return { processed: Array.isArray(parsed?.processed) ? parsed.processed : [] };
}

export function writeSharedState(inbox, state) {
  writeFileSync(sharedStatePath(inbox), `${JSON.stringify(state, null, 2)}\n`);
}

// Claims: `x.mkv` becomes `x.mkv.claimed-<host>` while one transcriber works
// on it. The rename is atomic on every filesystem the kit targets, the file
// stops matching RECORDING_EXTENSIONS so other transcribers skip it, and the
// original name (with its mtime and size) comes back when the work is done.
function safeHost(host) {
  return String(host || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function claimPath(filePath, host) {
  return `${filePath}${CLAIM_MARKER}${safeHost(host)}`;
}

export function claimRecording(filePath, host) {
  const target = claimPath(filePath, host);
  renameSync(filePath, target);
  return target;
}

export function releaseClaim(claimedPath) {
  const original = claimedPath.slice(0, claimedPath.lastIndexOf(CLAIM_MARKER));
  renameSync(claimedPath, original);
  return original;
}

export function listClaims(inbox) {
  if (!inbox || !existsSync(inbox)) return [];
  return readdirSync(inbox, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.includes(CLAIM_MARKER))
    .map((entry) => {
      const claimed = path.join(inbox, entry.name);
      const marker = entry.name.lastIndexOf(CLAIM_MARKER);
      return { path: claimed, original: path.join(inbox, entry.name.slice(0, marker)), host: entry.name.slice(marker + CLAIM_MARKER.length) };
    });
}

// A claim by this very host can only be left over from a run that died;
// releasing it makes the recording visible again.
export function reclaimStale(inbox, host) {
  const mine = listClaims(inbox).filter((claim) => claim.host === safeHost(host));
  for (const claim of mine) releaseClaim(claim.path);
  return mine.map((claim) => claim.original);
}

export function heartbeatPath(inbox) {
  return path.join(inbox, HEARTBEAT_FILE);
}

export function readHeartbeats(inbox) {
  const parsed = readJsonSafe(heartbeatPath(inbox), {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export function writeHeartbeat(inbox, host, details = {}, now = new Date()) {
  const beats = readHeartbeats(inbox);
  beats[safeHost(host)] = { ...details, lastSeen: now.toISOString() };
  writeFileSync(heartbeatPath(inbox), `${JSON.stringify(beats, null, 2)}\n`);
  return beats;
}

export function activeTranscribers(inbox, now = Date.now(), staleHours = HEARTBEAT_STALE_HOURS) {
  return Object.entries(readHeartbeats(inbox))
    .filter(([, beat]) => now - Date.parse(beat?.lastSeen || 0) < staleHours * 3_600_000)
    .map(([host, beat]) => ({ host, ...beat }));
}

// Hand-off: copy into the inbox under a temporary name, then rename, so a
// transcriber never sees a half-written file. The original stays where the
// recorder put it; `recordings.keep` (later phase) decides its fate.
export function handOffRecording(recording, inbox) {
  const target = path.join(inbox, path.basename(recording.path));
  if (existsSync(target)) return { target, status: "kept" };
  const part = `${target}.part`;
  copyFileSync(recording.path, part);
  renameSync(part, target);
  return { target, status: "created" };
}

// ---------------------------------------------------------------------------
// Transcript listing, for `workspace_meetings` (MCP) and the CLI: what has
// been transcribed, newest first, with the notes file when it exists.
// ---------------------------------------------------------------------------

export function listTranscripts(root, meetingsConfig, { limit = 20, since = null, query = "" } = {}) {
  const directory = path.join(root, meetingsConfig.transcripts);
  if (!existsSync(directory)) return [];
  const needle = String(query || "").trim().toLowerCase();
  const results = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(directory, entry.name);
    const metaPath = path.join(folder, "meta.json");
    if (!existsSync(metaPath)) continue;
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      continue;
    }
    const date = String(meta.recordedAt || "").slice(0, 10);
    if (since && date && date < since) continue;
    const transcriptPath = path.join(folder, "transcript.txt");
    let text = "";
    if (needle || results.length < limit) text = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "";
    if (needle && !`${meta.title || ""}\n${text}`.toLowerCase().includes(needle)) continue;
    const notesName = meetingsConfig.notes ? `${entry.name}.md` : null;
    const notesPath = notesName ? path.join(root, meetingsConfig.notes, notesName) : null;
    results.push({
      folder: path.relative(root, folder),
      title: meta.title || null,
      date,
      durationSeconds: meta.durationSeconds ?? null,
      language: meta.language || null,
      engine: meta.engine || null,
      recording: meta.sourceName || null,
      notes: notesPath && existsSync(notesPath) ? path.relative(root, notesPath) : null,
      excerpt: text.trim().slice(0, 300)
    });
  }
  results.sort((a, b) => b.date.localeCompare(a.date) || b.folder.localeCompare(a.folder));
  return results.slice(0, limit);
}
