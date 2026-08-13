import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const ENV_LOCAL_NAME = ".env.local";

// Same behaviour as the workspace hooks this replaces: the file never
// overrides variables already exported in the shell.
export function loadEnvLocal(root, environment = process.env) {
  const envPath = path.join(root, ENV_LOCAL_NAME);
  if (!existsSync(envPath)) return {};
  const loaded = {};
  for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim().replace(/^export\s+/, "");
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    loaded[key] = value;
    if (environment[key] === undefined) environment[key] = value;
  }
  return loaded;
}

export function flagEnabled(name, environment = process.env) {
  return ["true", "1", "yes"].includes(String(environment[name] || "").toLowerCase());
}
