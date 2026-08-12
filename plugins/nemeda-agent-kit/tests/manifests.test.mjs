import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  assert.equal(portable.name, "nemeda-agent-kit");
  assert.equal(codex.name, portable.name);
  assert.equal(claude.name, portable.name);
  assert.equal(codex.version, portable.version);
  assert.equal(claude.version, portable.version);
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
