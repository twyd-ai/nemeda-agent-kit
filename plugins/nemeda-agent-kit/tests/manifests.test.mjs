import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateConfig } from "../scripts/lib/workspace.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test("portable and host manifests share the same identity", () => {
  const portable = readJson(path.join(pluginRoot, "plugin.json"));
  const codex = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  const claude = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
  const packageManifest = readJson(path.join(pluginRoot, "package.json"));
  const claudeMarketplace = readJson(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"));

  assert.equal(portable.name, "nemeda-agent-kit");
  assert.equal(codex.name, portable.name);
  assert.equal(claude.name, portable.name);
  assert.equal(codex.version, portable.version);
  assert.equal(claude.version, portable.version);
  assert.equal(packageManifest.version, portable.version);
  assert.equal(claudeMarketplace.plugins[0].version, portable.version);
});

test("host manifests declare hooks only where the host requires them", () => {
  const codex = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  const claude = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"));

  assert.equal(codex.hooks, "./hooks/hooks.json");
  assert.equal(claude.hooks, undefined, "Claude auto-loads hooks/hooks.json and must not declare it twice");
});

test("marketplaces resolve to the same plugin directory", () => {
  const codex = readJson(path.join(repositoryRoot, ".agents", "plugins", "marketplace.json"));
  const claude = readJson(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"));

  assert.equal(codex.plugins[0].source.path, "./plugins/nemeda-agent-kit");
  assert.equal(claude.plugins[0].source, "./plugins/nemeda-agent-kit");
});

test("configuration schema enforces exclusive repository modes", () => {
  const schema = readJson(path.join(pluginRoot, "schemas", "agent-kit.schema.json"));

  assert.equal(Array.isArray(schema.oneOf), true);
  assert.equal(schema.anyOf, undefined);
  assert.deepEqual(schema.$defs.workspaceRepository.required, ["id", "path", "role", "profiles"]);
  assert.equal(schema.$defs.workspaceRepository.additionalProperties, false);
});

// Every path a host resolves at runtime must exist relative to the plugin
// root, whether written as ./relative or through a ${…_PLUGIN_ROOT} variable.
// A broken reference here means a host silently loses tools or hooks.
test("manifest and hook references point at existing files", () => {
  const manifestPaths = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/mcp.json",
    ".mcp.json",
    "mcp.json",
    "hooks/hooks.json"
  ];
  const referencePattern = /"(?:\.\/|\$\{[A-Z_]*PLUGIN_ROOT\}\/)([^"\\\s]+?)\\?"|\$\{[A-Z_]*PLUGIN_ROOT\}\/([^"\\\s]+?\.mjs)/g;
  for (const manifestPath of manifestPaths) {
    const raw = readFileSync(path.join(pluginRoot, manifestPath), "utf8");
    for (const match of raw.matchAll(referencePattern)) {
      const reference = (match[1] || match[2]).replace(/\/$/, "");
      assert.equal(existsSync(path.join(pluginRoot, reference)), true, `${manifestPath} references missing ${reference}`);
    }
    assert.equal(raw.includes('"cwd"'), false, `${manifestPath} must not pin a cwd; the server resolves the workspace itself`);
  }
});

test("dogfood and sanitized example configurations pass runtime validation", () => {
  const configurations = [
    path.join(repositoryRoot, ".nemeda", "agent-kit.json"),
    path.join(repositoryRoot, "examples", "milence-agent-kit.json"),
    path.join(repositoryRoot, "examples", "scharlab-agent-kit.json")
  ];

  for (const configuration of configurations) {
    assert.deepEqual(validateConfig(readJson(configuration)), [], configuration);
  }
});
