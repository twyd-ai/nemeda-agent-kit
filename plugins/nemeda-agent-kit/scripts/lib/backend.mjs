// Local agent backend for one-shot generation: the operator's own Claude Code
// or Codex subscription through its CLI, the same principle as the Slack
// bridge (no API key, nothing billed separately). Read-only by construction:
// the transcript arrives on stdin (claude) or as a file in a read-only
// sandbox (codex), and every tool that could write or reach the network is
// denied. `parseBackendOutput` is shared with the Slack runner.

import { spawnSync } from "node:child_process";
import { executableOnPath } from "./meetings-core.mjs";
import { parseBackendOutput } from "./slack.mjs";

export const BACKENDS = ["claude", "codex"];

export function backendBinary(backend, environment = process.env) {
  if (backend === "claude") return environment.NEMEDA_CLAUDE_BIN || "claude";
  if (backend === "codex") return environment.NEMEDA_CODEX_BIN || "codex";
  return null;
}

// NEMEDA_MEETINGS_BACKEND wins; otherwise the first CLI found on PATH.
export function detectBackend(environment = process.env) {
  const requested = String(environment.NEMEDA_MEETINGS_BACKEND || "").trim().toLowerCase();
  if (requested) {
    if (!BACKENDS.includes(requested)) throw new Error(`NEMEDA_MEETINGS_BACKEND must be one of ${BACKENDS.join(", ")}; got "${requested}".`);
    return { backend: requested, installed: executableOnPath(backendBinary(requested, environment), environment), reason: "set by NEMEDA_MEETINGS_BACKEND" };
  }
  for (const backend of BACKENDS) {
    if (executableOnPath(backendBinary(backend, environment), environment)) return { backend, installed: true, reason: `${backend} found on PATH` };
  }
  return { backend: null, installed: false, reason: "neither claude nor codex is on PATH" };
}

const DENIED_TOOLS = "Bash Write Edit NotebookEdit WebFetch WebSearch Task Agent Read Grep Glob";

// `instructions` is the task; `inputPath` a file the backend may read
// (codex) whose content is also passed on stdin (claude), so neither
// backend needs any tool.
export function backendCommand({ backend, model, instructions, cwd, inputFile }, environment = process.env) {
  const binary = backendBinary(backend, environment);
  if (backend === "codex") {
    return {
      command: binary,
      args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd, `${instructions}\n\nThe input is the file ${inputFile} in the current directory; read it.`],
      stdin: ""
    };
  }
  return {
    command: binary,
    args: ["-p", instructions, "--output-format", "json", ...(model ? ["--model", model] : []), "--disallowed-tools", DENIED_TOOLS],
    stdin: null // filled by the caller with the input content
  };
}

export function runBackend({ backend, model, instructions, cwd, inputFile, input }, environment = process.env, { timeoutMs = 600_000 } = {}) {
  const { command, args, stdin } = backendCommand({ backend, model, instructions, cwd, inputFile }, environment);
  const started = Date.now();
  const child = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input: stdin === null ? input : stdin,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...environment, NEMEDA_SLACK_RUNNER: "1" } // no kit hooks inside the child session
  });
  if (child.error) return { text: "", error: `${command} could not be started: ${child.error.message}`, ms: Date.now() - started };
  const { text, error } = parseBackendOutput(backend, child.stdout);
  if (!text) {
    const stderr = String(child.stderr || "").trim().split("\n").slice(-3).join(" ");
    return { text: "", error: error || stderr || `${command} returned no answer.`, ms: Date.now() - started };
  }
  return { text, error: null, ms: Date.now() - started };
}
