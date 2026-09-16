// The one identity every project-memory path writes and reviews under:
// `memory add` and `review`, the harvester, meeting entries (recordEntry),
// recaps and closures, and sync. NEMEDA_MEMORY_AUTHOR — in the environment or
// in ~/.nemeda/.env.local, per person and never per project — wins over
// `git config user.email`, for people whose git email is a GitHub noreply
// address they keep for their commits.
//
// One source for every path is what preserves the single-writer rule: an
// override honoured by only some paths would file entries in a journal that
// `memory review` then refuses to revise on the same machine (the reason
// meeting entries never used GIT_AUTHOR_EMAIL, commit 22251c8).
//
// Imports nothing from memory.mjs or workspace.mjs, so both can use it.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ENV_LOCAL_NAME, loadEnvLocal } from "./env.mjs";

export const MEMORY_AUTHOR_VARIABLE = "NEMEDA_MEMORY_AUTHOR";
const NOREPLY_PATTERN = /@users\.noreply\.github\.com$/i;

function personalHomeEnvPath(environment) {
  return path.join(environment.NEMEDA_HOME || path.join(os.homedir(), ".nemeda"), ENV_LOCAL_NAME);
}

function personalOverride(environment) {
  if (environment[MEMORY_AUTHOR_VARIABLE]) return { value: environment[MEMORY_AUTHOR_VARIABLE], from: "environment" };
  const personal = {};
  loadEnvLocal(path.dirname(personalHomeEnvPath(environment)), personal);
  if (personal[MEMORY_AUTHOR_VARIABLE]) return { value: personal[MEMORY_AUTHOR_VARIABLE], from: personalHomeEnvPath(environment) };
  return null;
}

export function gitAuthorEmail(root) {
  try {
    return execFileSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function plausibleEmail(value) {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

// { email, source: "NEMEDA_MEMORY_AUTHOR" | "git" | null, from, invalid }.
// An override that is set but not an email yields email "" and invalid: true
// rather than silently falling back to git — a typo must not quietly start a
// second journal under another identity.
export function memoryAuthor(root, environment = process.env) {
  const override = personalOverride(environment);
  if (override) {
    const value = String(override.value).trim();
    return plausibleEmail(value)
      ? { email: value, source: MEMORY_AUTHOR_VARIABLE, from: override.from, invalid: false }
      : { email: "", source: MEMORY_AUTHOR_VARIABLE, from: override.from, invalid: true };
  }
  const email = gitAuthorEmail(root);
  return { email, source: email ? "git" : null, from: email ? "git config user.email" : null, invalid: false };
}

export function isGithubNoreply(email) {
  return NOREPLY_PATTERN.test(email || "");
}

// The memory-author doctor row: silent when the identity is fine, a warning
// when it is missing or a GitHub noreply address teammates would not
// recognise, a failure when the override is not an email.
export function memoryAuthorCheck(root, environment = process.env) {
  const author = memoryAuthor(root, environment);
  if (author.invalid) {
    return { status: "fail", code: "memory-author", message: `${MEMORY_AUTHOR_VARIABLE} (${author.from}) is not an email address; fix it, or remove it to fall back to git config user.email.` };
  }
  if (!author.email) {
    return { status: "warn", code: "memory-author", message: `No memory identity: set ${MEMORY_AUTHOR_VARIABLE}=you@company in ${personalHomeEnvPath(environment)}, or git config user.email.` };
  }
  if (author.source === "git" && isGithubNoreply(author.email)) {
    return { status: "warn", code: "memory-author", message: `Memory entries would be attributed to your GitHub noreply address (${author.email}), which teammates will not recognise; set ${MEMORY_AUTHOR_VARIABLE}=<your work email> in ${personalHomeEnvPath(environment)}.` };
  }
  return { status: "pass", code: "memory-author", message: `Memory entries are attributed to ${author.email} (${author.from}).` };
}
