// `nemeda-agent meeting setup` — installs what this machine's role needs,
// downloads the recommended whisper model, and records the choices in
// .env.local. Nothing runs without confirmation: `planMeetingSetup` returns
// the steps, the CLI shows them and asks, `runMeetingSetup` executes.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { ENV_LOCAL_NAME } from "./env.mjs";
import { MODEL_TIERS, installCommands, modelDownloadUrl, modelsDirectory, probeHost, selectEngine } from "./meetings-core.mjs";
import { resolveMeetingHost } from "./meetings-doctor.mjs";

function action(kind, status, message, extra = {}) {
  return { kind, status, message, ...extra };
}

export function planMeetingSetup(root, environment = process.env, options = {}) {
  const resolved = resolveMeetingHost(root, environment, { explicitEngine: options.engine || null, allowUninstalled: true, probe: options.probe });
  const { host, selection, tier, model } = resolved;
  const engineName = selection.engine.name;
  const steps = installCommands(host, { obs: Boolean(options.obs), engineName });
  const wantsModel = selection.engine.needsModel;
  const requestedTier = options.model || null;
  if (requestedTier && !MODEL_TIERS[requestedTier]) {
    throw new Error(`Unknown model tier "${requestedTier}"; use one of ${Object.keys(MODEL_TIERS).join(", ")}.`);
  }
  let download = null;
  if (wantsModel) {
    const targetTier = requestedTier || tier.tier;
    if (targetTier && (!model || requestedTier)) {
      const file = path.join(options.modelsDirectory || modelsDirectory(resolved.environment), MODEL_TIERS[targetTier].file);
      if (!existsSync(file)) download = { tier: targetTier, url: modelDownloadUrl(targetTier), file, downloadMB: MODEL_TIERS[targetTier].downloadMB };
    }
  }
  const envLines = [];
  const envContent = existsSync(path.join(root, ENV_LOCAL_NAME)) ? readFileSync(path.join(root, ENV_LOCAL_NAME), "utf8") : "";
  const hasKey = (key) => new RegExp(`^${key}=`, "m").test(envContent);
  if (!hasKey("NEMEDA_MEETINGS_ENGINE")) envLines.push(`NEMEDA_MEETINGS_ENGINE=${engineName}`);
  const modelPath = download ? download.file : model;
  if (wantsModel && modelPath && !hasKey("NEMEDA_WHISPER_MODEL")) envLines.push(`NEMEDA_WHISPER_MODEL=${modelPath}`);
  return {
    root,
    host,
    engine: engineName,
    engineReason: selection.reason,
    tier: tier.tier,
    tierReason: tier.reason,
    steps,
    download,
    envLines,
    nothingToDo: steps.length === 0 && !download && envLines.length === 0
  };
}

function runCommand(command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", ...options });
  if (result.error) throw new Error(`${command[0]}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command.join(" ")} exited with status ${result.status}`);
}

export function downloadModel(download, { curl = "curl" } = {}) {
  mkdirSync(path.dirname(download.file), { recursive: true });
  const part = `${download.file}.part`;
  rmSync(part, { force: true });
  runCommand([curl, "-L", "--fail", "--progress-bar", "-o", part, download.url]);
  renameSync(part, download.file);
}

export function runMeetingSetup(plan, { dryRun = false, curl = "curl", execute = runCommand, fetchModel = downloadModel } = {}) {
  const actions = [];
  for (const step of plan.steps) {
    if (!step.run) {
      actions.push(action(step.kind, "manual", step.message));
      continue;
    }
    if (dryRun) {
      actions.push(action(step.kind, "planned", `${step.message} (${step.command.join(" ")})`));
      continue;
    }
    try {
      execute(step.command);
      actions.push(action(step.kind, "created", `${step.message} (${step.command.join(" ")})`));
    } catch (error) {
      actions.push(action(step.kind, "error", error instanceof Error ? error.message : String(error)));
      return { root: plan.root, dryRun, actions };
    }
  }
  if (plan.download) {
    if (dryRun) {
      actions.push(action("model", "planned", `download ${plan.download.tier} (${plan.download.downloadMB} MB) to ${plan.download.file}`));
    } else {
      try {
        fetchModel(plan.download, { curl });
        actions.push(action("model", "created", `Downloaded ${plan.download.tier} to ${plan.download.file}.`));
      } catch (error) {
        actions.push(action("model", "error", `Model download failed: ${error instanceof Error ? error.message : String(error)}`));
        return { root: plan.root, dryRun, actions };
      }
    }
  }
  if (plan.envLines.length) {
    const envPath = path.join(plan.root, ENV_LOCAL_NAME);
    if (dryRun) {
      actions.push(action("env", "planned", `append to ${ENV_LOCAL_NAME}: ${plan.envLines.join(", ")}`));
    } else {
      const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
      appendFileSync(envPath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${existing.includes("# Meeting capture") ? "" : "\n# Meeting capture (machine-local; written by `nemeda-agent meeting setup`)\n"}${plan.envLines.join("\n")}\n`);
      actions.push(action("env", "created", `Added to ${ENV_LOCAL_NAME}: ${plan.envLines.join(", ")}.`));
    }
  }
  if (actions.length === 0) actions.push(action("setup", "kept", "Nothing to install; this machine is ready."));
  return { root: plan.root, dryRun, actions };
}

// Exposed for the CLI's summary line before asking for confirmation.
export function describePlan(plan) {
  const lines = [`Engine: ${plan.engine} (${plan.engineReason}).`];
  if (plan.engine !== "apple-speech") lines.push(plan.tier ? `Recommended whisper model: ${plan.tier} (${plan.tierReason})` : `Whisper model: none recommended; ${plan.tierReason}`);
  for (const step of plan.steps) lines.push(step.run ? `  run: ${step.command.join(" ")}` : `  manual: ${step.message}`);
  if (plan.download) lines.push(`  download: ${plan.download.tier} (${plan.download.downloadMB} MB) -> ${plan.download.file}`);
  for (const line of plan.envLines) lines.push(`  ${ENV_LOCAL_NAME}: ${line}`);
  return lines;
}

export { probeHost, selectEngine };
