// Cursor adapter. Cursor has no plugin system, but it reads AGENTS.md
// natively, loads project rules from .cursor/rules/*.mdc, project commands
// from .cursor/commands/*.md (plain markdown prompts, same format as Claude
// commands), and MCP servers from .cursor/mcp.json (same shape as .mcp.json).
//
// So the adapter is generated, machine-local assembly — like the Drive
// symlinks, not like the committed Codex/Claude manifests: paths inside it are
// absolute to this machine's plugin checkout, each teammate generates their
// own with `nemeda-agent cursor init` (or plain `setup`, which runs it when
// Cursor is installed), and every generated path is gitignored.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const CURSOR_RULE_RELATIVE = path.join(".cursor", "rules", "nemeda-agent-kit.mdc");
export const CURSOR_MCP_RELATIVE = path.join(".cursor", "mcp.json");

export function cursorMcpConfig(root, pluginRoot = PLUGIN_ROOT) {
  return {
    mcpServers: {
      "workspace-context": {
        command: process.execPath,
        args: [path.join(pluginRoot, "scripts", "mcp-server.mjs")],
        env: { NEMEDA_WORKSPACE_CWD: root }
      }
    }
  };
}

// The rule stays deliberately small: live context comes from the MCP server
// and AGENTS.md (which Cursor reads natively), so the rule cannot go stale —
// it only tells Cursor where the truth lives.
export function cursorRuleContent(config) {
  const name = config?.project?.name || "this project";
  return `---
description: Nemeda Agent Kit workspace context for ${name}
alwaysApply: true
---

This repository is a Nemeda Agent Kit workspace.

- At the start of a session, call the \`workspace_context\` tool of the
  \`workspace-context\` MCP server: it returns the project identity, repository
  roles, tool requirements, the shared-drive filing map, and the project
  instructions. Treat that context as authoritative.
- \`AGENTS.md\` holds the durable project rules; follow it.
- Shared documents live behind the Drive symlinks (\`docs/\`, \`config/\`).
  File new documents into the declared docs taxonomy; never leave files loose
  at the drive root.
- \`nemeda-agent doctor\` diagnoses this workspace when something is missing.
`;
}

export function listPluginSkills(pluginRoot = PLUGIN_ROOT) {
  const skillsDirectory = path.join(pluginRoot, "skills");
  if (!existsSync(skillsDirectory)) return [];
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(skillsDirectory, entry.name, "SKILL.md")))
    .map((entry) => ({ name: entry.name, skillPath: path.join(skillsDirectory, entry.name, "SKILL.md") }));
}

// Command shims reference the plugin's SKILL.md instead of copying it, so the
// methodology has one source and the shims never fork it.
export function cursorCommandContent(skill) {
  return `Read the file \`${skill.skillPath}\` and follow its instructions for this repository. It is a Nemeda Agent Kit skill; the workspace context is available through the \`workspace-context\` MCP server.
`;
}

export function setupCursor(root, config, { dryRun = false, pluginRoot = PLUGIN_ROOT } = {}) {
  const actions = [];
  const action = (status, message) => actions.push({ kind: "cursor", status, message });
  const writes = [];

  const mcpPath = path.join(root, CURSOR_MCP_RELATIVE);
  if (!existsSync(mcpPath)) {
    writes.push({ file: mcpPath, content: `${JSON.stringify(cursorMcpConfig(root, pluginRoot), null, 2)}\n`, label: CURSOR_MCP_RELATIVE });
  } else {
    action("kept", `${CURSOR_MCP_RELATIVE} already exists.`);
  }

  const rulePath = path.join(root, CURSOR_RULE_RELATIVE);
  if (!existsSync(rulePath)) {
    writes.push({ file: rulePath, content: cursorRuleContent(config), label: CURSOR_RULE_RELATIVE });
  } else {
    action("kept", `${CURSOR_RULE_RELATIVE} already exists.`);
  }

  // Do not shadow a Drive-linked commands folder: when .cursor/commands is a
  // declared drive link the shared folder wins and the shims are skipped.
  const commandsLinked = Object.keys(config?.drive?.links || {}).some(
    (linkPath) => path.normalize(linkPath) === path.join(".cursor", "commands")
  );
  const shims = [];
  if (!commandsLinked) {
    for (const skill of listPluginSkills(pluginRoot)) {
      const shimPath = path.join(root, ".cursor", "commands", `${skill.name}.md`);
      if (existsSync(shimPath)) continue;
      writes.push({ file: shimPath, content: cursorCommandContent(skill), label: path.join(".cursor", "commands", `${skill.name}.md`) });
      shims.push(skill.name);
    }
  }

  for (const write of writes) {
    if (dryRun) {
      action("planned", `write ${write.label}`);
      continue;
    }
    mkdirSync(path.dirname(write.file), { recursive: true });
    writeFileSync(write.file, write.content);
    action("created", write.label);
  }
  if (!dryRun && shims.length) action("ok", `Skill commands available in Cursor as /${shims.join(", /")}.`);

  // Everything generated here is machine-local (absolute paths inside).
  const ignores = [CURSOR_MCP_RELATIVE, CURSOR_RULE_RELATIVE, ...(commandsLinked ? [] : [path.join(".cursor", "commands") + path.sep])].map((entry) =>
    entry.split(path.sep).join("/")
  );
  return { actions, ignores };
}
