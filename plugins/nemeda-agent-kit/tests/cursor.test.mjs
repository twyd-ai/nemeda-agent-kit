import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CURSOR_MCP_RELATIVE, CURSOR_RULE_RELATIVE, cursorMcpConfig, cursorRuleContent, listPluginSkills, setupCursor } from "../scripts/lib/cursor.mjs";

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), "nemeda-cursor-"));
}

const config = { project: { id: "demo", name: "Demo" } };

test("setupCursor generates mcp, rule, and one command shim per kit skill", () => {
  const root = makeRoot();
  const result = setupCursor(root, config);
  const mcp = JSON.parse(readFileSync(path.join(root, CURSOR_MCP_RELATIVE), "utf8"));
  assert.equal(mcp.mcpServers["workspace-context"].env.NEMEDA_WORKSPACE_CWD, root);
  assert.ok(mcp.mcpServers["workspace-context"].args[0].endsWith("mcp-server.mjs"));
  const rule = readFileSync(path.join(root, CURSOR_RULE_RELATIVE), "utf8");
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /workspace_context/);
  for (const skill of listPluginSkills()) {
    const shim = readFileSync(path.join(root, ".cursor", "commands", `${skill.name}.md`), "utf8");
    assert.ok(shim.includes(skill.skillPath), skill.name);
  }
  assert.ok(result.ignores.includes(".cursor/mcp.json"));
  assert.ok(result.ignores.some((entry) => entry.startsWith(".cursor/commands")));
});

test("setupCursor never overwrites what exists", () => {
  const root = makeRoot();
  mkdirSync(path.join(root, ".cursor"), { recursive: true });
  writeFileSync(path.join(root, CURSOR_MCP_RELATIVE), "{\"mcpServers\":{}}\n");
  const result = setupCursor(root, config);
  assert.equal(readFileSync(path.join(root, CURSOR_MCP_RELATIVE), "utf8"), "{\"mcpServers\":{}}\n");
  assert.ok(result.actions.some((entry) => entry.status === "kept" && entry.message.includes("mcp.json")));
});

test("setupCursor skips command shims when .cursor/commands is a Drive link", () => {
  const root = makeRoot();
  const linked = { ...config, drive: { sharedDrive: "X", links: { ".cursor/commands": "commands", docs: "docs" } } };
  const result = setupCursor(root, linked);
  assert.ok(!existsSync(path.join(root, ".cursor", "commands", "workspace-doctor.md")));
  assert.ok(!result.ignores.some((entry) => entry.startsWith(".cursor/commands")));
});

test("dry run plans without writing", () => {
  const root = makeRoot();
  const result = setupCursor(root, config, { dryRun: true });
  assert.ok(!existsSync(path.join(root, ".cursor")));
  assert.ok(result.actions.every((entry) => entry.status === "planned"));
});

test("the rule content names the project and stays MDC-parseable", () => {
  const rule = cursorRuleContent({ project: { name: "Acme" } });
  assert.ok(rule.startsWith("---\n"));
  assert.match(rule, /Acme/);
  const mcp = cursorMcpConfig("/tmp/x", "/plugin");
  assert.equal(mcp.mcpServers["workspace-context"].args[0], path.join("/plugin", "scripts", "mcp-server.mjs"));
});
